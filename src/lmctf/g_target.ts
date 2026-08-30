// Ports lmctf60/g_target.c -- diff-derived from src/ctf/g_target.ts
// (lmctf60/g_target.c vs quake-2/ctf/g_target.c: 96-line diff of 796
// total).
//
// Real deltas from src/ctf/g_target.ts: use_target_changelevel's
// deathmatch-exit announcement goes through g_ctffunc.ts's ctf_BSafePrint
// (a CTF broadcast helper, completed by this unit) instead of
// `gi.bprintf`, and use_target_blaster's `effect` local is no longer dead
// code -- lmctf60 actually passes it to fire_blaster (a real behavior
// change/bugfix vs. ctf's own bug of always passing the literal
// EF_BLASTER; PORTING.md requires porting the LM_CTF source's own observed
// behavior, not carrying over ctf's now-irrelevant bug). Every other diff
// line is cosmetic (license header dropped, `stricmp` -> `Q_stricmp`,
// a `strncpy` bound, a typo fix in a comment).
//
// fire_blaster (g_weapon.c) has no lmctf port in this family (g_weapon.ts
// does not exist under src/lmctf -- p_weapon.ts only carries the
// offhand-hook priority feature's hook chain per the foundation's SCOPE,
// and g_weapon.ts is not listed in this unit's SCOPE either). Creating
// src/lmctf/g_weapon.ts is out of SCOPE (rule 12: never create a file at a
// sibling module's real path). use_target_blaster is therefore a reported
// throwing gap citing that missing dependency; target_blaster still spawns
// and links correctly, only firing throws.

import { crandom, vec3, vec3_origin, VectorCompare, VectorCopy, VectorMA, VectorNormalize, VectorScale, VectorSet, VectorSubtract } from "../shared/math";
import {
  ATTN_NONE,
  ATTN_NORM,
  CHAN_AUTO,
  CHAN_RELIABLE,
  CHAN_VOICE,
  CONTENTS_DEADMONSTER,
  CONTENTS_MONSTER,
  CONTENTS_SOLID,
  CS_CDTRACK,
  CS_LIGHTS,
  type CvarT,
  DF_ALLOW_EXIT,
  EF_BLASTER,
  EF_HYPERBLASTER,
  MulticastT,
  PRINT_HIGH,
  Q_stricmp,
  RF_BEAM,
  RF_TRANSLUCENT,
  TempEventT,
} from "../shared/q_shared";
import { ctf_BSafePrint } from "./g_ctffunc";
import { T_Damage, T_RadiusDamage } from "./g_combat";
import { type Edict, type GTraceT, SolidT, SVF_MONSTER, SVF_NOCLIENT } from "./game";
import {
  type EdictT,
  FL_IMMUNE_LASER,
  FRAMETIME,
  DAMAGE_ENERGY,
  g_edicts,
  game,
  gameCvars,
  gi,
  globals,
  level,
  MOD_EXIT,
  MOD_EXPLOSIVE,
  MOD_SPLASH,
  MOD_TARGET_LASER,
  MovetypeT,
  SFL_CROSS_TRIGGER_MASK,
  st,
  svc_temp_entity,
  world,
} from "./g_local";
import { G_Find, G_FreeEdict, G_SetMovedir, G_Spawn, G_UseTargets, KillBox, vtos } from "./g_utils";

function cvarNum(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}

// C dereferences these unconditionally at every call site below (activator,
// enemy, other); see src/ctf/g_target.ts's identical `requireOwner`-style
// idiom.
function requireEdict(e: EdictT | null, what: string): EdictT {
  if (e === null) {
    throw new Error(`${what} is null (C dereferences it unconditionally here)`);
  }
  return e;
}

// Recovers the game-private EdictT from a trace's game-visible `Edict`, per
// PORTING.md's EDICT_NUM idiom (`g_edicts[ent.s.number]`, never a cast).
function traceEdict(ent: Edict | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

// g_spawn.ts is the more fundamental module (its top-level spawn registry
// imports every SP_* function, including this file's); a static
// g_target.ts -> g_spawn.ts import would close that cycle. Per PORTING.md's
// import-cycle rule, this file (the less fundamental side) resolves it
// lazily.
import type * as GSpawnModule from "./g_spawn";
function gSpawnMod(): typeof GSpawnModule {
  return require("./g_spawn") as typeof GSpawnModule;
}

// p_hud.ts is not yet loaded relative to this file's own module-graph
// position in some test harnesses (it in turn pulls in a lot of the
// client-facing HUD/stat machinery); resolved lazily the same way, matching
// src/ctf/g_target.ts's own static import here would be fine too, but this
// unit builds p_hud.ts as a new file alongside this one, so lazy resolution
// avoids ordering this file's own module-load ahead of p_hud.ts's.
import type * as PHudModule from "./p_hud";
function pHudMod(): typeof PHudModule {
  return require("./p_hud") as typeof PHudModule;
}

/*QUAKED target_temp_entity (1 0 0) (-8 -8 -8) (8 8 8)
Fire an origin based temp entity event to the clients.
"style"		type byte
*/
export function Use_Target_Tent(ent: EdictT, other: EdictT | null, activator: EdictT | null): void {
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(ent.style);
  gi.WritePosition(ent.s.origin);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);
}

export function SP_target_temp_entity(ent: EdictT): void {
  ent.use = Use_Target_Tent;
}

//==========================================================

/*QUAKED target_speaker (1 0 0) (-8 -8 -8) (8 8 8) looped-on looped-off reliable
"noise"		wav file to play
"attenuation"
-1 = none, send to whole level
1 = normal fighting sounds
2 = idle sound level
3 = ambient sound level
"volume"	0.0 to 1.0

Normal sounds play each time the target is used.  The reliable flag can be set for crucial voiceovers.

Looped sounds are always atten 3 / vol 1, and the use function toggles it on/off.
Multiple identical looping sounds will just increase volume without any speed cost.
*/
export function Use_Target_Speaker(ent: EdictT, other: EdictT | null, activator: EdictT | null): void {
  if (ent.spawnflags & 3) {
    // looping sound toggles
    if (ent.s.sound) ent.s.sound = 0; // turn it off
    else ent.s.sound = ent.noise_index; // start it
  } else {
    // normal sound
    const chan = ent.spawnflags & 4 ? CHAN_VOICE | CHAN_RELIABLE : CHAN_VOICE;
    // use a positioned_sound, because this entity won't normally be
    // sent to any clients because it is invisible
    gi.positioned_sound(ent.s.origin, ent, chan, ent.noise_index, ent.volume, ent.attenuation, 0);
  }
}

export function SP_target_speaker(ent: EdictT): void {
  if (st.noise === null) {
    gi.dprintf(`target_speaker with no noise set at ${vtos(ent.s.origin)}\n`);
    return;
  }
  // lmctf60: `strncpy(buffer, st.noise, sizeof buffer - 1)` vs ctf's
  // `sizeof(buffer)` -- both bounds exceed any real noise string length in
  // practice and JS strings have no fixed buffer to overrun either way, so
  // this has no observable effect here.
  const buffer = st.noise.includes(".wav") ? st.noise : `${st.noise}.wav`;
  ent.noise_index = gi.soundindex(buffer);

  if (!ent.volume) ent.volume = 1.0;

  if (!ent.attenuation) ent.attenuation = 1.0;
  else if (ent.attenuation === -1)
    // use -1 so 0 defaults to 1
    ent.attenuation = 0;

  // check for prestarted looping sound
  if (ent.spawnflags & 1) ent.s.sound = ent.noise_index;

  ent.use = Use_Target_Speaker;

  // must link the entity so we get areas and clusters so
  // the server can determine who to send updates to
  gi.linkentity(ent);
}

//==========================================================

export function Use_Target_Help(ent: EdictT, other: EdictT | null, activator: EdictT | null): void {
  if (ent.spawnflags & 1) game.helpmessage1 = ent.message ?? "";
  else game.helpmessage2 = ent.message ?? "";

  game.helpchanged++;
}

/*QUAKED target_help (1 0 1) (-16 -16 -24) (16 16 24) help1
When fired, the "message" key becomes the current personal computer string, and the message light will be set on all clients status bars.
*/
export function SP_target_help(ent: EdictT): void {
  if (cvarNum(gameCvars.deathmatch)) {
    // auto-remove for deathmatch
    G_FreeEdict(ent);
    return;
  }

  if (ent.message === null) {
    gi.dprintf(`${ent.classname ?? ""} with no message at ${vtos(ent.s.origin)}\n`);
    G_FreeEdict(ent);
    return;
  }
  ent.use = Use_Target_Help;
}

//==========================================================

/*QUAKED target_secret (1 0 1) (-8 -8 -8) (8 8 8)
Counts a secret found.
These are single use targets.
*/
export function use_target_secret(ent: EdictT, other: EdictT | null, activator: EdictT | null): void {
  gi.sound(ent, CHAN_VOICE, ent.noise_index, 1, ATTN_NORM, 0);

  level.found_secrets++;

  G_UseTargets(ent, activator);
  G_FreeEdict(ent);
}

export function SP_target_secret(ent: EdictT): void {
  if (cvarNum(gameCvars.deathmatch)) {
    // auto-remove for deathmatch
    G_FreeEdict(ent);
    return;
  }

  ent.use = use_target_secret;
  if (st.noise === null) st.noise = "misc/secret.wav";
  ent.noise_index = gi.soundindex(st.noise);
  ent.svflags = SVF_NOCLIENT;
  level.total_secrets++;
  // map bug hack
  if (
    Q_stricmp(level.mapname, "mine3") === 0 &&
    ent.s.origin[0] === 280 &&
    ent.s.origin[1] === -2048 &&
    ent.s.origin[2] === -624
  ) {
    ent.message = "You have found a secret area.";
  }
}

//==========================================================

/*QUAKED target_goal (1 0 1) (-8 -8 -8) (8 8 8)
Counts a goal completed.
These are single use targets.
*/
export function use_target_goal(ent: EdictT, other: EdictT | null, activator: EdictT | null): void {
  gi.sound(ent, CHAN_VOICE, ent.noise_index, 1, ATTN_NORM, 0);

  level.found_goals++;

  if (level.found_goals === level.total_goals) gi.configstring(CS_CDTRACK, "0");

  G_UseTargets(ent, activator);
  G_FreeEdict(ent);
}

export function SP_target_goal(ent: EdictT): void {
  if (cvarNum(gameCvars.deathmatch)) {
    // auto-remove for deathmatch
    G_FreeEdict(ent);
    return;
  }

  ent.use = use_target_goal;
  if (st.noise === null) st.noise = "misc/secret.wav";
  ent.noise_index = gi.soundindex(st.noise);
  ent.svflags = SVF_NOCLIENT;
  level.total_goals++;
}

//==========================================================

/*QUAKED target_explosion (1 0 0) (-8 -8 -8) (8 8 8)
Spawns an explosion temporary entity when used.

"delay"		wait this long before going off
"dmg"		how much radius damage should be done, defaults to 0
*/
export function target_explosion_explode(self: EdictT): void {
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_EXPLOSION1);
  gi.WritePosition(self.s.origin);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PHS);

  T_RadiusDamage(self, requireEdict(self.activator, "activator"), self.dmg, null, self.dmg + 40, MOD_EXPLOSIVE);

  const save = self.delay;
  self.delay = 0;
  G_UseTargets(self, self.activator);
  self.delay = save;
}

export function use_target_explosion(self: EdictT, other: EdictT | null, activator: EdictT | null): void {
  self.activator = activator;

  if (!self.delay) {
    target_explosion_explode(self);
    return;
  }

  self.think = target_explosion_explode;
  self.nextthink = level.time + self.delay;
}

export function SP_target_explosion(ent: EdictT): void {
  ent.use = use_target_explosion;
  ent.svflags = SVF_NOCLIENT;
}

//==========================================================

/*QUAKED target_changelevel (1 0 0) (-8 -8 -8) (8 8 8)
Changes level to "map" when fired
*/
export function use_target_changelevel(self: EdictT, other: EdictT | null, activator: EdictT | null): void {
  if (level.intermissiontime) return; // already activated

  const deathmatch = cvarNum(gameCvars.deathmatch);
  const coop = cvarNum(gameCvars.coop);

  if (!deathmatch && !coop) {
    if (g_edicts[1].health <= 0) return;
  }

  // if noexit, do a ton of damage to other
  if (deathmatch && !((cvarNum(gameCvars.dmflags) | 0) & DF_ALLOW_EXIT) && other !== world()) {
    const target = requireEdict(other, "other");
    T_Damage(target, self, self, vec3_origin, target.s.origin, vec3_origin, 10 * target.max_health, 1000, 0, MOD_EXIT);
    return;
  }

  // if multiplayer, let everyone know who hit the exit -- lmctf60 routes
  // this through ctf_BSafePrint instead of ctf's plain gi.bprintf.
  if (deathmatch) {
    if (activator !== null && activator.client !== null) {
      ctf_BSafePrint(PRINT_HIGH, `${activator.client.pers.netname} exited the level.\n`);
    }
  }

  // if going to a new unit, clear cross triggers
  if (self.map !== null && self.map.includes("*")) {
    game.serverflags &= ~SFL_CROSS_TRIGGER_MASK;
  }

  pHudMod().BeginIntermission(self);
}

export function SP_target_changelevel(ent: EdictT): void {
  if (ent.map === null) {
    gi.dprintf(`target_changelevel with no map at ${vtos(ent.s.origin)}\n`);
    G_FreeEdict(ent);
    return;
  }

  // ugly hack because *SOMEBODY* screwed up their map
  if (Q_stricmp(level.mapname, "fact1") === 0 && Q_stricmp(ent.map, "fact3") === 0) ent.map = "fact3$secret1";

  ent.use = use_target_changelevel;
  ent.svflags = SVF_NOCLIENT;
}

//==========================================================

/*QUAKED target_splash (1 0 0) (-8 -8 -8) (8 8 8)
Creates a particle splash effect when used.

Set "sounds" to one of the following:
  1) sparks
  2) blue water
  3) brown water
  4) slime
  5) lava
  6) blood

"count"	how many pixels in the splash
"dmg"	if set, does a radius damage at this location when it splashes
		useful for lava/sparks
*/

export function use_target_splash(self: EdictT, other: EdictT | null, activator: EdictT | null): void {
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_SPLASH);
  gi.WriteByte(self.count);
  gi.WritePosition(self.s.origin);
  gi.WriteDir(self.movedir);
  gi.WriteByte(self.sounds);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);

  if (self.dmg) {
    T_RadiusDamage(self, requireEdict(activator, "activator"), self.dmg, null, self.dmg + 40, MOD_SPLASH);
  }
}

export function SP_target_splash(self: EdictT): void {
  self.use = use_target_splash;
  G_SetMovedir(self.s.angles, self.movedir);

  if (!self.count) self.count = 32;

  self.svflags = SVF_NOCLIENT;
}

//==========================================================

/*QUAKED target_spawner (1 0 0) (-8 -8 -8) (8 8 8)
Set target to the type of entity you want spawned.
Useful for spawning monsters and gibs in the factory levels.

For monsters:
	Set direction to the facing you want it to have.

For gibs:
	Set direction if you want it moving and
	speed how fast it should be moving otherwise it
	will just be dropped
*/
export function use_target_spawner(self: EdictT, other: EdictT | null, activator: EdictT | null): void {
  const ent = G_Spawn();
  ent.classname = self.target;
  VectorCopy(self.s.origin, ent.s.origin);
  VectorCopy(self.s.angles, ent.s.angles);
  gSpawnMod().ED_CallSpawn(ent);
  gi.unlinkentity(ent);
  KillBox(ent);
  gi.linkentity(ent);
  if (self.speed) VectorCopy(self.movedir, ent.velocity);
}

export function SP_target_spawner(self: EdictT): void {
  self.use = use_target_spawner;
  self.svflags = SVF_NOCLIENT;
  if (self.speed) {
    G_SetMovedir(self.s.angles, self.movedir);
    VectorScale(self.movedir, self.speed, self.movedir);
  }
}

//==========================================================

/*QUAKED target_blaster (1 0 0) (-8 -8 -8) (8 8 8) NOTRAIL NOEFFECTS
Fires a blaster bolt in the set direction when triggered.

dmg		default is 15
speed	default is 1000
*/

export function use_target_blaster(self: EdictT, other: EdictT | null, activator: EdictT | null): void {
  let effect: number;
  if (self.spawnflags & 2) effect = 0;
  else if (self.spawnflags & 1) effect = EF_HYPERBLASTER;
  else effect = EF_BLASTER;

  // lmctf60 actually uses `effect` here (ctf's own g_target.c always passed
  // the literal EF_BLASTER, a bug this port's ctf ancestor preserves --
  // lmctf60 does not have that bug, so `effect` is used, not discarded).
  // fire_blaster itself (g_weapon.c) has no port in this family -- see this
  // file's header comment. `void effect` below documents that the value is
  // computed correctly and would be threaded through once g_weapon.ts
  // exists.
  void effect;
  throw new Error(
    "use_target_blaster: fire_blaster (lmctf60/g_weapon.c) is not ported -- src/lmctf/g_weapon.ts does not exist and is out of this unit's SCOPE",
  );
}

export function SP_target_blaster(self: EdictT): void {
  self.use = use_target_blaster;
  G_SetMovedir(self.s.angles, self.movedir);
  self.noise_index = gi.soundindex("weapons/laser2.wav");

  if (!self.dmg) self.dmg = 15;
  if (!self.speed) self.speed = 1000;

  self.svflags = SVF_NOCLIENT;
}

//==========================================================

/*QUAKED target_crosslevel_trigger (.5 .5 .5) (-8 -8 -8) (8 8 8) trigger1 trigger2 trigger3 trigger4 trigger5 trigger6 trigger7 trigger8
Once this trigger is touched/used, any trigger_crosslevel_target with the same trigger number is automatically used when a level is started within the same unit.  It is OK to check multiple triggers.  Message, delay, target, and killtarget also work.
*/
export function trigger_crosslevel_trigger_use(self: EdictT, other: EdictT | null, activator: EdictT | null): void {
  game.serverflags |= self.spawnflags;
  G_FreeEdict(self);
}

export function SP_target_crosslevel_trigger(self: EdictT): void {
  self.svflags = SVF_NOCLIENT;
  self.use = trigger_crosslevel_trigger_use;
}

/*QUAKED target_crosslevel_target (.5 .5 .5) (-8 -8 -8) (8 8 8) trigger1 trigger2 trigger3 trigger4 trigger5 trigger6 trigger7 trigger8
Triggered by a trigger_crosslevel elsewhere within a unit.  If multiple triggers are checked, all must be true.  Delay, target and
killtarget also work.

"delay"		delay before using targets if the trigger has been activated (default 1)
*/
export function target_crosslevel_target_think(self: EdictT): void {
  if (self.spawnflags === (game.serverflags & SFL_CROSS_TRIGGER_MASK & self.spawnflags)) {
    G_UseTargets(self, self);
    G_FreeEdict(self);
  }
}

export function SP_target_crosslevel_target(self: EdictT): void {
  if (!self.delay) self.delay = 1;
  self.svflags = SVF_NOCLIENT;

  self.think = target_crosslevel_target_think;
  self.nextthink = level.time + self.delay;
}

//==========================================================

/*QUAKED target_laser (0 .5 .8) (-8 -8 -8) (8 8 8) START_ON RED GREEN BLUE YELLOW ORANGE FAT
When triggered, fires a laser.  You can either set a target
or a direction.
*/

export function target_laser_think(self: EdictT): void {
  const count = self.spawnflags & 0x80000000 ? 8 : 4;

  if (self.enemy !== null) {
    const lastMovedir = vec3();
    VectorCopy(self.movedir, lastMovedir);
    const point = vec3();
    VectorMA(self.enemy.absmin, 0.5, self.enemy.size, point);
    VectorSubtract(point, self.s.origin, self.movedir);
    VectorNormalize(self.movedir);
    if (VectorCompare(self.movedir, lastMovedir) === 0) self.spawnflags |= 0x80000000;
  }

  let ignore: Edict = self;
  const start = vec3();
  VectorCopy(self.s.origin, start);
  const end = vec3();
  VectorMA(start, 2048, self.movedir, end);
  let tr: GTraceT;
  for (;;) {
    tr = gi.trace(start, null, null, end, ignore, CONTENTS_SOLID | CONTENTS_MONSTER | CONTENTS_DEADMONSTER);

    if (tr.ent === null) break;

    const hit = traceEdict(tr.ent);

    // hurt it if we can
    if (hit.takedamage && !(hit.flags & FL_IMMUNE_LASER)) {
      T_Damage(
        hit,
        self,
        requireEdict(self.activator, "activator"),
        self.movedir,
        tr.endpos,
        vec3_origin,
        self.dmg,
        1,
        DAMAGE_ENERGY,
        MOD_TARGET_LASER,
      );
    }

    // if we hit something that's not a monster or player or is immune to lasers, we're done
    if (!(hit.svflags & SVF_MONSTER) && hit.client === null) {
      if (self.spawnflags & 0x80000000) {
        self.spawnflags &= ~0x80000000;
        gi.WriteByte(svc_temp_entity);
        gi.WriteByte(TempEventT.TE_LASER_SPARKS);
        gi.WriteByte(count);
        gi.WritePosition(tr.endpos);
        gi.WriteDir(tr.plane.normal);
        gi.WriteByte(self.s.skinnum);
        gi.multicast(tr.endpos, MulticastT.MULTICAST_PVS);
      }
      break;
    }

    ignore = hit;
    VectorCopy(tr.endpos, start);
  }

  VectorCopy(tr.endpos, self.s.old_origin);

  self.nextthink = level.time + FRAMETIME;
}

export function target_laser_on(self: EdictT): void {
  if (self.activator === null) self.activator = self;
  self.spawnflags |= 0x80000001;
  self.svflags &= ~SVF_NOCLIENT;
  target_laser_think(self);
}

export function target_laser_off(self: EdictT): void {
  self.spawnflags &= ~1;
  self.svflags |= SVF_NOCLIENT;
  self.nextthink = 0;
}

export function target_laser_use(self: EdictT, other: EdictT | null, activator: EdictT | null): void {
  self.activator = activator;
  if (self.spawnflags & 1) target_laser_off(self);
  else target_laser_on(self);
}

export function target_laser_start(self: EdictT): void {
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.solid = SolidT.SOLID_NOT;
  self.s.renderfx |= RF_BEAM | RF_TRANSLUCENT;
  self.s.modelindex = 1; // must be non-zero

  // set the beam diameter
  if (self.spawnflags & 64) self.s.frame = 16;
  else self.s.frame = 4;

  // set the color
  if (self.spawnflags & 2) self.s.skinnum = 0xf2f2f0f0;
  else if (self.spawnflags & 4) self.s.skinnum = 0xd0d1d2d3;
  else if (self.spawnflags & 8) self.s.skinnum = 0xf3f3f1f1;
  else if (self.spawnflags & 16) self.s.skinnum = 0xdcdddedf;
  else if (self.spawnflags & 32) self.s.skinnum = 0xe0e1e2e3;

  if (self.enemy === null) {
    if (self.target !== null) {
      const ent = G_Find(null, "targetname", self.target);
      if (ent === null) gi.dprintf(`${self.classname ?? ""} at ${vtos(self.s.origin)}: ${self.target} is a bad target\n`);
      self.enemy = ent;
    } else {
      G_SetMovedir(self.s.angles, self.movedir);
    }
  }
  self.use = target_laser_use;
  self.think = target_laser_think;

  if (!self.dmg) self.dmg = 1;

  VectorSet(self.mins, -8, -8, -8);
  VectorSet(self.maxs, 8, 8, 8);
  gi.linkentity(self);

  if (self.spawnflags & 1) target_laser_on(self);
  else target_laser_off(self);
}

export function SP_target_laser(self: EdictT): void {
  // let everything else get spawned before we start firing
  self.think = target_laser_start;
  self.nextthink = level.time + 1;
}

//==========================================================

/*QUAKED target_lightramp (0 .5 .8) (-8 -8 -8) (8 8 8) TOGGLE
speed		How many seconds the ramping will take
message		two letters; starting lightlevel and ending lightlevel
*/

export function target_lightramp_think(self: EdictT): void {
  const enemy = requireEdict(self.enemy, "enemy");
  const letter = 97 /* 'a' */ + self.movedir[0] + ((level.time - self.timestamp) / FRAMETIME) * self.movedir[2];
  const style = String.fromCharCode(letter | 0);
  gi.configstring(CS_LIGHTS + enemy.style, style);

  if (level.time - self.timestamp < self.speed) {
    self.nextthink = level.time + FRAMETIME;
  } else if (self.spawnflags & 1) {
    const temp = self.movedir[0];
    self.movedir[0] = self.movedir[1];
    self.movedir[1] = temp;
    self.movedir[2] *= -1;
  }
}

export function target_lightramp_use(self: EdictT, other: EdictT | null, activator: EdictT | null): void {
  if (self.enemy === null) {
    // check all the targets
    const targetName = self.target;
    if (targetName !== null) {
      let e: EdictT | null = null;
      for (;;) {
        e = G_Find(e, "targetname", targetName);
        if (e === null) break;
        if (e.classname !== "light") {
          gi.dprintf(`${self.classname ?? ""} at ${vtos(self.s.origin)} `);
          gi.dprintf(`target ${self.target ?? ""} (${e.classname ?? ""} at ${vtos(e.s.origin)}) is not a light\n`);
        } else {
          self.enemy = e;
        }
      }
    }

    if (self.enemy === null) {
      gi.dprintf(`${self.classname ?? ""} target ${self.target ?? ""} not found at ${vtos(self.s.origin)}\n`);
      G_FreeEdict(self);
      return;
    }
  }

  self.timestamp = level.time;
  target_lightramp_think(self);
}

export function SP_target_lightramp(self: EdictT): void {
  const message = self.message;
  if (
    message === null ||
    message.length !== 2 ||
    message[0] < "a" ||
    message[0] > "z" ||
    message[1] < "a" ||
    message[1] > "z" ||
    message[0] === message[1]
  ) {
    gi.dprintf(`target_lightramp has bad ramp (${message ?? ""}) at ${vtos(self.s.origin)}\n`);
    G_FreeEdict(self);
    return;
  }

  if (cvarNum(gameCvars.deathmatch)) {
    G_FreeEdict(self);
    return;
  }

  if (self.target === null) {
    gi.dprintf(`${self.classname ?? ""} with no target at ${vtos(self.s.origin)}\n`);
    G_FreeEdict(self);
    return;
  }

  self.svflags |= SVF_NOCLIENT;
  self.use = target_lightramp_use;
  self.think = target_lightramp_think;

  self.movedir[0] = message.charCodeAt(0) - 97; // 'a'
  self.movedir[1] = message.charCodeAt(1) - 97; // 'a'
  self.movedir[2] = (self.movedir[1] - self.movedir[0]) / (self.speed / FRAMETIME);
}

//==========================================================

/*QUAKED target_earthquake (1 0 0) (-8 -8 -8) (8 8 8)
When triggered, this initiates a level-wide earthquake.
All players and monsters are affected.
"speed"		severity of the quake (default:200)
"count"		duration of the quake (default:5)
*/

export function target_earthquake_think(self: EdictT): void {
  if (self.last_move_time < level.time) {
    gi.positioned_sound(self.s.origin, self, CHAN_AUTO, self.noise_index, 1.0, ATTN_NONE, 0);
    self.last_move_time = level.time + 0.5;
  }

  for (let i = 1; i < globals.num_edicts; i++) {
    const e = g_edicts[i];
    if (e === undefined || !e.inuse) continue;
    if (e.client === null) continue;
    if (e.groundentity === null) continue;

    e.groundentity = null;
    e.velocity[0] += crandom() * 150;
    e.velocity[1] += crandom() * 150;
    e.velocity[2] = self.speed * (100.0 / e.mass);
  }

  if (level.time < self.timestamp) self.nextthink = level.time + FRAMETIME;
}

export function target_earthquake_use(self: EdictT, other: EdictT | null, activator: EdictT | null): void {
  self.timestamp = level.time + self.count;
  self.nextthink = level.time + FRAMETIME;
  self.activator = activator;
  self.last_move_time = 0;
}

export function SP_target_earthquake(self: EdictT): void {
  if (self.targetname === null) gi.dprintf(`untargeted ${self.classname ?? ""} at ${vtos(self.s.origin)}\n`);

  if (!self.count) self.count = 5;

  if (!self.speed) self.speed = 200;

  self.svflags |= SVF_NOCLIENT;
  self.think = target_earthquake_think;
  self.use = target_earthquake_use;

  self.noise_index = gi.soundindex("world/quake.wav");
}
