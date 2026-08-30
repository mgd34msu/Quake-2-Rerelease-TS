// g_misc.c
//
// Ports lmctf60/g_misc.c -- diff-derived from src/ctf/g_misc.ts
// (lmctf60/g_misc.c vs quake-2/ctf/g_misc.c: ~454-line diff of 1977/1978
// total). Cosmetic-only hunks (license header dropped, `0.7`/`1.2` float
// literals gaining an `f` suffix, stray semicolons after function bodies,
// a typo fix in a comment, `int`/`size_t` retyping in target_string_use with
// no observable effect since `e->count` is always >= 1 here) are not called
// out individually below; every hunk with real behavioral effect is.
//
// Real deltas from src/ctf/g_misc.ts:
//
// 1. ThrowClientHead: when self.client is null (bodies already in the death
//    queue), lmctf60 explicitly clears self.think/self.nextthink instead of
//    leaving whatever the corpse had queued.
//
// 2. BecomeExplosion1/BecomeExplosion2: lmctf60 drops ctf's entire ZOID
//    block (CTFResetFlag/CTFRespawnTech/CTFTeamName special-casing for
//    flags and tech powerups -- IT_TECH itself is removed from
//    lmctf60/g_local.h, see src/lmctf/g_local.ts's own note) and instead
//    gates the whole explosion-and-free body on a new `dontfree` field: if
//    self.dontfree is set, both functions become no-ops. This means this
//    file needs no CTFResetFlag/CTFRespawnTech/CTFTeamName import and no
//    stub for them.
//
// 3. path_corner_touch: the TELEPORT-flag branch now also stamps
//    `other.s.event = EV_OTHER_TELEPORT` after relocating the toucher.
//
// 4. TH_viewthing: lmctf60 drops the dead `robotron[]`/spawnflags-cycling
//    branch entirely (the model index array was declared `static` and
//    never assigned in either source, so it always read back 0 -- lmctf60
//    just deletes the unreachable code instead of leaving it in place).
//
// 5. func_explosive_explode: lmctf60 (LM_JORM) comments out the
//    `VectorCopy(origin, self->s.origin)` and the post-debris
//    velocity-towards-inflictor block ("don't screw with self while
//    generating the debris" / "the ent needs to reappear") -- both are
//    genuinely dropped, not just displaced, so self.s.origin and
//    self.velocity are left untouched by this function now. At the end, a
//    new LM_JORM branch supports respawning explosive walls in deathmatch:
//    outside deathmatch the old dmg-gated BecomeExplosion1-or-free behavior
//    is unchanged; in deathmatch the entity instead goes non-solid/
//    no-client and reschedules `func_explosive_respawn` after self.speed
//    seconds.
//
// 6. func_explosive_respawn (new, LM_JORM): re-solidifies a respawning
//    func_explosive, clears its think, KillBoxes, and relinks.
//
// 7. SP_func_explosive: the deathmatch auto-remove block is commented out
//    and replaced by an unrelated-looking but literally-named LM_JORM
//    check -- "auto-remove for deathmatch" now actually fires whenever
//    self.speed is falsy (map author must set "speed" to opt in to
//    LM_JORM's respawn behavior; a func_explosive with no speed set is
//    silently removed on spawn, deathmatch or not). Also, the health
//    default now uses `self.health <= 0` instead of `!self.health` so a
//    negative health left over from a previous explosion (on respawn)
//    still gets reset to 100.
//
// 8. barrel_touch: still calls M_walkmove (g_monster.c's monster-movement
//    helper) unconditionally -- see the MONSTERS_OK note below for why
//    that throws here instead of being ported.
//
// 9. SP_misc_explobox: `self->think = M_droptofloor;` is now wrapped in
//    `#ifdef MONSTERS_OK`. src/lmctf/g_local.ts and g_combat.ts already
//    established (grep of lmctf60/Makefile) that MONSTERS_OK is never
//    defined for this build, so this assignment is genuinely dead code,
//    not merely unported -- SP_misc_explobox ports faithfully by leaving
//    self.think unset (it stays whatever G_Spawn zero-initializes it to)
//    while `self.nextthink = level.time + 2 * FRAMETIME` is still set
//    unconditionally, exactly matching lmctf60's own compiled behavior.
//    (SV_RunThink in src/game/g_phys.ts calls `gi.error("NULL ent->think")`
//    if nextthink is ever due with think still unset; that is lmctf60's own
//    real behavior for a misc_explobox with MONSTERS_OK undefined, not a
//    porting bug -- flagged here per FIDELITY RAZOR as a preserved-because-
//    identically-observable original defect, not something this unit
//    silently patched over.)
//
// 10. New misc_ctf_banner / misc_ctf_small_banner / info_position spawners
//     (LM_JORM, "COMPATIBILITY WITH ZOID'S BANNERS") -- these do not exist
//     in src/ctf/g_misc.ts or src/ctf/g_target.ts under these names (ctf's
//     own banner/position spawners live in g_ctf.c, out of this file's
//     scope entirely); ported fresh from lmctf60's own source, straight
//     decoration-entity spawners with no monster/CTF-subsystem dependency.
//
// 11. misc_viper_use / misc_strogg_ship_use / SP_misc_viper /
//     SP_misc_strogg_ship: pull func_train_find/train_use from
//     src/lmctf/g_func.ts (a plain static import both ways is the
//     established resolution for this mutual g_misc.c <-> g_func.c
//     dependency -- see src/lmctf/g_combat.ts <-> g_utils.ts precedent and
//     src/ctf/g_misc.ts's identical import of the same two names).
//
// 12. teleporter_touch: drops ctf's `CTFPlayerResetGrapple(other)` ZOID
//     call (lmctf60 has no grapple-reset step here at all -- consistent
//     with g_ctffunc.ts's documented omission of the grapple-reset family).
//
// 13. SP_misc_teleporter_dest: two new spawnflags -- bit 1 skips the
//     `gi.setmodel` call (no visible pad model), bit 2 skips making the
//     destination solid.
import {
  AngleVectors,
  crandom,
  random,
  type Vec3,
  vec3,
  vec3_origin,
  VectorAdd,
  VectorClear,
  VectorCopy,
  VectorMA,
  VectorNormalize,
  VectorScale,
  VectorSet,
  VectorSubtract,
} from "../shared/math";
import {
  ANGLE2SHORT,
  ATTN_NORM,
  CHAN_BODY,
  CHAN_VOICE,
  CHAN_AUTO,
  Com_sprintf,
  type CplaneT,
  type CsurfaceT,
  CS_LIGHTS,
  EF_ANIM_ALL,
  EF_ANIM_ALLFAST,
  EF_FLIES,
  EF_GIB,
  EF_ROCKET,
  EF_TELEPORTER,
  EntityEventT,
  MASK_MONSTERSOLID,
  MulticastT,
  PMF_TIME_TELEPORT,
  RF_FRAMELERP,
  RF_TRANSLUCENT,
  TempEventT,
} from "../shared/q_shared";
import { T_Damage, T_RadiusDamage } from "./g_combat";
import { SolidT, SVF_DEADMONSTER, SVF_MONSTER, SVF_NOCLIENT } from "./game";
import {
  AI_COMBAT_POINT,
  AI_GOOD_GUY,
  AI_NOSTEP,
  AI_STAND_GROUND,
  ANIM_DEATH,
  DamageT,
  DEAD_DEAD,
  type EdictT,
  FL_FLY,
  FL_GODMODE,
  FL_NO_KNOCKBACK,
  FL_SWIM,
  FRAMETIME,
  gameCvars,
  gameIndices,
  GIB_ORGANIC,
  gi,
  level,
  MOD_BARREL,
  MOD_BOMB,
  MOD_CRUSH,
  MOD_EXPLOSIVE,
  MovetypeT,
  svc_temp_entity,
} from "./g_local";
import { func_train_find, train_use } from "./g_func";
import { G_Find, G_FreeEdict, G_PickTarget, G_Spawn, G_UseTargets, KillBox, vectoangles, vectoyaw, vtos } from "./g_utils";

/*QUAKED func_group (0 0 0) ?
Used to group brushes together just for editor convenience.
*/

//=====================================================

function Use_Areaportal(ent: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  ent.count ^= 1; // toggle state
  //	gi.dprintf ("portalstate: %i = %i\n", ent->style, ent->count);
  gi.SetAreaPortalState(ent.style, ent.count !== 0);
}

/*QUAKED func_areaportal (0 0 0) ?

This is a non-visible object that divides the world into
areas that are seperated when this portal is not activated.
Usually enclosed in the middle of a door.
*/
export function SP_func_areaportal(ent: EdictT): void {
  ent.use = Use_Areaportal;
  ent.count = 0; // always start closed;
}

//=====================================================

/*
=================
Misc functions
=================
*/
function VelocityForDamage(damage: number, v: Vec3): void {
  v[0] = 100.0 * crandom();
  v[1] = 100.0 * crandom();
  v[2] = 200.0 + 100.0 * random();

  if (damage < 50) VectorScale(v, 0.7, v);
  else VectorScale(v, 1.2, v);
}

function ClipGibVelocity(ent: EdictT): void {
  if (ent.velocity[0] < -300) ent.velocity[0] = -300;
  else if (ent.velocity[0] > 300) ent.velocity[0] = 300;
  if (ent.velocity[1] < -300) ent.velocity[1] = -300;
  else if (ent.velocity[1] > 300) ent.velocity[1] = 300;
  if (ent.velocity[2] < 200) ent.velocity[2] = 200; // always some upwards
  else if (ent.velocity[2] > 500) ent.velocity[2] = 500;
}

/*
=================
gibs
=================
*/
function gib_think(self: EdictT): void {
  self.s.frame++;
  self.nextthink = level.time + FRAMETIME;

  if (self.s.frame === 10) {
    self.think = G_FreeEdict;
    self.nextthink = level.time + 8 + random() * 10;
  }
}

function gib_touch(self: EdictT, _other: EdictT, plane: CplaneT | null, _surf: CsurfaceT | null): void {
  const normal_angles = vec3();
  const right = vec3();

  if (!self.groundentity) return;

  self.touch = null;

  if (plane) {
    gi.sound(self, CHAN_VOICE, gi.soundindex("misc/fhit3.wav"), 1, ATTN_NORM, 0);

    vectoangles(plane.normal, normal_angles);
    AngleVectors(normal_angles, null, right, null);
    vectoangles(right, self.s.angles);

    if (self.s.modelindex === gameIndices.sm_meat_index) {
      self.s.frame++;
      self.think = gib_think;
      self.nextthink = level.time + FRAMETIME;
    }
  }
}

function gib_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3): void {
  G_FreeEdict(self);
}

export function ThrowGib(self: EdictT, gibname: string, damage: number, gibType: number): void {
  const gib = G_Spawn();

  const size = vec3();
  const origin = vec3();
  VectorScale(self.size, 0.5, size);
  VectorAdd(self.absmin, size, origin);
  gib.s.origin[0] = origin[0] + crandom() * size[0];
  gib.s.origin[1] = origin[1] + crandom() * size[1];
  gib.s.origin[2] = origin[2] + crandom() * size[2];

  gi.setmodel(gib, gibname);
  gib.solid = SolidT.SOLID_NOT;
  gib.s.effects |= EF_GIB;
  gib.flags |= FL_NO_KNOCKBACK;
  gib.takedamage = DamageT.DAMAGE_YES;
  gib.die = gib_die;

  let vscale: number;
  if (gibType === GIB_ORGANIC) {
    gib.movetype = MovetypeT.MOVETYPE_TOSS;
    gib.touch = gib_touch;
    vscale = 0.5;
  } else {
    gib.movetype = MovetypeT.MOVETYPE_BOUNCE;
    vscale = 1.0;
  }

  const vd = vec3();
  VelocityForDamage(damage, vd);
  VectorMA(self.velocity, vscale, vd, gib.velocity);
  ClipGibVelocity(gib);
  gib.avelocity[0] = random() * 600;
  gib.avelocity[1] = random() * 600;
  gib.avelocity[2] = random() * 600;

  gib.think = G_FreeEdict;
  gib.nextthink = level.time + 10 + random() * 10;

  gi.linkentity(gib);
}

export function ThrowHead(self: EdictT, gibname: string, damage: number, gibType: number): void {
  self.s.skinnum = 0;
  self.s.frame = 0;
  VectorClear(self.mins);
  VectorClear(self.maxs);

  self.s.modelindex2 = 0;
  gi.setmodel(self, gibname);
  self.solid = SolidT.SOLID_NOT;
  self.s.effects |= EF_GIB;
  self.s.effects &= ~EF_FLIES;
  self.s.sound = 0;
  self.flags |= FL_NO_KNOCKBACK;
  self.svflags &= ~SVF_MONSTER;
  self.takedamage = DamageT.DAMAGE_YES;
  self.die = gib_die;

  let vscale: number;
  if (gibType === GIB_ORGANIC) {
    self.movetype = MovetypeT.MOVETYPE_TOSS;
    self.touch = gib_touch;
    vscale = 0.5;
  } else {
    self.movetype = MovetypeT.MOVETYPE_BOUNCE;
    vscale = 1.0;
  }

  const vd = vec3();
  VelocityForDamage(damage, vd);
  VectorMA(self.velocity, vscale, vd, self.velocity);
  ClipGibVelocity(self);

  // self->avelocity[YAW] = crandom()*600; -- YAW is index 1
  self.avelocity[1] = crandom() * 600;

  self.think = G_FreeEdict;
  self.nextthink = level.time + 10 + random() * 10;

  gi.linkentity(self);
}

export function ThrowClientHead(self: EdictT, damage: number): void {
  let gibname: string;

  // C: `if (rand()&1)` -- a 50/50 draw; rand()/random() map to Math.random()
  // per PORTING.md, and g_items.ts/g_utils.ts already establish `rand() % N`
  // -> `Math.floor(Math.random() * N)` as the house style for raw rand().
  if ((Math.floor(Math.random() * 2) & 1) !== 0) {
    gibname = "models/objects/gibs/head2/tris.md2";
    self.s.skinnum = 1; // second skin is player
  } else {
    gibname = "models/objects/gibs/skull/tris.md2";
    self.s.skinnum = 0;
  }

  self.s.origin[2] += 32;
  self.s.frame = 0;
  gi.setmodel(self, gibname);
  VectorSet(self.mins, -16, -16, 0);
  VectorSet(self.maxs, 16, 16, 16);

  self.takedamage = DamageT.DAMAGE_NO;
  self.solid = SolidT.SOLID_NOT;
  self.s.effects = EF_GIB;
  self.s.sound = 0;
  self.flags |= FL_NO_KNOCKBACK;

  self.movetype = MovetypeT.MOVETYPE_BOUNCE;
  const vd = vec3();
  VelocityForDamage(damage, vd);
  VectorAdd(self.velocity, vd, self.velocity);

  if (self.client !== null) {
    // bodies in the queue don't have a client anymore
    self.client.anim_priority = ANIM_DEATH;
    self.client.anim_end = self.s.frame;
  } else {
    self.think = null;
    self.nextthink = 0;
  }

  gi.linkentity(self);
}

/*
=================
debris
=================
*/
function debris_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3): void {
  G_FreeEdict(self);
}

export function ThrowDebris(self: EdictT, modelname: string, speed: number, origin: Vec3): void {
  const chunk = G_Spawn();
  VectorCopy(origin, chunk.s.origin);
  gi.setmodel(chunk, modelname);
  const v = vec3();
  v[0] = 100 * crandom();
  v[1] = 100 * crandom();
  v[2] = 100 + 100 * crandom();
  VectorMA(self.velocity, speed, v, chunk.velocity);
  chunk.movetype = MovetypeT.MOVETYPE_BOUNCE;
  chunk.solid = SolidT.SOLID_NOT;
  chunk.avelocity[0] = random() * 600;
  chunk.avelocity[1] = random() * 600;
  chunk.avelocity[2] = random() * 600;
  chunk.think = G_FreeEdict;
  chunk.nextthink = level.time + 5 + random() * 5;
  chunk.s.frame = 0;
  chunk.flags = 0;
  chunk.classname = "debris";
  chunk.takedamage = DamageT.DAMAGE_YES;
  chunk.die = debris_die;
  gi.linkentity(chunk);
}

// lmctf60 drops ctf's ZOID flag/tech special-casing here entirely and gates
// the whole body on the new `dontfree` field instead -- see file header.
export function BecomeExplosion1(self: EdictT): void {
  if (!self.dontfree) {
    gi.WriteByte(svc_temp_entity);
    gi.WriteByte(TempEventT.TE_EXPLOSION1);
    gi.WritePosition(self.s.origin);
    gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);

    G_FreeEdict(self);
  }
}

export function BecomeExplosion2(self: EdictT): void {
  if (!self.dontfree) {
    gi.WriteByte(svc_temp_entity);
    gi.WriteByte(TempEventT.TE_EXPLOSION2);
    gi.WritePosition(self.s.origin);
    gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);

    G_FreeEdict(self);
  }
}

/*QUAKED path_corner (.5 .3 0) (-8 -8 -8) (8 8 8) TELEPORT
Target: next path corner
Pathtarget: gets used when an entity that has
	this path_corner targeted touches it
*/

function path_corner_touch(self: EdictT, other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  if (other.movetarget !== self) return;

  if (other.enemy) return;

  if (self.pathtarget) {
    const savetarget = self.target;
    self.target = self.pathtarget;
    G_UseTargets(self, other);
    self.target = savetarget;
  }

  let next: EdictT | null;
  if (self.target) next = G_PickTarget(self.target);
  else next = null;

  const v = vec3();
  if (next !== null && next.spawnflags & 1) {
    VectorCopy(next.s.origin, v);
    v[2] += next.mins[2];
    v[2] -= other.mins[2];
    VectorCopy(v, other.s.origin);
    next = G_PickTarget(next.target);
    other.s.event = EntityEventT.EV_OTHER_TELEPORT;
  }

  other.goalentity = other.movetarget = next;

  if (self.wait) {
    other.monsterinfo.pausetime = level.time + self.wait;
    if (other.monsterinfo.stand) other.monsterinfo.stand(other);
    return;
  }

  if (!other.movetarget) {
    other.monsterinfo.pausetime = level.time + 100000000;
    if (other.monsterinfo.stand) other.monsterinfo.stand(other);
  } else if (other.goalentity !== null) {
    // C dereferences other->goalentity->s.origin unconditionally here; it is
    // always non-null on this path because it was just set to the same
    // value as the (truthy, just-checked) other.movetarget above. The guard
    // is added only to satisfy strict null checking -- see src/ctf/g_misc.ts's
    // identical note at this spot.
    VectorSubtract(other.goalentity.s.origin, other.s.origin, v);
    other.ideal_yaw = vectoyaw(v);
  }
}

export function SP_path_corner(self: EdictT): void {
  if (!self.targetname) {
    gi.dprintf(`path_corner with no targetname at ${vtos(self.s.origin)}\n`);
    G_FreeEdict(self);
    return;
  }

  self.solid = SolidT.SOLID_TRIGGER;
  self.touch = path_corner_touch;
  VectorSet(self.mins, -8, -8, -8);
  VectorSet(self.maxs, 8, 8, 8);
  self.svflags |= SVF_NOCLIENT;
  gi.linkentity(self);
}

/*QUAKED point_combat (0.5 0.3 0) (-8 -8 -8) (8 8 8) Hold
Makes this the target of a monster and it will head here
when first activated before going after the activator.  If
hold is selected, it will stay here.
*/
function point_combat_touch(self: EdictT, other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  if (other.movetarget !== self) return;

  if (self.target) {
    other.target = self.target;
    other.goalentity = other.movetarget = G_PickTarget(other.target);
    if (!other.goalentity) {
      gi.dprintf(`${self.classname} at ${vtos(self.s.origin)} target ${self.target} does not exist\n`);
      other.movetarget = self;
    }
    self.target = null;
  } else if (self.spawnflags & 1 && !(other.flags & (FL_SWIM | FL_FLY))) {
    other.monsterinfo.pausetime = level.time + 100000000;
    other.monsterinfo.aiflags |= AI_STAND_GROUND;
    if (other.monsterinfo.stand) other.monsterinfo.stand(other);
  }

  if (other.movetarget === self) {
    other.target = null;
    other.movetarget = null;
    other.goalentity = other.enemy;
    other.monsterinfo.aiflags &= ~AI_COMBAT_POINT;
  }

  if (self.pathtarget) {
    const savetarget = self.target;
    self.target = self.pathtarget;

    let activator: EdictT;
    if (other.enemy !== null && other.enemy.client !== null) activator = other.enemy;
    else if (other.oldenemy !== null && other.oldenemy.client !== null) activator = other.oldenemy;
    else if (other.activator !== null && other.activator.client !== null) activator = other.activator;
    else activator = other;
    G_UseTargets(self, activator);
    self.target = savetarget;
  }
}

export function SP_point_combat(self: EdictT): void {
  const deathmatch = gameCvars.deathmatch === null ? 0 : gameCvars.deathmatch.value;
  if (deathmatch) {
    G_FreeEdict(self);
    return;
  }
  self.solid = SolidT.SOLID_TRIGGER;
  self.touch = point_combat_touch;
  VectorSet(self.mins, -8, -8, -16);
  VectorSet(self.maxs, 8, 8, 16);
  self.svflags = SVF_NOCLIENT;
  gi.linkentity(self);
}

/*QUAKED viewthing (0 .5 .8) (-8 -8 -8) (8 8 8)
Just for the debugging level.  Don't use
*/
// lmctf60 drops ctf's dead robotron[]/spawnflags-cycling branch entirely
// (the array was `static`, never assigned in either source, and always
// read back 0) -- see file header.
function TH_viewthing(ent: EdictT): void {
  ent.s.frame = (ent.s.frame + 1) % 7;
  ent.nextthink = level.time + FRAMETIME;
}

export function SP_viewthing(ent: EdictT): void {
  gi.dprintf("viewthing spawned\n");

  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_BBOX;
  ent.s.renderfx = RF_FRAMELERP;
  VectorSet(ent.mins, -16, -16, -24);
  VectorSet(ent.maxs, 16, 16, 32);
  ent.s.modelindex = gi.modelindex("models/objects/banner/tris.md2");
  gi.linkentity(ent);
  ent.nextthink = level.time + 0.5;
  ent.think = TH_viewthing;
}

/*QUAKED info_null (0 0.5 0) (-4 -4 -4) (4 4 4)
Used as a positional target for spotlights, etc.
*/
export function SP_info_null(self: EdictT): void {
  G_FreeEdict(self);
}

/*QUAKED info_notnull (0 0.5 0) (-4 -4 -4) (4 4 4)
Used as a positional target for lightning.
*/
export function SP_info_notnull(self: EdictT): void {
  VectorCopy(self.s.origin, self.absmin);
  VectorCopy(self.s.origin, self.absmax);
}

/*QUAKED light (0 1 0) (-8 -8 -8) (8 8 8) START_OFF
Non-displayed light.
Default light value is 300.
Default style is 0.
If targeted, will toggle between on and off.
Default _cone value is 10 (used to set size of light for spotlights)
*/

const START_OFF = 1;

function light_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  if (self.spawnflags & START_OFF) {
    gi.configstring(CS_LIGHTS + self.style, "m");
    self.spawnflags &= ~START_OFF;
  } else {
    gi.configstring(CS_LIGHTS + self.style, "a");
    self.spawnflags |= START_OFF;
  }
}

export function SP_light(self: EdictT): void {
  const deathmatch = gameCvars.deathmatch === null ? 0 : gameCvars.deathmatch.value;

  // no targeted lights in deathmatch, because they cause global messages
  if (!self.targetname || deathmatch) {
    G_FreeEdict(self);
    return;
  }

  if (self.style >= 32) {
    self.use = light_use;
    if (self.spawnflags & START_OFF) gi.configstring(CS_LIGHTS + self.style, "a");
    else gi.configstring(CS_LIGHTS + self.style, "m");
  }
}

/*QUAKED func_wall (0 .5 .8) ? TRIGGER_SPAWN TOGGLE START_ON ANIMATED ANIMATED_FAST
This is just a solid wall if not inhibited

TRIGGER_SPAWN	the wall will not be present until triggered
				it will then blink in to existance; it will
				kill anything that was in it's way

TOGGLE			only valid for TRIGGER_SPAWN walls
				this allows the wall to be turned on and off

START_ON		only valid for TRIGGER_SPAWN walls
				the wall will initially be present
*/

function func_wall_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  if (self.solid === SolidT.SOLID_NOT) {
    self.solid = SolidT.SOLID_BSP;
    self.svflags &= ~SVF_NOCLIENT;
    KillBox(self);
  } else {
    self.solid = SolidT.SOLID_NOT;
    self.svflags |= SVF_NOCLIENT;
  }
  gi.linkentity(self);

  if (!(self.spawnflags & 2)) self.use = null;
}

export function SP_func_wall(self: EdictT): void {
  self.movetype = MovetypeT.MOVETYPE_PUSH;
  gi.setmodel(self, self.model ?? "");

  if (self.spawnflags & 8) self.s.effects |= EF_ANIM_ALL;
  if (self.spawnflags & 16) self.s.effects |= EF_ANIM_ALLFAST;

  // just a wall
  if ((self.spawnflags & 7) === 0) {
    self.solid = SolidT.SOLID_BSP;
    gi.linkentity(self);
    return;
  }

  // it must be TRIGGER_SPAWN
  if (!(self.spawnflags & 1)) {
    //		gi.dprintf("func_wall missing TRIGGER_SPAWN\n");
    self.spawnflags |= 1;
  }

  // yell if the spawnflags are odd
  if (self.spawnflags & 4) {
    if (!(self.spawnflags & 2)) {
      gi.dprintf("func_wall START_ON without TOGGLE\n");
      self.spawnflags |= 2;
    }
  }

  self.use = func_wall_use;
  if (self.spawnflags & 4) {
    self.solid = SolidT.SOLID_BSP;
  } else {
    self.solid = SolidT.SOLID_NOT;
    self.svflags |= SVF_NOCLIENT;
  }
  gi.linkentity(self);
}

/*QUAKED func_object (0 .5 .8) ? TRIGGER_SPAWN ANIMATED ANIMATED_FAST
This is solid bmodel that will fall if it's support it removed.
*/

function func_object_touch(self: EdictT, other: EdictT, plane: CplaneT | null, _surf: CsurfaceT | null): void {
  // only squash thing we fall on top of
  if (!plane) return;
  if (plane.normal[2] < 1.0) return;
  if (other.takedamage === DamageT.DAMAGE_NO) return;
  T_Damage(other, self, self, vec3_origin, self.s.origin, vec3_origin, self.dmg, 1, 0, MOD_CRUSH);
}

function func_object_release(self: EdictT): void {
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.touch = func_object_touch;
}

function func_object_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  self.solid = SolidT.SOLID_BSP;
  self.svflags &= ~SVF_NOCLIENT;
  self.use = null;
  KillBox(self);
  func_object_release(self);
}

export function SP_func_object(self: EdictT): void {
  gi.setmodel(self, self.model ?? "");

  self.mins[0] += 1;
  self.mins[1] += 1;
  self.mins[2] += 1;
  self.maxs[0] -= 1;
  self.maxs[1] -= 1;
  self.maxs[2] -= 1;

  if (!self.dmg) self.dmg = 100;

  if (self.spawnflags === 0) {
    self.solid = SolidT.SOLID_BSP;
    self.movetype = MovetypeT.MOVETYPE_PUSH;
    self.think = func_object_release;
    self.nextthink = level.time + 2 * FRAMETIME;
  } else {
    self.solid = SolidT.SOLID_NOT;
    self.movetype = MovetypeT.MOVETYPE_PUSH;
    self.use = func_object_use;
    self.svflags |= SVF_NOCLIENT;
  }

  if (self.spawnflags & 2) self.s.effects |= EF_ANIM_ALL;
  if (self.spawnflags & 4) self.s.effects |= EF_ANIM_ALLFAST;

  self.clipmask = MASK_MONSTERSOLID;

  gi.linkentity(self);
}

/*QUAKED func_explosive (0 .5 .8) ? Trigger_Spawn ANIMATED ANIMATED_FAST
Any brush that you want to explode or break apart.  If you want an
ex0plosion, set dmg and it will do a radius explosion of that amount
at the center of the bursh.

If targeted it will not be shootable.

health defaults to 100.

mass defaults to 75.  This determines how much debris is emitted when
it explodes.  You get one large chunk per 100 of mass (up to 8) and
one small chunk per 25 of mass (up to 16).  So 800 gives the most.
*/

// LM_JORM -- respawns a func_explosive that blew up in deathmatch (see
// func_explosive_explode's LM_JORM branch below).
function func_explosive_respawn(self: EdictT): void {
  gi.sound(self, CHAN_AUTO, gi.soundindex("tank/thud.wav"), 1, ATTN_NORM, 0);
  self.solid = SolidT.SOLID_BSP;
  self.svflags &= ~SVF_NOCLIENT;
  self.takedamage = DamageT.DAMAGE_YES;
  self.think = null;
  KillBox(self);
  gi.linkentity(self);
}
// END LM_JORM

function func_explosive_explode(self: EdictT, _inflictor: EdictT, attacker: EdictT, _damage: number, _point: Vec3): void {
  // bmodel origins are (0 0 0), we need to adjust that here -- LM_JORM
  // (surt) comments out the corresponding `VectorCopy(origin, self->s.origin)`
  // ("the ent needs to reappear"), so `origin` below is only ever used to
  // seed the ThrowDebris chunk positions, never written back to self.s.origin.
  const size = vec3();
  const origin = vec3();
  VectorScale(self.size, 0.5, size);
  VectorAdd(self.absmin, size, origin);

  self.takedamage = DamageT.DAMAGE_NO;

  if (self.dmg) T_RadiusDamage(self, attacker, self.dmg, null, self.dmg + 40, MOD_EXPLOSIVE);

  // LM_JORM (surt) also comments out the velocity-towards-inflictor block
  // here ("don't want to screw with self while generating the debris") --
  // self.velocity is left untouched by this function now.

  // start chunks towards the center
  VectorScale(size, 0.5, size);

  let mass = self.mass;
  if (!mass) mass = 75;

  const chunkorigin = vec3();

  // big chunks
  if (mass >= 100) {
    let count = (mass / 100) | 0;
    if (count > 8) count = 8;
    while (count--) {
      chunkorigin[0] = origin[0] + crandom() * size[0];
      chunkorigin[1] = origin[1] + crandom() * size[1];
      chunkorigin[2] = origin[2] + crandom() * size[2];
      ThrowDebris(self, "models/objects/debris1/tris.md2", 1, chunkorigin);
    }
  }

  // small chunks
  let count = (mass / 25) | 0;
  if (count > 16) count = 16;
  while (count--) {
    chunkorigin[0] = origin[0] + crandom() * size[0];
    chunkorigin[1] = origin[1] + crandom() * size[1];
    chunkorigin[2] = origin[2] + crandom() * size[2];
    ThrowDebris(self, "models/objects/debris2/tris.md2", 2, chunkorigin);
  }

  G_UseTargets(self, attacker);

  // LM_JORM -- support respawning explosive walls in deathmatch
  const deathmatch = gameCvars.deathmatch === null ? 0 : gameCvars.deathmatch.value;
  if (!deathmatch) {
    if (self.dmg) BecomeExplosion1(self);
    else G_FreeEdict(self);
  } else {
    self.svflags |= SVF_NOCLIENT;
    self.solid = SolidT.SOLID_NOT;
    self.think = func_explosive_respawn;
    self.nextthink = level.time + self.speed;
  }
  // END LM_JORM
}

function func_explosive_use(self: EdictT, other: EdictT | null, _activator: EdictT | null): void {
  // C: `func_explosive_explode (self, self, other, self->health, vec3_origin);`
  // -- self is passed as both the entity and the inflictor, other (the use
  // activator) as the damage attacker.
  if (other === null) return;
  func_explosive_explode(self, self, other, self.health, vec3_origin);
}

function func_explosive_spawn(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  self.solid = SolidT.SOLID_BSP;
  self.svflags &= ~SVF_NOCLIENT;
  self.use = null;
  KillBox(self);
  gi.linkentity(self);
}

export function SP_func_explosive(self: EdictT): void {
  // LM_JORM -- the old `if (deathmatch->value) { auto-remove }` block is
  // commented out in lmctf60 and replaced by this speed check. Despite the
  // "auto-remove for deathmatch" comment carried over from the original,
  // this now fires whenever "speed" is unset, in every game mode, not just
  // deathmatch -- map authors must set "speed" to opt into LM_JORM's
  // deathmatch-respawn behavior (see func_explosive_explode above).
  if (!self.speed) {
    G_FreeEdict(self);
    return;
  }

  self.movetype = MovetypeT.MOVETYPE_PUSH;

  gi.modelindex("models/objects/debris1/tris.md2");
  gi.modelindex("models/objects/debris2/tris.md2");

  gi.setmodel(self, self.model ?? "");

  if (self.spawnflags & 1) {
    self.svflags |= SVF_NOCLIENT;
    self.solid = SolidT.SOLID_NOT;
    self.use = func_explosive_spawn;
  } else {
    self.solid = SolidT.SOLID_BSP;
    if (self.targetname) self.use = func_explosive_use;
  }

  if (self.spawnflags & 2) self.s.effects |= EF_ANIM_ALL;
  if (self.spawnflags & 4) self.s.effects |= EF_ANIM_ALLFAST;

  if (self.use !== func_explosive_use) {
    // LM_JORM (surt): "health might be less than 0 on respawn" -- checks
    // `<= 0` instead of ctf's falsy `!self.health`, so a leftover negative
    // health from a previous explosion still gets reset to 100.
    if (self.health <= 0) self.health = 100;
    self.die = func_explosive_explode;
    self.takedamage = DamageT.DAMAGE_YES;
  }

  gi.linkentity(self);
}

/*QUAKED misc_explobox (0 .5 .8) (-16 -16 0) (16 16 40)
Large exploding box.  You can override its mass (100),
health (80), and dmg (150).
*/

// M_walkmove (g_monster.c/m_move.c) has no port in this family -- monster
// movement is a dead subsystem here (MONSTERS_OK is never defined in
// lmctf60's Makefile, verified by src/lmctf/g_local.ts and g_combat.ts).
// Unlike SP_misc_explobox's `#ifdef MONSTERS_OK`-gated M_droptofloor call
// below, this call is NOT inside an ifdef in lmctf60/g_misc.c -- it is live,
// reachable code (fired whenever something with mass touches the barrel
// while it has a groundentity), so it throws here rather than being
// silently dropped, matching src/lmctf/g_target.ts's use_target_blaster
// precedent for a reachable call into an unported dependency.
function barrel_touch(self: EdictT, other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  if (!other.groundentity || other.groundentity === self) return;

  void self;
  void other;
  throw new Error(
    "barrel_touch: M_walkmove (lmctf60/m_move.c) is not ported -- monster movement is out of this family's scope (MONSTERS_OK is never defined)",
  );
}

function barrel_explode(self: EdictT): void {
  T_RadiusDamage(self, self.activator ?? self, self.dmg, null, self.dmg + 40, MOD_BARREL);

  const save = vec3();
  VectorCopy(self.s.origin, save);
  VectorMA(self.absmin, 0.5, self.size, self.s.origin);

  const org = vec3();

  // a few big chunks
  let spd = (1.5 * self.dmg) / 200.0;
  org[0] = self.s.origin[0] + crandom() * self.size[0];
  org[1] = self.s.origin[1] + crandom() * self.size[1];
  org[2] = self.s.origin[2] + crandom() * self.size[2];
  ThrowDebris(self, "models/objects/debris1/tris.md2", spd, org);
  org[0] = self.s.origin[0] + crandom() * self.size[0];
  org[1] = self.s.origin[1] + crandom() * self.size[1];
  org[2] = self.s.origin[2] + crandom() * self.size[2];
  ThrowDebris(self, "models/objects/debris1/tris.md2", spd, org);

  // bottom corners
  spd = (1.75 * self.dmg) / 200.0;
  VectorCopy(self.absmin, org);
  ThrowDebris(self, "models/objects/debris3/tris.md2", spd, org);
  VectorCopy(self.absmin, org);
  org[0] += self.size[0];
  ThrowDebris(self, "models/objects/debris3/tris.md2", spd, org);
  VectorCopy(self.absmin, org);
  org[1] += self.size[1];
  ThrowDebris(self, "models/objects/debris3/tris.md2", spd, org);
  VectorCopy(self.absmin, org);
  org[0] += self.size[0];
  org[1] += self.size[1];
  ThrowDebris(self, "models/objects/debris3/tris.md2", spd, org);

  // a bunch of little chunks
  spd = (2 * self.dmg) / 200;
  for (let i = 0; i < 8; i++) {
    org[0] = self.s.origin[0] + crandom() * self.size[0];
    org[1] = self.s.origin[1] + crandom() * self.size[1];
    org[2] = self.s.origin[2] + crandom() * self.size[2];
    ThrowDebris(self, "models/objects/debris2/tris.md2", spd, org);
  }

  VectorCopy(save, self.s.origin);
  if (self.groundentity) BecomeExplosion2(self);
  else BecomeExplosion1(self);
}

function barrel_delay(self: EdictT, _inflictor: EdictT, attacker: EdictT, _damage: number, _point: Vec3): void {
  self.takedamage = DamageT.DAMAGE_NO;
  self.nextthink = level.time + 2 * FRAMETIME;
  self.think = barrel_explode;
  self.activator = attacker;
}

export function SP_misc_explobox(self: EdictT): void {
  const deathmatch = gameCvars.deathmatch === null ? 0 : gameCvars.deathmatch.value;
  if (deathmatch) {
    // auto-remove for deathmatch
    G_FreeEdict(self);
    return;
  }

  gi.modelindex("models/objects/debris1/tris.md2");
  gi.modelindex("models/objects/debris2/tris.md2");
  gi.modelindex("models/objects/debris3/tris.md2");

  self.solid = SolidT.SOLID_BBOX;
  self.movetype = MovetypeT.MOVETYPE_STEP;

  self.model = "models/objects/barrels/tris.md2";
  self.s.modelindex = gi.modelindex(self.model);
  VectorSet(self.mins, -16, -16, 0);
  VectorSet(self.maxs, 16, 16, 40);

  if (!self.mass) self.mass = 400;
  if (!self.health) self.health = 10;
  if (!self.dmg) self.dmg = 150;

  self.die = barrel_delay;
  self.takedamage = DamageT.DAMAGE_YES;
  self.monsterinfo.aiflags = AI_NOSTEP;

  self.touch = barrel_touch;

  // `self->think = M_droptofloor;` is wrapped in `#ifdef MONSTERS_OK` in
  // lmctf60/g_misc.c, which is never defined for this build -- dead code,
  // dropped rather than ported (see file header's MONSTERS_OK note).
  // self.nextthink below is set unconditionally in the C source, so it is
  // kept unconditionally here too, faithfully reproducing lmctf60's own
  // (self.think === null, self.nextthink set) state for a fresh
  // misc_explobox.
  self.nextthink = level.time + 2 * FRAMETIME;

  gi.linkentity(self);
}

//
// miscellaneous specialty items
//

/*QUAKED misc_blackhole (1 .5 0) (-8 -8 -8) (8 8 8)
*/

function misc_blackhole_use(ent: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  /*
	gi.WriteByte (svc_temp_entity);
	gi.WriteByte (TE_BOSSTPORT);
	gi.WritePosition (ent->s.origin);
	gi.multicast (ent->s.origin, MULTICAST_PVS);
	*/
  G_FreeEdict(ent);
}

function misc_blackhole_think(self: EdictT): void {
  if (++self.s.frame < 19) {
    self.nextthink = level.time + FRAMETIME;
  } else {
    self.s.frame = 0;
    self.nextthink = level.time + FRAMETIME;
  }
}

export function SP_misc_blackhole(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_NOT;
  VectorSet(ent.mins, -64, -64, 0);
  VectorSet(ent.maxs, 64, 64, 8);
  ent.s.modelindex = gi.modelindex("models/objects/black/tris.md2");
  ent.s.renderfx = RF_TRANSLUCENT;
  ent.use = misc_blackhole_use;
  ent.think = misc_blackhole_think;
  ent.nextthink = level.time + 2 * FRAMETIME;
  gi.linkentity(ent);
}

/*QUAKED misc_eastertank (1 .5 0) (-32 -32 -16) (32 32 32)
*/

function misc_eastertank_think(self: EdictT): void {
  if (++self.s.frame < 293) {
    self.nextthink = level.time + FRAMETIME;
  } else {
    self.s.frame = 254;
    self.nextthink = level.time + FRAMETIME;
  }
}

export function SP_misc_eastertank(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_BBOX;
  VectorSet(ent.mins, -32, -32, -16);
  VectorSet(ent.maxs, 32, 32, 32);
  ent.s.modelindex = gi.modelindex("models/monsters/tank/tris.md2");
  ent.s.frame = 254;
  ent.think = misc_eastertank_think;
  ent.nextthink = level.time + 2 * FRAMETIME;
  gi.linkentity(ent);
}

/*QUAKED misc_easterchick (1 .5 0) (-32 -32 0) (32 32 32)
*/

function misc_easterchick_think(self: EdictT): void {
  if (++self.s.frame < 247) {
    self.nextthink = level.time + FRAMETIME;
  } else {
    self.s.frame = 208;
    self.nextthink = level.time + FRAMETIME;
  }
}

export function SP_misc_easterchick(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_BBOX;
  VectorSet(ent.mins, -32, -32, 0);
  VectorSet(ent.maxs, 32, 32, 32);
  ent.s.modelindex = gi.modelindex("models/monsters/bitch/tris.md2");
  ent.s.frame = 208;
  ent.think = misc_easterchick_think;
  ent.nextthink = level.time + 2 * FRAMETIME;
  gi.linkentity(ent);
}

/*QUAKED misc_easterchick2 (1 .5 0) (-32 -32 0) (32 32 32)
*/

function misc_easterchick2_think(self: EdictT): void {
  if (++self.s.frame < 287) {
    self.nextthink = level.time + FRAMETIME;
  } else {
    self.s.frame = 248;
    self.nextthink = level.time + FRAMETIME;
  }
}

export function SP_misc_easterchick2(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_BBOX;
  VectorSet(ent.mins, -32, -32, 0);
  VectorSet(ent.maxs, 32, 32, 32);
  ent.s.modelindex = gi.modelindex("models/monsters/bitch/tris.md2");
  ent.s.frame = 248;
  ent.think = misc_easterchick2_think;
  ent.nextthink = level.time + 2 * FRAMETIME;
  gi.linkentity(ent);
}

/*QUAKED monster_commander_body (1 .5 0) (-32 -32 0) (32 32 48)
Not really a monster, this is the Tank Commander's decapitated body.
There should be a item_commander_head that has this as it's target.
*/

function commander_body_think(self: EdictT): void {
  if (++self.s.frame < 24) self.nextthink = level.time + FRAMETIME;
  else self.nextthink = 0;

  if (self.s.frame === 22) gi.sound(self, CHAN_BODY, gi.soundindex("tank/thud.wav"), 1, ATTN_NORM, 0);
}

function commander_body_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  self.think = commander_body_think;
  self.nextthink = level.time + FRAMETIME;
  gi.sound(self, CHAN_BODY, gi.soundindex("tank/pain.wav"), 1, ATTN_NORM, 0);
}

function commander_body_drop(self: EdictT): void {
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.s.origin[2] += 2;
}

export function SP_monster_commander_body(self: EdictT): void {
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.solid = SolidT.SOLID_BBOX;
  self.model = "models/monsters/commandr/tris.md2";
  self.s.modelindex = gi.modelindex(self.model);
  VectorSet(self.mins, -32, -32, 0);
  VectorSet(self.maxs, 32, 32, 48);
  self.use = commander_body_use;
  self.takedamage = DamageT.DAMAGE_YES;
  self.flags = FL_GODMODE;
  self.s.renderfx |= RF_FRAMELERP;
  gi.linkentity(self);

  gi.soundindex("tank/thud.wav");
  gi.soundindex("tank/pain.wav");

  self.think = commander_body_drop;
  self.nextthink = level.time + 5 * FRAMETIME;
}

/*QUAKED misc_banner (1 .5 0) (-4 -4 -4) (4 4 4)
The origin is the bottom of the banner.
The banner is 128 tall.
*/
function misc_banner_think(ent: EdictT): void {
  ent.s.frame = (ent.s.frame + 1) % 16;
  ent.nextthink = level.time + FRAMETIME;
}

export function SP_misc_banner(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_NOT;
  ent.s.modelindex = gi.modelindex("models/objects/banner/tris.md2");
  // C: `rand() % 16` -- see ThrowClientHead's comment on the raw-rand() idiom.
  ent.s.frame = Math.floor(Math.random() * 16);
  gi.linkentity(ent);

  ent.think = misc_banner_think;
  ent.nextthink = level.time + FRAMETIME;
}

// LM_JORM -- COMPATIBILITY WITH ZOID'S BANNERS
//
// These three spawners (misc_ctf_banner, misc_ctf_small_banner,
// info_position) are new in lmctf60/g_misc.c -- ctf's own equivalents live
// in g_ctf.c (out of this file's scope, ported separately as
// src/ctf/g_ctf.ts) under the same names but different bodies. Ported here
// fresh from lmctf60's own source; both banner spawners are plain
// decoration entities with no monster/CTF-subsystem dependency.

/*-----------------------------------------------------------------------*/
/*QUAKED misc_ctf_banner (1 .5 0) (-4 -64 0) (4 64 248) TEAM2
The origin is the bottom of the banner.
The banner is 248 tall.
*/
export function SP_info_position(_ent: EdictT): void {}

function misc_ctf_banner_think(ent: EdictT): void {
  ent.s.frame = (ent.s.frame + 1) % 16;
  ent.nextthink = level.time + FRAMETIME;
}

export function SP_misc_ctf_banner(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_NOT;
  ent.s.modelindex = gi.modelindex("models/ctf/banner/tris.md2");
  if (ent.spawnflags & 1) ent.s.skinnum = 1; // team2

  ent.s.frame = Math.floor(Math.random() * 16);
  gi.linkentity(ent);

  ent.think = misc_ctf_banner_think;
  ent.nextthink = level.time + FRAMETIME;
}

/*QUAKED misc_ctf_small_banner (1 .5 0) (-4 -32 0) (4 32 124) TEAM2
The origin is the bottom of the banner.
The banner is 124 tall.
*/
export function SP_misc_ctf_small_banner(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_NOT;
  ent.s.modelindex = gi.modelindex("models/ctf/banner/small.md2");
  if (ent.spawnflags & 1) ent.s.skinnum = 1; // team2

  ent.s.frame = Math.floor(Math.random() * 16);
  gi.linkentity(ent);

  ent.think = misc_ctf_banner_think;
  ent.nextthink = level.time + FRAMETIME;
}

// END LM_JORM -- COMPATIBILITY WITH ZOID'S BANNERS

/*QUAKED misc_deadsoldier (1 .5 0) (-16 -16 0) (16 16 16) ON_BACK ON_STOMACH BACK_DECAP FETAL_POS SIT_DECAP IMPALED
This is the dead player model. Comes in 6 exciting different poses!
*/
function misc_deadsoldier_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3): void {
  if (self.health > -80) return;

  gi.sound(self, CHAN_BODY, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
  for (let n = 0; n < 4; n++) {
    ThrowGib(self, "models/objects/gibs/sm_meat/tris.md2", damage, GIB_ORGANIC);
  }
  ThrowHead(self, "models/objects/gibs/head2/tris.md2", damage, GIB_ORGANIC);
}

export function SP_misc_deadsoldier(ent: EdictT): void {
  const deathmatch = gameCvars.deathmatch === null ? 0 : gameCvars.deathmatch.value;
  if (deathmatch) {
    // auto-remove for deathmatch
    G_FreeEdict(ent);
    return;
  }

  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_BBOX;
  ent.s.modelindex = gi.modelindex("models/deadbods/dude/tris.md2");

  // Defaults to frame 0
  if (ent.spawnflags & 2) ent.s.frame = 1;
  else if (ent.spawnflags & 4) ent.s.frame = 2;
  else if (ent.spawnflags & 8) ent.s.frame = 3;
  else if (ent.spawnflags & 16) ent.s.frame = 4;
  else if (ent.spawnflags & 32) ent.s.frame = 5;
  else ent.s.frame = 0;

  VectorSet(ent.mins, -16, -16, 0);
  VectorSet(ent.maxs, 16, 16, 16);
  ent.deadflag = DEAD_DEAD;
  ent.takedamage = DamageT.DAMAGE_YES;
  ent.svflags |= SVF_MONSTER | SVF_DEADMONSTER;
  ent.die = misc_deadsoldier_die;
  ent.monsterinfo.aiflags |= AI_GOOD_GUY;

  gi.linkentity(ent);
}

/*QUAKED misc_viper (1 .5 0) (-16 -16 0) (16 16 32)
This is the Viper for the flyby bombing.
It is trigger_spawned, so you must have something use it for it to show up.
There must be a path for it to follow once it is activated.

"speed"		How fast the Viper should fly
*/

function misc_viper_use(self: EdictT, other: EdictT | null, activator: EdictT | null): void {
  self.svflags &= ~SVF_NOCLIENT;
  self.use = train_use;
  train_use(self, other, activator);
}

export function SP_misc_viper(ent: EdictT): void {
  if (!ent.target) {
    gi.dprintf(`misc_viper without a target at ${vtos(ent.absmin)}\n`);
    G_FreeEdict(ent);
    return;
  }

  if (!ent.speed) ent.speed = 300;

  ent.movetype = MovetypeT.MOVETYPE_PUSH;
  ent.solid = SolidT.SOLID_NOT;
  ent.s.modelindex = gi.modelindex("models/ships/viper/tris.md2");
  VectorSet(ent.mins, -16, -16, 0);
  VectorSet(ent.maxs, 16, 16, 32);

  ent.think = func_train_find;
  ent.nextthink = level.time + FRAMETIME;
  ent.use = misc_viper_use;
  ent.svflags |= SVF_NOCLIENT;
  ent.moveinfo.accel = ent.moveinfo.decel = ent.moveinfo.speed = ent.speed;

  gi.linkentity(ent);
}

/*QUAKED misc_bigviper (1 .5 0) (-176 -120 -24) (176 120 72)
This is a large stationary viper as seen in Paul's intro
*/
export function SP_misc_bigviper(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_BBOX;
  VectorSet(ent.mins, -176, -120, -24);
  VectorSet(ent.maxs, 176, 120, 72);
  ent.s.modelindex = gi.modelindex("models/ships/bigviper/tris.md2");
  gi.linkentity(ent);
}

/*QUAKED misc_viper_bomb (1 0 0) (-8 -8 -8) (8 8 8)
"dmg"	how much boom should the bomb make?
*/
function misc_viper_bomb_touch(self: EdictT, _other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  G_UseTargets(self, self.activator);

  self.s.origin[2] = self.absmin[2] + 1;
  T_RadiusDamage(self, self, self.dmg, null, self.dmg + 40, MOD_BOMB);
  BecomeExplosion2(self);
}

function misc_viper_bomb_prethink(self: EdictT): void {
  self.groundentity = null;

  let diff = self.timestamp - level.time;
  if (diff < -1.0) diff = -1.0;

  const v = vec3();
  VectorScale(self.moveinfo.dir, 1.0 + diff, v);
  v[2] = diff;

  const prevZAngle = self.s.angles[2];
  vectoangles(v, self.s.angles);
  self.s.angles[2] = prevZAngle + 10;
}

function misc_viper_bomb_use(self: EdictT, _other: EdictT | null, activator: EdictT | null): void {
  self.solid = SolidT.SOLID_BBOX;
  self.svflags &= ~SVF_NOCLIENT;
  self.s.effects |= EF_ROCKET;
  self.use = null;
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.prethink = misc_viper_bomb_prethink;
  self.touch = misc_viper_bomb_touch;
  self.activator = activator;

  const viper = G_Find(null, "classname", "misc_viper");
  if (viper !== null) {
    VectorScale(viper.moveinfo.dir, viper.moveinfo.speed, self.velocity);
    VectorCopy(viper.moveinfo.dir, self.moveinfo.dir);
  }

  self.timestamp = level.time;
}

export function SP_misc_viper_bomb(self: EdictT): void {
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.solid = SolidT.SOLID_NOT;
  VectorSet(self.mins, -8, -8, -8);
  VectorSet(self.maxs, 8, 8, 8);

  self.s.modelindex = gi.modelindex("models/objects/bomb/tris.md2");

  if (!self.dmg) self.dmg = 1000;

  self.use = misc_viper_bomb_use;
  self.svflags |= SVF_NOCLIENT;

  gi.linkentity(self);
}

/*QUAKED misc_strogg_ship (1 .5 0) (-16 -16 0) (16 16 32)
This is a Storgg ship for the flybys.
It is trigger_spawned, so you must have something use it for it to show up.
There must be a path for it to follow once it is activated.

"speed"		How fast it should fly
*/

function misc_strogg_ship_use(self: EdictT, other: EdictT | null, activator: EdictT | null): void {
  self.svflags &= ~SVF_NOCLIENT;
  self.use = train_use;
  train_use(self, other, activator);
}

export function SP_misc_strogg_ship(ent: EdictT): void {
  if (!ent.target) {
    gi.dprintf(`${ent.classname} without a target at ${vtos(ent.absmin)}\n`);
    G_FreeEdict(ent);
    return;
  }

  if (!ent.speed) ent.speed = 300;

  ent.movetype = MovetypeT.MOVETYPE_PUSH;
  ent.solid = SolidT.SOLID_NOT;
  ent.s.modelindex = gi.modelindex("models/ships/strogg1/tris.md2");
  VectorSet(ent.mins, -16, -16, 0);
  VectorSet(ent.maxs, 16, 16, 32);

  ent.think = func_train_find;
  ent.nextthink = level.time + FRAMETIME;
  ent.use = misc_strogg_ship_use;
  ent.svflags |= SVF_NOCLIENT;
  ent.moveinfo.accel = ent.moveinfo.decel = ent.moveinfo.speed = ent.speed;

  gi.linkentity(ent);
}

/*QUAKED misc_satellite_dish (1 .5 0) (-64 -64 0) (64 64 128)
*/
function misc_satellite_dish_think(self: EdictT): void {
  self.s.frame++;
  if (self.s.frame < 38) self.nextthink = level.time + FRAMETIME;
}

function misc_satellite_dish_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  self.s.frame = 0;
  self.think = misc_satellite_dish_think;
  self.nextthink = level.time + FRAMETIME;
}

export function SP_misc_satellite_dish(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_BBOX;
  VectorSet(ent.mins, -64, -64, 0);
  VectorSet(ent.maxs, 64, 64, 128);
  ent.s.modelindex = gi.modelindex("models/objects/satellite/tris.md2");
  ent.use = misc_satellite_dish_use;
  gi.linkentity(ent);
}

/*QUAKED light_mine1 (0 1 0) (-2 -2 -12) (2 2 12)
*/
export function SP_light_mine1(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_BBOX;
  ent.s.modelindex = gi.modelindex("models/objects/minelite/light1/tris.md2");
  gi.linkentity(ent);
}

/*QUAKED light_mine2 (0 1 0) (-2 -2 -12) (2 2 12)
*/
export function SP_light_mine2(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_BBOX;
  ent.s.modelindex = gi.modelindex("models/objects/minelite/light2/tris.md2");
  gi.linkentity(ent);
}

/*QUAKED misc_gib_arm (1 0 0) (-8 -8 -8) (8 8 8)
Intended for use with the target_spawner
*/
export function SP_misc_gib_arm(ent: EdictT): void {
  gi.setmodel(ent, "models/objects/gibs/arm/tris.md2");
  ent.solid = SolidT.SOLID_NOT;
  ent.s.effects |= EF_GIB;
  ent.takedamage = DamageT.DAMAGE_YES;
  ent.die = gib_die;
  ent.movetype = MovetypeT.MOVETYPE_TOSS;
  ent.svflags |= SVF_MONSTER;
  ent.deadflag = DEAD_DEAD;
  ent.avelocity[0] = random() * 200;
  ent.avelocity[1] = random() * 200;
  ent.avelocity[2] = random() * 200;
  ent.think = G_FreeEdict;
  ent.nextthink = level.time + 30;
  gi.linkentity(ent);
}

/*QUAKED misc_gib_leg (1 0 0) (-8 -8 -8) (8 8 8)
Intended for use with the target_spawner
*/
export function SP_misc_gib_leg(ent: EdictT): void {
  gi.setmodel(ent, "models/objects/gibs/leg/tris.md2");
  ent.solid = SolidT.SOLID_NOT;
  ent.s.effects |= EF_GIB;
  ent.takedamage = DamageT.DAMAGE_YES;
  ent.die = gib_die;
  ent.movetype = MovetypeT.MOVETYPE_TOSS;
  ent.svflags |= SVF_MONSTER;
  ent.deadflag = DEAD_DEAD;
  ent.avelocity[0] = random() * 200;
  ent.avelocity[1] = random() * 200;
  ent.avelocity[2] = random() * 200;
  ent.think = G_FreeEdict;
  ent.nextthink = level.time + 30;
  gi.linkentity(ent);
}

/*QUAKED misc_gib_head (1 0 0) (-8 -8 -8) (8 8 8)
Intended for use with the target_spawner
*/
export function SP_misc_gib_head(ent: EdictT): void {
  gi.setmodel(ent, "models/objects/gibs/head/tris.md2");
  ent.solid = SolidT.SOLID_NOT;
  ent.s.effects |= EF_GIB;
  ent.takedamage = DamageT.DAMAGE_YES;
  ent.die = gib_die;
  ent.movetype = MovetypeT.MOVETYPE_TOSS;
  ent.svflags |= SVF_MONSTER;
  ent.deadflag = DEAD_DEAD;
  ent.avelocity[0] = random() * 200;
  ent.avelocity[1] = random() * 200;
  ent.avelocity[2] = random() * 200;
  ent.think = G_FreeEdict;
  ent.nextthink = level.time + 30;
  gi.linkentity(ent);
}

//=====================================================

/*QUAKED target_character (0 0 1) ?
used with target_string (must be on same "team")
"count" is position in the string (starts at 1)
*/

export function SP_target_character(self: EdictT): void {
  self.movetype = MovetypeT.MOVETYPE_PUSH;
  gi.setmodel(self, self.model ?? "");
  self.solid = SolidT.SOLID_BSP;
  self.s.frame = 12;
  gi.linkentity(self);
}

/*QUAKED target_string (0 0 1) (-8 -8 -8) (8 8 8)
*/

function target_string_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  const message = self.message ?? "";
  const l = message.length;
  for (let e: EdictT | null = self.teammaster; e !== null; e = e.teamchain) {
    if (!e.count) continue;
    const n = e.count - 1;
    if (n > l) {
      e.s.frame = 12;
      continue;
    }

    const c = message[n];
    if (c !== undefined && c >= "0" && c <= "9") e.s.frame = c.charCodeAt(0) - "0".charCodeAt(0);
    else if (c === "-") e.s.frame = 10;
    else if (c === ":") e.s.frame = 11;
    else e.s.frame = 12;
  }
}

export function SP_target_string(self: EdictT): void {
  if (!self.message) self.message = "";
  self.use = target_string_use;
}

/*QUAKED func_clock (0 0 1) (-8 -8 -8) (8 8 8) TIMER_UP TIMER_DOWN START_OFF MULTI_USE
target a target_string with this

The default is to be a time of day clock

TIMER_UP and TIMER_DOWN run for "count" seconds and the fire "pathtarget"
If START_OFF, this entity must be used before it starts

"style"		0 "xx"
			1 "xx:xx"
			2 "xx:xx:xx"
*/

const CLOCK_MESSAGE_SIZE = 16;

// don't let field width of any clock messages change, or it
// could cause an overwrite after a game load

function func_clock_reset(self: EdictT): void {
  self.activator = null;
  if (self.spawnflags & 1) {
    self.health = 0;
    self.wait = self.count;
  } else if (self.spawnflags & 2) {
    self.health = self.count;
    self.wait = 0;
  }
}

// C zero-pads the tens digit by hand after a space-padded "%2i" sprintf
// (`if (self->message[3] == ' ') self->message[3] = '0';`); JS strings are
// immutable, so the in-place index assignment becomes a slice-and-rebuild.
function zeroPadDigit(msg: string, index: number): string {
  if (msg[index] === " ") return `${msg.slice(0, index)}0${msg.slice(index + 1)}`;
  return msg;
}

function func_clock_format_countdown(self: EdictT): void {
  if (self.style === 0) {
    self.message = Com_sprintf("%2i", self.health);
    return;
  }

  if (self.style === 1) {
    let msg = Com_sprintf("%2i:%2i", (self.health / 60) | 0, self.health % 60);
    msg = zeroPadDigit(msg, 3);
    self.message = msg;
    return;
  }

  if (self.style === 2) {
    let msg = Com_sprintf(
      "%2i:%2i:%2i",
      (self.health / 3600) | 0,
      ((self.health - ((self.health / 3600) | 0) * 3600) / 60) | 0,
      self.health % 60,
    );
    msg = zeroPadDigit(msg, 3);
    msg = zeroPadDigit(msg, 6);
    self.message = msg;
  }
}

function func_clock_think(self: EdictT): void {
  if (!self.enemy) {
    self.enemy = self.target !== null ? G_Find(null, "targetname", self.target) : null;
    if (!self.enemy) return;
  }

  if (self.spawnflags & 1) {
    func_clock_format_countdown(self);
    self.health++;
  } else if (self.spawnflags & 2) {
    func_clock_format_countdown(self);
    self.health--;
  } else {
    // C: `time(&gmtime); ltime = localtime(&gmtime);` -- the portable
    // equivalent on this side of the port is the host's local wall clock.
    const now = new Date();
    let msg = Com_sprintf("%2i:%2i:%2i", now.getHours(), now.getMinutes(), now.getSeconds());
    msg = zeroPadDigit(msg, 3);
    msg = zeroPadDigit(msg, 6);
    self.message = msg;
  }

  self.enemy.message = self.message;
  if (self.enemy.use) self.enemy.use(self.enemy, self, self);

  if ((self.spawnflags & 1 && self.health > self.wait) || (self.spawnflags & 2 && self.health < self.wait)) {
    if (self.pathtarget) {
      const savetarget = self.target;
      const savemessage = self.message;
      self.target = self.pathtarget;
      self.message = null;
      G_UseTargets(self, self.activator);
      self.target = savetarget;
      self.message = savemessage;
    }

    if (!(self.spawnflags & 8)) return;

    func_clock_reset(self);

    if (self.spawnflags & 4) return;
  }

  self.nextthink = level.time + 1;
}

function func_clock_use(self: EdictT, _other: EdictT | null, activator: EdictT | null): void {
  if (!(self.spawnflags & 8)) self.use = null;
  if (self.activator) return;
  self.activator = activator;
  if (self.think) self.think(self);
}

export function SP_func_clock(self: EdictT): void {
  if (!self.target) {
    gi.dprintf(`${self.classname} with no target at ${vtos(self.s.origin)}\n`);
    G_FreeEdict(self);
    return;
  }

  if (self.spawnflags & 2 && !self.count) {
    gi.dprintf(`${self.classname} with no count at ${vtos(self.s.origin)}\n`);
    G_FreeEdict(self);
    return;
  }

  if (self.spawnflags & 1 && !self.count) self.count = 60 * 60;

  func_clock_reset(self);

  // C: `self->message = gi.TagMalloc (CLOCK_MESSAGE_SIZE, TAG_LEVEL);` --
  // TagMalloc is dropped from GameImports per PORTING.md ("Z_Malloc/...
  // -> plain allocation"); the zero-initialized fixed buffer becomes a
  // zero-length string (JS strings need no backing allocation). Reported
  // as a deviation: CLOCK_MESSAGE_SIZE itself is kept as the documented
  // field-width contract for func_clock_format_countdown, even though
  // nothing allocates against it anymore.
  self.message = "";
  void CLOCK_MESSAGE_SIZE;

  self.think = func_clock_think;

  if (self.spawnflags & 4) self.use = func_clock_use;
  else self.nextthink = level.time + 1;
}

//=================================================================================

function teleporter_touch(self: EdictT, other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  if (!other.client) return;
  const dest = self.target !== null ? G_Find(null, "targetname", self.target) : null;
  if (!dest) {
    gi.dprintf("Couldn't find destination\n");
    return;
  }

  // unlink to make sure it can't possibly interfere with KillBox
  gi.unlinkentity(other);

  VectorCopy(dest.s.origin, other.s.origin);
  VectorCopy(dest.s.origin, other.s.old_origin);
  other.s.origin[2] += 10;

  // clear the velocity and hold them in place briefly
  VectorClear(other.velocity);
  const client = other.client;
  if (client !== null) {
    client.ps.pmove.pm_time = 160 >> 3; // hold time
    client.ps.pmove.pm_flags |= PMF_TIME_TELEPORT;
  }

  // draw the teleport splash at source and on the player
  if (self.owner !== null) self.owner.s.event = EntityEventT.EV_PLAYER_TELEPORT;
  other.s.event = EntityEventT.EV_PLAYER_TELEPORT;

  // set angles
  if (client !== null) {
    for (let i = 0; i < 3; i++) {
      client.ps.pmove.delta_angles[i] = ANGLE2SHORT(dest.s.angles[i] - client.resp.cmd_angles[i]);
    }

    VectorClear(other.s.angles);
    VectorClear(client.ps.viewangles);
    VectorClear(client.v_angle);
  }

  // kill anything at the destination
  KillBox(other);

  gi.linkentity(other);
}

/*QUAKED misc_teleporter (1 0 0) (-32 -32 -24) (32 32 -16)
Stepping onto this disc will teleport players to the targeted misc_teleporter_dest object.
*/
export function SP_misc_teleporter(ent: EdictT): void {
  if (!ent.target) {
    gi.dprintf("teleporter without a target.\n");
    G_FreeEdict(ent);
    return;
  }

  gi.setmodel(ent, "models/objects/dmspot/tris.md2");
  ent.s.skinnum = 1;
  ent.s.effects = EF_TELEPORTER;
  ent.s.sound = gi.soundindex("world/amb10.wav");
  ent.solid = SolidT.SOLID_BBOX;

  VectorSet(ent.mins, -32, -32, -24);
  VectorSet(ent.maxs, 32, 32, -16);
  gi.linkentity(ent);

  const trig = G_Spawn();
  trig.touch = teleporter_touch;
  trig.solid = SolidT.SOLID_TRIGGER;
  trig.target = ent.target;
  trig.owner = ent;
  VectorCopy(ent.s.origin, trig.s.origin);
  VectorSet(trig.mins, -8, -8, 8);
  VectorSet(trig.maxs, 8, 8, 24);
  gi.linkentity(trig);
}

/*QUAKED misc_teleporter_dest (1 0 0) (-32 -32 -24) (32 32 -16)
Point teleporters at these.
*/
export function SP_misc_teleporter_dest(ent: EdictT): void {
  // lmctf60: bit 1 skips the visible pad model, bit 2 skips making the
  // destination solid (both new spawnflags vs. ctf's unconditional version).
  if (!(ent.spawnflags & 1)) gi.setmodel(ent, "models/objects/dmspot/tris.md2");

  ent.s.skinnum = 0;

  if (!(ent.spawnflags & 2)) {
    ent.solid = SolidT.SOLID_BBOX;
    //	ent.s.effects |= EF_FLIES;
  }
  VectorSet(ent.mins, -32, -32, -24);
  VectorSet(ent.maxs, 32, 32, -16);
  gi.linkentity(ent);
}
