// g_weapon.c

import {
  AngleVectors,
  crandom,
  random,
  type Vec3,
  vec3,
  vec3_origin,
  VectorAdd,
  VectorClear,
  VectorCompare,
  VectorCopy,
  VectorLength,
  VectorMA,
  VectorNormalize,
  VectorScale,
  VectorSet,
  VectorSubtract,
} from "../shared/math";
import {
  ATTN_NORM,
  CHAN_VOICE,
  CHAN_WEAPON,
  CONTENTS_DEADMONSTER,
  CONTENTS_LAVA,
  CONTENTS_MONSTER,
  CONTENTS_SLIME,
  CONTENTS_SOLID,
  CONTENTS_WATER,
  type CplaneT,
  type CsurfaceT,
  EF_ANIM_ALLFAST,
  EF_BFG,
  EF_GRENADE,
  EF_PLASMA,
  EF_ROCKET,
  MASK_SHOT,
  MASK_WATER,
  MulticastT,
  MZ_BLUEHYPERBLASTER,
  RF_BEAM,
  RF_FULLBRIGHT,
  RF_TRANSLUCENT,
  SPLASH_BLUE_WATER,
  SPLASH_BROWN_WATER,
  SPLASH_LAVA,
  SPLASH_SLIME,
  SPLASH_UNKNOWN,
  SURF_FLOWING,
  SURF_SKY,
  SURF_TRANS33,
  SURF_TRANS66,
  SURF_WARP,
  CVAR_SERVERINFO,
  TempEventT,
} from "../shared/q_shared";
import { infront, visible } from "./g_ai";
import { CanDamage, T_Damage, T_RadiusDamage } from "./g_combat";
import { type Edict, type GTraceT, SolidT, SVF_MONSTER, SVF_NOCLIENT, SVF_PROJECTILE } from "./game";
import { findradius, G_FreeEdict, G_SetMovedir, G_Spawn, vectoangles } from "./g_utils";
import {
  AI_MEDIC,
  DAMAGE_BULLET,
  DAMAGE_ENERGY,
  DAMAGE_NO_KNOCKBACK,
  DAMAGE_RADIUS,
  type EdictT,
  FL_IMMUNE_LASER,
  FRAMETIME,
  g_edicts,
  gameCvars,
  gi,
  level,
  MOD_BFG_BLAST,
  MOD_BFG_EFFECT,
  MOD_BFG_LASER,
  MOD_BLASTER,
  MOD_G_SPLASH,
  MOD_GRENADE,
  MOD_HANDGRENADE,
  MOD_HELD_GRENADE,
  MOD_HG_SPLASH,
  MOD_PHALANX,
  MOD_RIPPER,
  MOD_HIT,
  MOD_HYPERBLASTER,
  MOD_R_SPLASH,
  MOD_RAILGUN,
  MOD_ROCKET,
  MOD_TARGET_LASER,
  MovetypeT,
  PNOISE_IMPACT,
  svc_muzzleflash2,
  svc_temp_entity,
} from "./g_local";
import { PlayerNoise } from "./p_weapon";

import { ThrowDebris } from "./g_misc";

// Recovers the game-private EdictT from a trace's game-visible `Edict`, per
// PORTING.md's EDICT_NUM idiom (`g_edicts[ent.s.number]`, never a cast); NULL
// (nothing hit) falls back to the world edict the same way g_phys.ts's
// traceEdict does.
function traceEdict(ent: Edict | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

// C dereferences `ent->owner` unconditionally in every touch/think handler
// below; every real call site sets `owner` to the firing entity immediately
// after G_Spawn(), so this narrows a "always actually set" nullable field
// with a thrown error instead of an unchecked deref, per this port's
// established precedent (see g_combat.ts's CheckArmor).
function requireOwner(ent: EdictT): EdictT {
  if (ent.owner === null) {
    throw new Error("owner is null (C dereferences it unconditionally here)");
  }
  return ent.owner;
}

// ctf/g_ctf.h: `extern cvar_t *ctf;` -- see src/ctf/g_main.ts's ctfCvar()
// comment for why this re-fetches via gi.cvar() instead of importing the
// module-local CvarT that g_ctf.ts's CTFInit() registers.
function ctfCvarValue(): number {
  const c = gi.cvar("ctf", "1", CVAR_SERVERINFO);
  return c === null ? 0 : c.value;
}

function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

/*
=================
check_dodge

This is a support routine used when a client is firing
a non-instant attack weapon.  It checks to see if a
monster's dodge function should be called.
=================
*/
function check_dodge(self: EdictT, start: Vec3, dir: Vec3, speed: number): void {
  // easy mode only ducks one quarter the time
  const skill = gameCvars.skill === null ? 0 : gameCvars.skill.value;
  if (skill === 0) {
    if (random() > 0.25) return;
  }

  const end = vec3();
  VectorMA(start, 8192, dir, end);
  const tr = gi.trace(start, null, null, end, self, MASK_SHOT);
  if (tr.ent !== null) {
    const hit = traceEdict(tr.ent);
    if (
      (hit.svflags & SVF_MONSTER) !== 0 &&
      hit.health > 0 &&
      hit.monsterinfo.dodge !== null &&
      infront(hit, self)
    ) {
      const v = vec3();
      VectorSubtract(tr.endpos, start, v);
      const eta = (VectorLength(v) - hit.maxs[0]) / speed;
      // RERELEASE CONTENT PORT: dodge now takes the trace that triggered
      // it (see MonsterInfoT.dodge in g_local.ts). Vanilla's own dodge
      // handlers ignore the extra argument; the ported rerelease
      // M_MonsterDodge reads it to choose between ducking and sidestepping.
      hit.monsterinfo.dodge(hit, self, eta, tr);
    }
  }
}

/*
=================
fire_hit

Used for all impact (hit/punch/slash) attacks
=================
*/
export function fire_hit(self: EdictT, aim: Vec3, damage: number, kick: number): boolean {
  // C dereferences self->enemy unconditionally; every real caller sets it
  // first (see g_combat.ts's CheckArmor precedent for this port's idiom).
  const enemy = self.enemy;
  if (enemy === null) {
    throw new Error("fire_hit: self.enemy is null (C dereferences self->enemy unconditionally)");
  }

  // see if enemy is in range
  const dir = vec3();
  VectorSubtract(enemy.s.origin, self.s.origin, dir);
  let range = VectorLength(dir);
  if (range > aim[0]) return false;

  if (aim[1] > self.mins[0] && aim[1] < self.maxs[0]) {
    // the hit is straight on so back the range up to the edge of their bbox
    range -= enemy.maxs[0];
  } else {
    // this is a side hit so adjust the "right" value out to the edge of their bbox
    if (aim[1] < 0) aim[1] = enemy.mins[0];
    else aim[1] = enemy.maxs[0];
  }

  const point = vec3();
  VectorMA(self.s.origin, range, dir, point);

  const tr = gi.trace(self.s.origin, null, null, point, self, MASK_SHOT);
  let hitEnt = traceEdict(tr.ent);
  if (tr.fraction < 1) {
    if (!hitEnt.takedamage) return false;
    // if it will hit any client/monster then hit the one we wanted to hit
    if ((hitEnt.svflags & SVF_MONSTER) !== 0 || hitEnt.client !== null) {
      hitEnt = enemy;
    }
  }

  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(self.s.angles, forward, right, up);
  VectorMA(self.s.origin, range, forward, point);
  VectorMA(point, aim[1], right, point);
  VectorMA(point, aim[2], up, point);
  VectorSubtract(point, enemy.s.origin, dir);

  // do the damage
  T_Damage(hitEnt, self, self, dir, point, vec3_origin, damage, (kick / 2) | 0, DAMAGE_NO_KNOCKBACK, MOD_HIT);

  if ((hitEnt.svflags & SVF_MONSTER) === 0 && hitEnt.client === null) return false;

  // do our special form of knockback here
  const v = vec3();
  VectorMA(enemy.absmin, 0.5, enemy.size, v);
  VectorSubtract(v, point, v);
  VectorNormalize(v);
  VectorMA(enemy.velocity, kick, v, enemy.velocity);
  if (enemy.velocity[2] > 0) enemy.groundentity = null;
  return true;
}

/*
=================
fire_lead

This is an internal support routine used for bullet/pellet based weapons.
=================
*/
function fire_lead(
  self: EdictT,
  start: Vec3,
  aimdir: Vec3,
  damage: number,
  kick: number,
  te_impact: number,
  hspread: number,
  vspread: number,
  mod: number,
): void {
  const water_start = vec3();
  let water = false;
  let content_mask = MASK_SHOT | MASK_WATER;

  let tr = gi.trace(self.s.origin, null, null, start, self, MASK_SHOT);
  if (!(tr.fraction < 1.0)) {
    const dir = vec3();
    vectoangles(aimdir, dir);
    const forward = vec3();
    const right = vec3();
    const up = vec3();
    AngleVectors(dir, forward, right, up);

    let r = crandom() * hspread;
    let u = crandom() * vspread;
    const end = vec3();
    VectorMA(start, 8192, forward, end);
    VectorMA(end, r, right, end);
    VectorMA(end, u, up, end);

    if (gi.pointcontents(start) & MASK_WATER) {
      water = true;
      VectorCopy(start, water_start);
      content_mask &= ~MASK_WATER;
    }

    tr = gi.trace(start, null, null, end, self, content_mask);

    // see if we hit water
    if (tr.contents & MASK_WATER) {
      let color: number;

      water = true;
      VectorCopy(tr.endpos, water_start);

      if (!VectorCompare(start, tr.endpos)) {
        if (tr.contents & CONTENTS_WATER) {
          if (tr.surface !== null && tr.surface.name === "*brwater") color = SPLASH_BROWN_WATER;
          else color = SPLASH_BLUE_WATER;
        } else if (tr.contents & CONTENTS_SLIME) {
          color = SPLASH_SLIME;
        } else if (tr.contents & CONTENTS_LAVA) {
          color = SPLASH_LAVA;
        } else {
          color = SPLASH_UNKNOWN;
        }

        if (color !== SPLASH_UNKNOWN) {
          gi.WriteByte(svc_temp_entity);
          gi.WriteByte(TempEventT.TE_SPLASH);
          gi.WriteByte(8);
          gi.WritePosition(tr.endpos);
          gi.WriteDir(tr.plane.normal);
          gi.WriteByte(color);
          gi.multicast(tr.endpos, MulticastT.MULTICAST_PVS);
        }

        // change bullet's course when it enters water
        VectorSubtract(end, start, dir);
        vectoangles(dir, dir);
        AngleVectors(dir, forward, right, up);
        r = crandom() * hspread * 2;
        u = crandom() * vspread * 2;
        VectorMA(water_start, 8192, forward, end);
        VectorMA(end, r, right, end);
        VectorMA(end, u, up, end);
      }

      // re-trace ignoring water this time
      tr = gi.trace(water_start, null, null, end, self, MASK_SHOT);
    }
  }

  // send gun puff / flash
  // (a NULL surface is treated as "not sky" -- C's strncmp would deref a
  // NULL surface->name, which cannot happen through non-BSP collision in
  // practice; this port skips the sky-name check instead of crashing)
  if (!(tr.surface !== null && tr.surface.flags & SURF_SKY)) {
    if (tr.fraction < 1.0) {
      const hitEnt = traceEdict(tr.ent);
      if (hitEnt.takedamage) {
        T_Damage(hitEnt, self, self, aimdir, tr.endpos, tr.plane.normal, damage, kick, DAMAGE_BULLET, mod);
      } else {
        if (tr.surface === null || tr.surface.name.slice(0, 3) !== "sky") {
          gi.WriteByte(svc_temp_entity);
          gi.WriteByte(te_impact);
          gi.WritePosition(tr.endpos);
          gi.WriteDir(tr.plane.normal);
          gi.multicast(tr.endpos, MulticastT.MULTICAST_PVS);

          if (self.client !== null) PlayerNoise(self, tr.endpos, PNOISE_IMPACT);
        }
      }
    }
  }

  // if went through water, determine where the end and make a bubble trail
  if (water) {
    const dir = vec3();
    VectorSubtract(tr.endpos, water_start, dir);
    VectorNormalize(dir);
    const pos = vec3();
    VectorMA(tr.endpos, -2, dir, pos);
    if (gi.pointcontents(pos) & MASK_WATER) {
      VectorCopy(pos, tr.endpos);
    } else {
      tr = gi.trace(pos, null, null, water_start, tr.ent, MASK_WATER);
    }

    VectorAdd(water_start, tr.endpos, pos);
    VectorScale(pos, 0.5, pos);

    gi.WriteByte(svc_temp_entity);
    gi.WriteByte(TempEventT.TE_BUBBLETRAIL);
    gi.WritePosition(water_start);
    gi.WritePosition(tr.endpos);
    gi.multicast(pos, MulticastT.MULTICAST_PVS);
  }
}

/*
=================
fire_bullet

Fires a single round.  Used for machinegun and chaingun.  Would be fine for
pistols, rifles, etc....
=================
*/
export function fire_bullet(
  self: EdictT,
  start: Vec3,
  aimdir: Vec3,
  damage: number,
  kick: number,
  hspread: number,
  vspread: number,
  mod: number,
): void {
  fire_lead(self, start, aimdir, damage, kick, TempEventT.TE_GUNSHOT, hspread, vspread, mod);
}

/*
=================
fire_shotgun

Shoots shotgun pellets.  Used by shotgun and super shotgun.
=================
*/
export function fire_shotgun(
  self: EdictT,
  start: Vec3,
  aimdir: Vec3,
  damage: number,
  kick: number,
  hspread: number,
  vspread: number,
  count: number,
  mod: number,
): void {
  for (let i = 0; i < count; i++) {
    fire_lead(self, start, aimdir, damage, kick, TempEventT.TE_SHOTGUN, hspread, vspread, mod);
  }
}

/*
=================
fire_blaster

Fires a single blaster bolt.  Used by the blaster and hyper blaster.
=================
*/
export function blaster_touch(self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  if (other === self.owner) return;

  if (surf !== null && surf.flags & SURF_SKY) {
    G_FreeEdict(self);
    return;
  }

  const owner = requireOwner(self);
  if (owner.client !== null) PlayerNoise(owner, self.s.origin, PNOISE_IMPACT);

  // plane can be NULL here (fire_blaster's own immediate self-trace call
  // passes NULL); C dereferences plane->normal unconditionally in the
  // takedamage branch below, a latent null-deref in the original that
  // TypeScript cannot express -- falls back to vec3_origin, matching the
  // existing NULL guard already present in the sibling (non-takedamage)
  // branch.
  const normal = plane === null ? vec3_origin : plane.normal;

  if (other.takedamage) {
    const mod = self.spawnflags & 1 ? MOD_HYPERBLASTER : MOD_BLASTER;
    T_Damage(other, self, owner, self.velocity, self.s.origin, normal, self.dmg, 1, DAMAGE_ENERGY, mod);
  } else {
    gi.WriteByte(svc_temp_entity);
    gi.WriteByte(TempEventT.TE_BLASTER);
    gi.WritePosition(self.s.origin);
    gi.WriteDir(normal);
    gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);
  }

  G_FreeEdict(self);
}

export function fire_blaster(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  speed: number,
  effect: number,
  hyper: boolean,
): void {
  VectorNormalize(dir);

  const bolt = G_Spawn();
  bolt.svflags = SVF_PROJECTILE; // special net code is used for projectiles
  VectorCopy(start, bolt.s.origin);
  VectorCopy(start, bolt.s.old_origin);
  vectoangles(dir, bolt.s.angles);
  VectorScale(dir, speed, bolt.velocity);
  bolt.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  bolt.clipmask = MASK_SHOT;
  bolt.solid = SolidT.SOLID_BBOX;
  bolt.s.effects |= effect;
  VectorClear(bolt.mins);
  VectorClear(bolt.maxs);
  bolt.s.modelindex = gi.modelindex("models/objects/laser/tris.md2");
  bolt.s.sound = gi.soundindex("misc/lasfly.wav");
  bolt.owner = self;
  bolt.touch = blaster_touch;
  bolt.nextthink = level.time + 2;
  bolt.think = G_FreeEdict;
  bolt.dmg = damage;
  bolt.classname = "bolt";
  if (hyper) bolt.spawnflags = 1;
  gi.linkentity(bolt);

  if (self.client !== null) check_dodge(self, bolt.s.origin, dir, speed);

  const tr = gi.trace(self.s.origin, null, null, bolt.s.origin, bolt, MASK_SHOT);
  if (tr.fraction < 1.0) {
    VectorMA(bolt.s.origin, -10, dir, bolt.s.origin);
    if (bolt.touch) bolt.touch(bolt, traceEdict(tr.ent), null, null);
  }
}

/*
=================
fire_grenade
=================
*/
export function Grenade_Explode(ent: EdictT): void {
  const owner = requireOwner(ent);
  if (owner.client !== null) PlayerNoise(owner, ent.s.origin, PNOISE_IMPACT);

  //FIXME: if we are onground then raise our Z just a bit since we are a point?
  if (ent.enemy !== null) {
    const v = vec3();
    const dir = vec3();

    VectorAdd(ent.enemy.mins, ent.enemy.maxs, v);
    VectorMA(ent.enemy.s.origin, 0.5, v, v);
    VectorSubtract(ent.s.origin, v, v);
    const points = ent.dmg - 0.5 * VectorLength(v);
    VectorSubtract(ent.enemy.s.origin, ent.s.origin, dir);
    let mod: number;
    if (ent.spawnflags & 1) mod = MOD_HANDGRENADE;
    else mod = MOD_GRENADE;
    T_Damage(ent.enemy, ent, owner, dir, ent.s.origin, vec3_origin, points | 0, points | 0, DAMAGE_RADIUS, mod);
  }

  let mod: number;
  if (ent.spawnflags & 2) mod = MOD_HELD_GRENADE;
  else if (ent.spawnflags & 1) mod = MOD_HG_SPLASH;
  else mod = MOD_G_SPLASH;
  T_RadiusDamage(ent, owner, ent.dmg, ent.enemy, ent.dmg_radius, mod);

  const origin = vec3();
  VectorMA(ent.s.origin, -0.02, ent.velocity, origin);
  gi.WriteByte(svc_temp_entity);
  if (ent.waterlevel) {
    if (ent.groundentity !== null) gi.WriteByte(TempEventT.TE_GRENADE_EXPLOSION_WATER);
    else gi.WriteByte(TempEventT.TE_ROCKET_EXPLOSION_WATER);
  } else {
    if (ent.groundentity !== null) gi.WriteByte(TempEventT.TE_GRENADE_EXPLOSION);
    else gi.WriteByte(TempEventT.TE_ROCKET_EXPLOSION);
  }
  gi.WritePosition(origin);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PHS);

  G_FreeEdict(ent);
}

export function Grenade_Touch(ent: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  if (other === ent.owner) return;

  if (surf !== null && surf.flags & SURF_SKY) {
    G_FreeEdict(ent);
    return;
  }

  if (!other.takedamage) {
    if (ent.spawnflags & 1) {
      if (random() > 0.5) gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/hgrenb1a.wav"), 1, ATTN_NORM, 0);
      else gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/hgrenb2a.wav"), 1, ATTN_NORM, 0);
    } else {
      gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/grenlb1b.wav"), 1, ATTN_NORM, 0);
    }
    return;
  }

  ent.enemy = other;
  Grenade_Explode(ent);
}

export function fire_grenade(
  self: EdictT,
  start: Vec3,
  aimdir: Vec3,
  damage: number,
  speed: number,
  timer: number,
  damage_radius: number,
): void {
  const dir = vec3();
  vectoangles(aimdir, dir);
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(dir, forward, right, up);

  const grenade = G_Spawn();
  VectorCopy(start, grenade.s.origin);
  VectorScale(aimdir, speed, grenade.velocity);
  VectorMA(grenade.velocity, 200 + crandom() * 10.0, up, grenade.velocity);
  VectorMA(grenade.velocity, crandom() * 10.0, right, grenade.velocity);
  grenade.avelocity[0] = 300;
  grenade.avelocity[1] = 300;
  grenade.avelocity[2] = 300;
  grenade.movetype = MovetypeT.MOVETYPE_BOUNCE;
  grenade.clipmask = MASK_SHOT;
  grenade.solid = SolidT.SOLID_BBOX;
  grenade.s.effects |= EF_GRENADE;
  VectorClear(grenade.mins);
  VectorClear(grenade.maxs);
  grenade.s.modelindex = gi.modelindex("models/objects/grenade/tris.md2");
  grenade.owner = self;
  grenade.touch = Grenade_Touch;
  grenade.nextthink = level.time + timer;
  grenade.think = Grenade_Explode;
  grenade.dmg = damage;
  grenade.dmg_radius = damage_radius;
  grenade.classname = "grenade";

  gi.linkentity(grenade);
}

export function fire_grenade2(
  self: EdictT,
  start: Vec3,
  aimdir: Vec3,
  damage: number,
  speed: number,
  timer: number,
  damage_radius: number,
  held: boolean,
): void {
  const dir = vec3();
  vectoangles(aimdir, dir);
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(dir, forward, right, up);

  const grenade = G_Spawn();
  VectorCopy(start, grenade.s.origin);
  VectorScale(aimdir, speed, grenade.velocity);
  VectorMA(grenade.velocity, 200 + crandom() * 10.0, up, grenade.velocity);
  VectorMA(grenade.velocity, crandom() * 10.0, right, grenade.velocity);
  grenade.avelocity[0] = 300;
  grenade.avelocity[1] = 300;
  grenade.avelocity[2] = 300;
  grenade.movetype = MovetypeT.MOVETYPE_BOUNCE;
  grenade.clipmask = MASK_SHOT;
  grenade.solid = SolidT.SOLID_BBOX;
  grenade.s.effects |= EF_GRENADE;
  VectorClear(grenade.mins);
  VectorClear(grenade.maxs);
  grenade.s.modelindex = gi.modelindex("models/objects/grenade2/tris.md2");
  grenade.owner = self;
  grenade.touch = Grenade_Touch;
  grenade.nextthink = level.time + timer;
  grenade.think = Grenade_Explode;
  grenade.dmg = damage;
  grenade.dmg_radius = damage_radius;
  grenade.classname = "hgrenade";
  if (held) grenade.spawnflags = 3;
  else grenade.spawnflags = 1;
  grenade.s.sound = gi.soundindex("weapons/hgrenc1b.wav");

  if (timer <= 0.0) {
    Grenade_Explode(grenade);
  } else {
    gi.sound(self, CHAN_WEAPON, gi.soundindex("weapons/hgrent1a.wav"), 1, ATTN_NORM, 0);
    gi.linkentity(grenade);
  }
}

/*
=================
fire_rocket
=================
*/
export function rocket_touch(ent: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  if (other === ent.owner) return;

  if (surf !== null && surf.flags & SURF_SKY) {
    G_FreeEdict(ent);
    return;
  }

  const owner = requireOwner(ent);
  if (owner.client !== null) PlayerNoise(owner, ent.s.origin, PNOISE_IMPACT);

  // calculate position for the explosion entity
  const origin = vec3();
  VectorMA(ent.s.origin, -0.02, ent.velocity, origin);

  // plane is always non-NULL here in practice (rocket_touch is only ever
  // reached via SV_Impact, unlike blaster_touch's extra direct call site);
  // guarded the same way regardless, per this port's null-deref idiom.
  const normal = plane === null ? vec3_origin : plane.normal;

  if (other.takedamage) {
    T_Damage(other, ent, owner, ent.velocity, ent.s.origin, normal, ent.dmg, 0, 0, MOD_ROCKET);
  } else {
    // don't throw any debris in net games
    const deathmatch = gameCvars.deathmatch === null ? 0 : gameCvars.deathmatch.value;
    const coop = gameCvars.coop === null ? 0 : gameCvars.coop.value;
    if (!deathmatch && !coop) {
      if (surf !== null && !(surf.flags & (SURF_WARP | SURF_TRANS33 | SURF_TRANS66 | SURF_FLOWING))) {
        // `rand() % 5` -- no integer rand() helper exists in math.ts (only
        // random()/crandom()); approximated with an equivalent uniform pick.
        let n = Math.floor(Math.random() * 5);
        while (n--) {
          ThrowDebris(ent, "models/objects/debris2/tris.md2", 2, ent.s.origin);
        }
      }
    }
  }

  T_RadiusDamage(ent, owner, ent.radius_dmg, other, ent.dmg_radius, MOD_R_SPLASH);

  gi.WriteByte(svc_temp_entity);
  if (ent.waterlevel) gi.WriteByte(TempEventT.TE_ROCKET_EXPLOSION_WATER);
  else gi.WriteByte(TempEventT.TE_ROCKET_EXPLOSION);
  gi.WritePosition(origin);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PHS);

  G_FreeEdict(ent);
}

export function fire_rocket(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  speed: number,
  damage_radius: number,
  radius_damage: number,
): void {
  const rocket = G_Spawn();
  VectorCopy(start, rocket.s.origin);
  VectorCopy(dir, rocket.movedir);
  vectoangles(dir, rocket.s.angles);
  VectorScale(dir, speed, rocket.velocity);
  rocket.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  rocket.clipmask = MASK_SHOT;
  rocket.solid = SolidT.SOLID_BBOX;
  rocket.s.effects |= EF_ROCKET;
  VectorClear(rocket.mins);
  VectorClear(rocket.maxs);
  rocket.s.modelindex = gi.modelindex("models/objects/rocket/tris.md2");
  rocket.owner = self;
  rocket.touch = rocket_touch;
  rocket.nextthink = level.time + 8000 / speed;
  rocket.think = G_FreeEdict;
  rocket.dmg = damage;
  rocket.radius_dmg = radius_damage;
  rocket.dmg_radius = damage_radius;
  rocket.s.sound = gi.soundindex("weapons/rockfly.wav");
  rocket.classname = "rocket";

  if (self.client !== null) check_dodge(self, rocket.s.origin, dir, speed);

  gi.linkentity(rocket);
}

/*
=================
fire_rail
=================
*/
export function fire_rail(self: EdictT, start: Vec3, aimdir: Vec3, damage: number, kick: number): void {
  const end = vec3();
  VectorMA(start, 8192, aimdir, end);
  const from = vec3();
  VectorCopy(start, from);
  let ignore: EdictT | null = self;
  let water = false;
  let mask = MASK_SHOT | CONTENTS_SLIME | CONTENTS_LAVA;

  let tr = gi.trace(from, null, null, end, ignore, mask);
  for (;;) {
    if (tr.contents & (CONTENTS_SLIME | CONTENTS_LAVA)) {
      mask &= ~(CONTENTS_SLIME | CONTENTS_LAVA);
      water = true;
    } else {
      const hit = traceEdict(tr.ent);
      // ZOID -- added so rail goes through SOLID_BBOX entities (gibs, etc)
      if ((hit.svflags & SVF_MONSTER) !== 0 || hit.client !== null || hit.solid === SolidT.SOLID_BBOX) ignore = hit;
      else ignore = null;

      if (hit !== self && hit.takedamage) {
        T_Damage(hit, self, self, aimdir, tr.endpos, tr.plane.normal, damage, kick, 0, MOD_RAILGUN);
      }
    }

    VectorCopy(tr.endpos, from);

    if (ignore === null) break;
    tr = gi.trace(from, null, null, end, ignore, mask);
  }

  // send gun puff / flash
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_RAILTRAIL);
  gi.WritePosition(start);
  gi.WritePosition(tr.endpos);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PHS);
  if (water) {
    gi.WriteByte(svc_temp_entity);
    gi.WriteByte(TempEventT.TE_RAILTRAIL);
    gi.WritePosition(start);
    gi.WritePosition(tr.endpos);
    gi.multicast(tr.endpos, MulticastT.MULTICAST_PHS);
  }

  if (self.client !== null) PlayerNoise(self, tr.endpos, PNOISE_IMPACT);
}

/*
=================
fire_bfg
=================
*/
export function bfg_explode(self: EdictT): void {
  if (self.s.frame === 0) {
    // the BFG effect
    const owner = requireOwner(self);
    let ent: EdictT | null = null;
    for (;;) {
      ent = findradius(ent, self.s.origin, self.dmg_radius);
      if (ent === null) break;
      if (!ent.takedamage) continue;
      if (ent === self.owner) continue;
      if (!CanDamage(ent, self)) continue;
      if (!CanDamage(ent, owner)) continue;

      const v = vec3();
      VectorAdd(ent.mins, ent.maxs, v);
      VectorMA(ent.s.origin, 0.5, v, v);
      VectorSubtract(self.s.origin, v, v);
      const dist = VectorLength(v);
      let points = self.radius_dmg * (1.0 - Math.sqrt(dist / self.dmg_radius));
      if (ent === self.owner) points = points * 0.5;

      gi.WriteByte(svc_temp_entity);
      gi.WriteByte(TempEventT.TE_BFG_EXPLOSION);
      gi.WritePosition(ent.s.origin);
      gi.multicast(ent.s.origin, MulticastT.MULTICAST_PHS);
      T_Damage(ent, self, owner, self.velocity, ent.s.origin, vec3_origin, points | 0, 0, DAMAGE_ENERGY, MOD_BFG_EFFECT);
    }
  }

  self.nextthink = level.time + FRAMETIME;
  self.s.frame++;
  if (self.s.frame === 5) self.think = G_FreeEdict;
}

export function bfg_touch(self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  if (other === self.owner) return;

  if (surf !== null && surf.flags & SURF_SKY) {
    G_FreeEdict(self);
    return;
  }

  const owner = requireOwner(self);
  if (owner.client !== null) PlayerNoise(owner, self.s.origin, PNOISE_IMPACT);

  const normal = plane === null ? vec3_origin : plane.normal;

  // core explosion - prevents firing it into the wall/floor
  if (other.takedamage) T_Damage(other, self, owner, self.velocity, self.s.origin, normal, 200, 0, 0, MOD_BFG_BLAST);
  T_RadiusDamage(self, owner, 200, other, 100, MOD_BFG_BLAST);

  gi.sound(self, CHAN_VOICE, gi.soundindex("weapons/bfg__x1b.wav"), 1, ATTN_NORM, 0);
  self.solid = SolidT.SOLID_NOT;
  self.touch = null;
  VectorMA(self.s.origin, -1 * FRAMETIME, self.velocity, self.s.origin);
  VectorClear(self.velocity);
  self.s.modelindex = gi.modelindex("sprites/s_bfg3.sp2");
  self.s.frame = 0;
  self.s.sound = 0;
  self.s.effects &= ~EF_ANIM_ALLFAST;
  self.think = bfg_explode;
  self.nextthink = level.time + FRAMETIME;
  self.enemy = other;

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_BFG_BIGEXPLOSION);
  gi.WritePosition(self.s.origin);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);
}

export function bfg_think(self: EdictT): void {
  const deathmatch = gameCvars.deathmatch === null ? 0 : gameCvars.deathmatch.value;
  const dmg = deathmatch ? 5 : 10;
  const owner = requireOwner(self);

  let ent: EdictT | null = null;
  for (;;) {
    ent = findradius(ent, self.s.origin, 256);
    if (ent === null) break;

    if (ent === self) continue;
    if (ent === self.owner) continue;
    if (!ent.takedamage) continue;
    if ((ent.svflags & SVF_MONSTER) === 0 && ent.client === null && ent.classname !== "misc_explobox") continue;

    //ZOID
    // don't target players in CTF
    if (ctfCvarValue() !== 0 && ent.client !== null && owner.client !== null && ent.client.resp.ctf_team === owner.client.resp.ctf_team) continue;
    //ZOID

    const point = vec3();
    VectorMA(ent.absmin, 0.5, ent.size, point);

    const dir = vec3();
    VectorSubtract(point, self.s.origin, dir);
    VectorNormalize(dir);

    let ignore: EdictT | null = self;
    const start = vec3();
    VectorCopy(self.s.origin, start);
    const end = vec3();
    VectorMA(start, 2048, dir, end);

    let tr = gi.trace(start, null, null, end, ignore, CONTENTS_SOLID | CONTENTS_MONSTER | CONTENTS_DEADMONSTER);
    for (;;) {
      if (tr.ent === null) break;

      const hit = traceEdict(tr.ent);

      // hurt it if we can
      if (hit.takedamage && (hit.flags & FL_IMMUNE_LASER) === 0 && hit !== owner) {
        T_Damage(hit, self, owner, dir, tr.endpos, vec3_origin, dmg, 1, DAMAGE_ENERGY, MOD_BFG_LASER);
      }

      // if we hit something that's not a monster or player we're done
      if ((hit.svflags & SVF_MONSTER) === 0 && hit.client === null) {
        gi.WriteByte(svc_temp_entity);
        gi.WriteByte(TempEventT.TE_LASER_SPARKS);
        gi.WriteByte(4);
        gi.WritePosition(tr.endpos);
        gi.WriteDir(tr.plane.normal);
        gi.WriteByte(self.s.skinnum);
        gi.multicast(tr.endpos, MulticastT.MULTICAST_PVS);
        break;
      }

      ignore = hit;
      VectorCopy(tr.endpos, start);
      tr = gi.trace(start, null, null, end, ignore, CONTENTS_SOLID | CONTENTS_MONSTER | CONTENTS_DEADMONSTER);
    }

    gi.WriteByte(svc_temp_entity);
    gi.WriteByte(TempEventT.TE_BFG_LASER);
    gi.WritePosition(self.s.origin);
    gi.WritePosition(tr.endpos);
    gi.multicast(self.s.origin, MulticastT.MULTICAST_PHS);
  }

  self.nextthink = level.time + FRAMETIME;
}

export function fire_bfg(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  speed: number,
  damage_radius: number,
): void {
  const bfg = G_Spawn();
  VectorCopy(start, bfg.s.origin);
  VectorCopy(dir, bfg.movedir);
  vectoangles(dir, bfg.s.angles);
  VectorScale(dir, speed, bfg.velocity);
  bfg.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  bfg.clipmask = MASK_SHOT;
  bfg.solid = SolidT.SOLID_BBOX;
  bfg.s.effects |= EF_BFG | EF_ANIM_ALLFAST;
  VectorClear(bfg.mins);
  VectorClear(bfg.maxs);
  bfg.s.modelindex = gi.modelindex("sprites/s_bfg1.sp2");
  bfg.owner = self;
  bfg.touch = bfg_touch;
  bfg.nextthink = level.time + 8000 / speed;
  bfg.think = G_FreeEdict;
  bfg.radius_dmg = damage;
  bfg.dmg_radius = damage_radius;
  bfg.classname = "bfg blast";
  bfg.s.sound = gi.soundindex("weapons/bfg__l1a.wav");

  bfg.think = bfg_think;
  bfg.nextthink = level.time + FRAMETIME;
  bfg.teammaster = bfg;
  bfg.teamchain = null;

  if (self.client !== null) check_dodge(self, bfg.s.origin, dir, speed);

  gi.linkentity(bfg);
}

// xatrix/g_weapon.c: `// RAFAEL` -- fire_blueblaster is a copy of
// fire_blaster wired to blaster_touch, minus the hyper/spawnflags dance
// (never used with hyper=true at any xatrix call site).
export function fire_blueblaster(self: EdictT, start: Vec3, dir: Vec3, damage: number, speed: number, effect: number): void {
  VectorNormalize(dir);

  const bolt = G_Spawn();
  VectorCopy(start, bolt.s.origin);
  VectorCopy(start, bolt.s.old_origin);
  vectoangles(dir, bolt.s.angles);
  VectorScale(dir, speed, bolt.velocity);
  bolt.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  bolt.clipmask = MASK_SHOT;
  bolt.solid = SolidT.SOLID_BBOX;
  bolt.s.effects |= effect;
  VectorClear(bolt.mins);
  VectorClear(bolt.maxs);

  bolt.s.modelindex = gi.modelindex("models/objects/blaser/tris.md2");
  bolt.s.sound = gi.soundindex("misc/lasfly.wav");
  bolt.owner = self;
  bolt.touch = blaster_touch;
  bolt.nextthink = level.time + 2;
  bolt.think = G_FreeEdict;
  bolt.dmg = damage;
  bolt.classname = "bolt";
  gi.linkentity(bolt);

  if (self.client !== null) check_dodge(self, bolt.s.origin, dir, speed);

  const tr = gi.trace(self.s.origin, null, null, bolt.s.origin, bolt, MASK_SHOT);
  if (tr.fraction < 1.0) {
    VectorMA(bolt.s.origin, -10, dir, bolt.s.origin);
    if (bolt.touch) bolt.touch(bolt, traceEdict(tr.ent), null, null);
  }
}

// xatrix/g_weapon.c: `// RAFAEL` -- fire_ionripper (RipperGun)

export function ionripper_sparks(self: EdictT): void {
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_WELDING_SPARKS);
  gi.WriteByte(0);
  gi.WritePosition(self.s.origin);
  gi.WriteDir(vec3_origin);
  gi.WriteByte(0xe4 + (Math.floor(Math.random() * 4) & 3));
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);

  G_FreeEdict(self);
}

export function ionripper_touch(self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  if (other === self.owner) return;

  if (surf !== null && surf.flags & SURF_SKY) {
    G_FreeEdict(self);
    return;
  }

  const owner = requireOwner(self);
  if (owner.client !== null) PlayerNoise(owner, self.s.origin, PNOISE_IMPACT);

  if (!other.takedamage) {
    return;
  }

  // C dereferences plane->normal unconditionally here; ionripper_touch is
  // only ever reached via SV_Impact (plane always non-NULL in practice) or
  // fire_ionripper's own immediate self-trace, which passes NULL -- same
  // null-deref idiom as blaster_touch/rocket_touch above.
  const normal = plane === null ? vec3_origin : plane.normal;
  T_Damage(other, self, owner, self.velocity, self.s.origin, normal, self.dmg, 1, DAMAGE_ENERGY, MOD_RIPPER);

  G_FreeEdict(self);
}

export function fire_ionripper(self: EdictT, start: Vec3, dir: Vec3, damage: number, speed: number, effect: number): void {
  VectorNormalize(dir);

  const ion = G_Spawn();
  VectorCopy(start, ion.s.origin);
  VectorCopy(start, ion.s.old_origin);
  vectoangles(dir, ion.s.angles);
  VectorScale(dir, speed, ion.velocity);

  // DEVIATION: xatrix/g_local.h's MovetypeT has a MOVETYPE_WALLBOUNCE value
  // (ionripper bounces off walls with backoff 2.0 and re-orients to its
  // velocity -- xatrix/g_phys.c's Xatrix delta in ClipVelocity/SV_Physics).
  // src/game/g_local.ts (owned by another agent, do-not-edit) has no such
  // enum member and src/game/g_phys.ts has no matching physics case, so
  // this substitutes the closest existing movetype, MOVETYPE_BOUNCE, until
  // MOVETYPE_WALLBOUNCE is added upstream -- see this agent's final report
  // for the exact g_local.ts/g_phys.ts declarations needed. Net effect:
  // the ripper blade settles on impact instead of bouncing off walls.
  ion.movetype = MovetypeT.MOVETYPE_BOUNCE;
  ion.clipmask = MASK_SHOT;
  ion.solid = SolidT.SOLID_BBOX;
  ion.s.effects |= effect;

  ion.s.renderfx |= RF_FULLBRIGHT;

  VectorClear(ion.mins);
  VectorClear(ion.maxs);
  ion.s.modelindex = gi.modelindex("models/objects/boomrang/tris.md2");
  ion.s.sound = gi.soundindex("misc/lasfly.wav");
  ion.owner = self;
  ion.touch = ionripper_touch;
  ion.nextthink = level.time + 3;
  ion.think = ionripper_sparks;
  ion.dmg = damage;
  ion.dmg_radius = 100;
  gi.linkentity(ion);

  if (self.client !== null) check_dodge(self, ion.s.origin, dir, speed);

  const tr = gi.trace(self.s.origin, null, null, ion.s.origin, ion, MASK_SHOT);
  if (tr.fraction < 1.0) {
    VectorMA(ion.s.origin, -10, dir, ion.s.origin);
    if (ion.touch) ion.touch(ion, traceEdict(tr.ent), null, null);
  }
}

// xatrix/g_weapon.c: `// RAFAEL` -- fire_heat (heat-seeking rocket)

export function heat_think(self: EdictT): void {
  let aquire: EdictT | null = null;
  let oldlen = 0;
  const vec = vec3();

  // acquire new target
  let target: EdictT | null = null;
  for (;;) {
    target = findradius(target, self.s.origin, 1024);
    if (target === null) break;

    if (self.owner === target) continue;
    // xatrix/g_weapon.c: `if (!target->svflags & SVF_MONSTER) continue;` --
    // operator-precedence bug in the C: `!` binds tighter than `&`, so this
    // is `(!target->svflags) & SVF_MONSTER` (0 or 1, ANDed against
    // SVF_MONSTER's 0x4 bit), which is always 0 -- the check never fires.
    // Preserved as a no-op per PORTING.md's bug-for-bug fidelity rule
    // rather than "fixing" it to `!(target.svflags & SVF_MONSTER)`.
    if (!target.client) continue;
    if (target.health <= 0) continue;
    if (!visible(self, target)) continue;
    if (!infront(self, target)) continue;

    VectorSubtract(self.s.origin, target.s.origin, vec);
    const len = VectorLength(vec);

    if (aquire === null || len < oldlen) {
      aquire = target;
      self.target_ent = aquire;
      oldlen = len;
    }
  }

  if (aquire !== null) {
    VectorSubtract(aquire.s.origin, self.s.origin, vec);
    vectoangles(vec, self.s.angles);

    VectorNormalize(vec);
    VectorCopy(vec, self.movedir);
    VectorScale(vec, 500, self.velocity);
  }

  self.nextthink = level.time + 0.1;
}

export function fire_heat(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  speed: number,
  damage_radius: number,
  radius_damage: number,
): void {
  const heat = G_Spawn();
  VectorCopy(start, heat.s.origin);
  VectorCopy(dir, heat.movedir);
  vectoangles(dir, heat.s.angles);
  VectorScale(dir, speed, heat.velocity);
  heat.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  heat.clipmask = MASK_SHOT;
  heat.solid = SolidT.SOLID_BBOX;
  heat.s.effects |= EF_ROCKET;
  VectorClear(heat.mins);
  VectorClear(heat.maxs);
  heat.s.modelindex = gi.modelindex("models/objects/rocket/tris.md2");
  heat.owner = self;
  heat.touch = rocket_touch;

  heat.nextthink = level.time + 0.1;
  heat.think = heat_think;

  heat.dmg = damage;
  heat.radius_dmg = radius_damage;
  heat.dmg_radius = damage_radius;
  heat.s.sound = gi.soundindex("weapons/rockfly.wav");

  if (self.client !== null) check_dodge(self, heat.s.origin, dir, speed);

  gi.linkentity(heat);
}

// xatrix/g_weapon.c: `// RAFAEL` -- fire_plasma (Phalanx). Needed here by
// m_gladb.ts's beta-gladiator ranged attack. Also the underlying
// projectile for the player-held Phalanx weapon (WEAP_PHALANX/MOD_PHALANX,
// item side owned by another agent in p_weapon.ts/g_items.ts) -- if that
// weapon needs firing, it can call this rather than duplicating it.

export function plasma_touch(ent: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  if (other === ent.owner) return;

  if (surf !== null && surf.flags & SURF_SKY) {
    G_FreeEdict(ent);
    return;
  }

  const owner = requireOwner(ent);
  if (owner.client !== null) PlayerNoise(owner, ent.s.origin, PNOISE_IMPACT);

  // calculate position for the explosion entity
  const origin = vec3();
  VectorMA(ent.s.origin, -0.02, ent.velocity, origin);

  const normal = plane === null ? vec3_origin : plane.normal;
  if (other.takedamage) {
    T_Damage(other, ent, owner, ent.velocity, ent.s.origin, normal, ent.dmg, 0, 0, MOD_PHALANX);
  }

  T_RadiusDamage(ent, owner, ent.radius_dmg, other, ent.dmg_radius, MOD_PHALANX);

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_PLASMA_EXPLOSION);
  gi.WritePosition(origin);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  G_FreeEdict(ent);
}

export function fire_plasma(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  speed: number,
  damage_radius: number,
  radius_damage: number,
): void {
  const plasma = G_Spawn();
  VectorCopy(start, plasma.s.origin);
  VectorCopy(dir, plasma.movedir);
  vectoangles(dir, plasma.s.angles);
  VectorScale(dir, speed, plasma.velocity);
  plasma.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  plasma.clipmask = MASK_SHOT;
  plasma.solid = SolidT.SOLID_BBOX;

  VectorClear(plasma.mins);
  VectorClear(plasma.maxs);

  plasma.owner = self;
  plasma.touch = plasma_touch;
  plasma.nextthink = level.time + 8000 / speed;
  plasma.think = G_FreeEdict;
  plasma.dmg = damage;
  plasma.radius_dmg = radius_damage;
  plasma.dmg_radius = damage_radius;
  plasma.s.sound = gi.soundindex("weapons/rockfly.wav");

  plasma.s.modelindex = gi.modelindex("sprites/s_photon.sp2");
  plasma.s.effects |= EF_PLASMA | EF_ANIM_ALLFAST;

  if (self.client !== null) check_dodge(self, plasma.s.origin, dir, speed);

  gi.linkentity(plasma);
}

// xatrix/g_monster.c: `// RAFAEL` block -- monster_fire_* wrappers for the
// three fire_* helpers above (muzzleflash2 network message on top of the
// projectile spawn), matching g_monster.ts's monster_fire_blaster idiom.

export function monster_fire_blueblaster(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  speed: number,
  flashtype: number,
  effect: number,
): void {
  fire_blueblaster(self, start, dir, damage, speed, effect);

  gi.WriteByte(svc_muzzleflash2);
  gi.WriteShort(g_edicts.indexOf(self));
  gi.WriteByte(MZ_BLUEHYPERBLASTER);
  gi.multicast(start, MulticastT.MULTICAST_PVS);
}

export function monster_fire_ionripper(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  speed: number,
  flashtype: number,
  effect: number,
): void {
  fire_ionripper(self, start, dir, damage, speed, effect);

  gi.WriteByte(svc_muzzleflash2);
  gi.WriteShort(g_edicts.indexOf(self));
  gi.WriteByte(flashtype);
  gi.multicast(start, MulticastT.MULTICAST_PVS);
}

export function monster_fire_heat(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  speed: number,
  flashtype: number,
): void {
  fire_heat(self, start, dir, damage, speed, damage, damage);

  gi.WriteByte(svc_muzzleflash2);
  gi.WriteShort(g_edicts.indexOf(self));
  gi.WriteByte(flashtype);
  gi.multicast(start, MulticastT.MULTICAST_PVS);
}

// xatrix/g_monster.c: `// RAFAEL` -- m_brain.c's tentacle-lunge beam and
// (via the healer-ray negative-damage branch) m_medic.c's healer laser both
// route through this shared beam entity. Needed here by m_soldierh.ts's
// lasergun variant (soldierh_laserbeam) and m_fixbot.ts's welding laser.
function dabeam_hit(self: EdictT): void {
  const start = vec3();

  // C computes `count` (8 or 4, from spawnflags) here and declares unused
  // `static vec3_t lmins/lmaxs` locals, but the TE_LASER_SPARKS write below
  // hardcodes a literal 10 instead of using `count` -- dead code, preserved
  // by omission rather than porting an unused local.

  let ignore: Edict = self;
  VectorCopy(self.s.origin, start);
  const end = vec3();
  VectorMA(start, 2048, self.movedir, end);

  let tr: GTraceT;
  for (;;) {
    tr = gi.trace(start, null, null, end, ignore, CONTENTS_SOLID | CONTENTS_MONSTER | CONTENTS_DEADMONSTER);
    if (tr.ent === null) break;

    const hit = traceEdict(tr.ent);

    // hurt it if we can
    if (hit.takedamage && !(hit.flags & FL_IMMUNE_LASER) && hit !== self.owner) {
      const skill = cvarNum(gameCvars.skill);
      // C dereferences self->owner unconditionally here; every dabeam
      // entity is spawned by monster_dabeam's caller with an owner set.
      const owner = self.owner;
      if (owner === null) throw new Error("dabeam_hit: self.owner is null (C dereferences it unconditionally)");
      T_Damage(hit, self, owner, self.movedir, tr.endpos, vec3_origin, self.dmg, skill, DAMAGE_ENERGY, MOD_TARGET_LASER);
    }

    if (self.dmg < 0) {
      // healer ray: when player is at 100 health just undo health fix,
      // keeping fx
      if (hit.client !== null && hit.health > 100) hit.health += self.dmg;
    }

    // if we hit something that's not a monster or player, or it's immune
    // to lasers, we're done
    if (!(hit.svflags & SVF_MONSTER) && hit.client === null) {
      if (self.spawnflags & 0x80000000) {
        self.spawnflags &= ~0x80000000;
        gi.WriteByte(svc_temp_entity);
        gi.WriteByte(TempEventT.TE_LASER_SPARKS);
        gi.WriteByte(10);
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
  self.nextthink = level.time + 0.1;
  self.think = G_FreeEdict;
}

export function monster_dabeam(self: EdictT): void {
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.solid = SolidT.SOLID_NOT;
  self.s.renderfx |= RF_BEAM | RF_TRANSLUCENT;
  self.s.modelindex = 1;

  self.s.frame = 2;

  if (self.owner !== null && self.owner.monsterinfo.aiflags & AI_MEDIC) self.s.skinnum = 0xf3f3f1f1;
  else self.s.skinnum = 0xf2f2f0f0;

  if (self.enemy !== null) {
    const last_movedir = vec3();
    VectorCopy(self.movedir, last_movedir);
    const point = vec3();
    VectorMA(self.enemy.absmin, 0.5, self.enemy.size, point);
    if (self.owner !== null && self.owner.monsterinfo.aiflags & AI_MEDIC) point[0] += Math.sin(level.time) * 8;
    VectorSubtract(point, self.s.origin, self.movedir);
    VectorNormalize(self.movedir);
    if (!VectorCompare(self.movedir, last_movedir)) self.spawnflags |= 0x80000000;
  } else {
    G_SetMovedir(self.s.angles, self.movedir);
  }

  self.think = dabeam_hit;
  self.nextthink = level.time + 0.1;
  VectorSet(self.mins, -8, -8, -8);
  VectorSet(self.maxs, 8, 8, 8);
  gi.linkentity(self);

  self.spawnflags |= 0x80000001;
  self.svflags &= ~SVF_NOCLIENT;
}
