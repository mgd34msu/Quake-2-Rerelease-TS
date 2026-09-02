// lmctf60/g_weapon.c -- COMPLETE port.
//
// HISTORY: this file was previously a deliberate SUBSET (fire_blaster +
// blaster_touch + check_dodge only, the exact reach of g_target.ts's
// use_target_blaster). It is now the whole file: every projectile/hitscan
// fire_* entry point p_weapon.ts's weapon set dispatches into.
//
// PROVENANCE ROUTE: LM-CTF is a fork of ZOID's CTF, and
// `diff -u quake-2-c/ctf/g_weapon.c lmctf60/g_weapon.c` is only ~210 lines
// (most of it license header + never-#define'd #ifdef blocks). This port is
// therefore the faithful sibling port in src/ctf/g_weapon.ts with LM-CTF's
// deltas applied at their sites; each delta is cited inline. The four
// substantive LM-CTF deltas are:
//
//   1. check_dodge's monster-dodge body is wrapped in `#ifdef MONSTERS_OK`,
//      which lmctf60 never #defines -- so only the skill-0 dodge-probability
//      early return survives (it still consumes the RNG stream identically).
//   2. fire_blaster sets `bolt->svflags = SVF_DEADMONSTER` where ZOID's CTF
//      sets SVF_PROJECTILE -- LM-CTF removed SVF_PROJECTILE from game.h
//      entirely (see game.ts's own note), reverting to id's original
//      "projectiles are deadmonsters" prediction hack.
//   3. fire_rail gains a `if (!self) return;` null guard at the top, and
//      keeps ZOID's SOLID_BBOX rail-passthrough.
//   4. bfg_think DROPS ZOID's "don't target players in CTF" teammate skip.
//      In LM-CTF a BFG's tracking lasers hit YOUR OWN TEAMMATES. This is a
//      real gameplay difference from ctf, preserved on purpose; it also
//      removes this file's need for ZOID's `ctf` cvar lookup entirely.
//
// `WEAP_BALANCE_OK` (`#ifdef` blocks in fire_blaster, fire_rail and
// bfg_think, wrapping CTF_WEAP_BALANCE damage/spread tuning) is never
// `#define`d anywhere in lmctf60 -- dead code, not reproduced, same as this
// port's other dropped-never-defined-macro citations.
//
// BUG-FOR-BUG, PRESERVED: lmctf60/g_target.c's use_target_blaster passes
// the literal `MOD_TARGET_BLASTER` (33, g_local.h) as fire_blaster's last
// parameter, which the C prototype declares `qboolean hyper` -- any
// nonzero int is truthy in C, so this is ALWAYS true regardless of
// target_blaster's own `effect` spawnflag computation. The result: every
// target_blaster bolt sets `bolt->spawnflags = 1`, which blaster_touch's
// `self->spawnflags & 1` check reads back as MOD_HYPERBLASTER for damage
// attribution -- a target_blaster kill is always logged/obituaried as a
// hyperblaster death, never as MOD_TARGET_BLASTER, no matter which visual
// effect (EF_BLASTER/EF_HYPERBLASTER/none) the entity displays. Confirmed
// against lmctf60/g_local.h's `#define MOD_TARGET_BLASTER 33` (nonzero) --
// this is not a typo to fix, it is the actual observed C behavior. The TS
// signature keeps `hyper: boolean`, so g_target.ts converts at its call
// site.

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
  EF_ROCKET,
  MASK_SHOT,
  MASK_WATER,
  MulticastT,
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
  TempEventT,
} from "../shared/q_shared";
import { SolidT, SVF_DEADMONSTER, SVF_MONSTER, type Edict } from "./game";
import { CanDamage, T_Damage, T_RadiusDamage } from "./g_combat";
import {
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
  MOD_HIT,
  MOD_HYPERBLASTER,
  MOD_R_SPLASH,
  MOD_RAILGUN,
  MOD_ROCKET,
  MovetypeT,
  PNOISE_IMPACT,
  svc_temp_entity,
} from "./g_local";
import { ThrowDebris } from "./g_misc";
import { findradius, G_FreeEdict, G_Spawn, vectoangles } from "./g_utils";
import { PlayerNoise } from "./p_weapon";

// Recovers the game-private EdictT from a trace's game-visible `Edict`, per
// PORTING.md's EDICT_NUM idiom (`g_edicts[ent.s.number]`, never a cast) --
// same as src/ctf/g_weapon.ts's identical helper. NULL (nothing hit) falls
// back to the world edict.
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

function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

/*
=================
check_dodge (lmctf60/g_weapon.c:15) -- MONSTERS_OK branch dropped.

lmctf60's own source wraps the monster-dodge-callback body in
`#ifdef MONSTERS_OK`, defined nowhere in this pack (confirmed: `grep -rn
MONSTERS_OK` finds only this one guard and its `#endif`) -- with no
monster subsystem ported anywhere in this game family (see g_main.ts's
RunFrame doc comment), that block would be dead even if it did compile.
What remains is the skill-0 dodge-probability early return, which still
consumes the random-number stream exactly like the original (observable
via RNG-dependent tests), even though nothing after it does anything.

The surviving `VectorMA (start, 8192, dir, end)` is also outside the
#ifdef in the C, but `end` is read ONLY inside the dropped block, so it is
a pure dead store with no observable effect -- not reproduced.
=================
*/
function check_dodge(_self: EdictT, _start: Vec3, _dir: Vec3, _speed: number): void {
  const skill = gameCvars.skill === null ? 0 : gameCvars.skill.value;
  if (skill === 0) {
    if (random() > 0.25) return;
  }
  // MONSTERS_OK block dropped -- see doc comment above.
}

/*
=================
fire_hit (lmctf60/g_weapon.c:50)

Used for all impact (hit/punch/slash) attacks. Identical to ctf's.

Reached only by monster melee code in the original id game; lmctf60 has no
live caller (MONSTERS_OK is never defined), but the function itself is NOT
inside any #ifdef, so it is ported straight across rather than stubbed.
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
fire_lead (lmctf60/g_weapon.c:121) -- unchanged from ctf.

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
fire_bullet (lmctf60/g_weapon.c:264)

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
fire_shotgun (lmctf60/g_weapon.c:277)

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
blaster_touch (lmctf60/g_weapon.c:293) -- byte-identical branching to the
C source, `hyper`/mod attribution included (see this file's header for the
MOD_TARGET_BLASTER truthiness quirk this preserves).

NOTE (reconciliation): the previous partial port of this file threw here
when `self.owner.client` was non-null, because PlayerNoise did not exist in
src/lmctf yet and the only live caller (use_target_blaster) never passes a
client. PlayerNoise is now ported (p_weapon.ts), and the player blaster /
hyperblaster reach this path every shot, so the throw is replaced with the
real call.
=================
*/
export function blaster_touch(self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  if (other === self.owner) return;

  if (surf !== null && (surf.flags & SURF_SKY) !== 0) {
    G_FreeEdict(self);
    return;
  }

  const owner = requireOwner(self);
  if (owner.client !== null) PlayerNoise(owner, self.s.origin, PNOISE_IMPACT);

  // plane can be NULL here (fire_blaster's own immediate self-trace call
  // passes NULL); the C source dereferences plane->normal unconditionally
  // in the takedamage branch below, a latent null-deref in the original
  // this port cannot express -- falls back to vec3_origin, matching the
  // existing NULL guard already present in the sibling (non-takedamage)
  // branch, same idiom as src/ctf/g_weapon.ts's blaster_touch.
  const normal = plane === null ? vec3_origin : plane.normal;

  if (other.takedamage) {
    const mod = (self.spawnflags & 1) !== 0 ? MOD_HYPERBLASTER : MOD_BLASTER;
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

/*
=================
fire_blaster (lmctf60/g_weapon.c:332)

Fires a single blaster bolt.  Used by the blaster and hyper blaster.

LM-CTF DELTA #2: `bolt->svflags = SVF_DEADMONSTER` (id original), NOT
ZOID's `SVF_PROJECTILE` -- LM-CTF removed SVF_PROJECTILE from its game.h.
The dead WEAP_BALANCE_OK beam-bolt branch above it is dropped (file header).
=================
*/
export function fire_blaster(self: EdictT, start: Vec3, dir: Vec3, damage: number, speed: number, effect: number, hyper: boolean): void {
  VectorNormalize(dir);

  const bolt = G_Spawn();
  bolt.svflags = SVF_DEADMONSTER;
  // yes, it looks weird that projectiles are deadmonsters -- see the C
  // source's own comment: this keeps player prediction from solid-clipping
  // against an in-flight blaster/hyperblaster bolt.
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
    if (bolt.touch !== null) bolt.touch(bolt, traceEdict(tr.ent), null, null);
  }
}

/*
=================
Grenade_Explode (lmctf60/g_weapon.c:444) -- unchanged from ctf apart from
the `-0.02f` float suffix (a C literal-type annotation with no numeric
effect in TS, where every number is already a double).
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

/*
=================
Grenade_Touch (lmctf60/g_weapon.c:501) -- unchanged from ctf.
=================
*/
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

/*
=================
fire_grenade (lmctf60/g_weapon.c:532) -- the grenade launcher's projectile.
Unchanged from ctf.
=================
*/
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

/*
=================
fire_grenade2 (lmctf60/g_weapon.c:565) -- the hand grenade. Unchanged from
ctf.
=================
*/
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
rocket_touch (lmctf60/g_weapon.c:615) -- unchanged from ctf apart from the
`-0.02f` float suffix (no numeric effect in TS).
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
    const deathmatch = cvarNum(gameCvars.deathmatch);
    const coop = cvarNum(gameCvars.coop);
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

/*
=================
fire_rocket (lmctf60/g_weapon.c:666) -- unchanged from ctf.
=================
*/
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
fire_rail (lmctf60/g_weapon.c:704)

LM-CTF DELTA #3: the C adds `if (!self) return;  // self must not be null`
at the top. `self` is a non-nullable EdictT in TS, so that branch is
unreachable by construction -- cited here rather than written as a live
condition. The dead WEAP_BALANCE_OK four-way fire_lead spread above it is
dropped (file header).

ZOID's SOLID_BBOX passthrough (the rail beam continues through gibs and
other SOLID_BBOX entities instead of stopping) is present in LM-CTF too and
is kept.
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
      //ZOID--added so rail goes through SOLID_BBOX entities (gibs, etc)
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
bfg_explode (lmctf60/g_weapon.c:783) -- unchanged from ctf.
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
      // dead branch preserved from the C: the `ent === self.owner` continue
      // above already skipped the owner, so this halving never runs.
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

/*
=================
bfg_touch (lmctf60/g_weapon.c:827) -- unchanged from ctf.
=================
*/
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

/*
=================
bfg_think (lmctf60/g_weapon.c:866)

LM-CTF DELTA #4 -- THE ONE REAL GAMEPLAY DIVERGENCE IN THIS FILE.
ZOID's ctf/g_weapon.c guards the per-target laser with:

    //ZOID
        //don't target players in CTF
        if (ctf->value && ent->client &&
            self->owner->client &&
            ent->client->resp.ctf_team == self->owner->client->resp.ctf_team)
            continue;
    //ZOID

lmctf60 DELETES that block outright (confirmed in the C diff). So in LM-CTF
the BFG's tracking lasers acquire and damage YOUR OWN TEAMMATES, exactly
like vanilla deathmatch. Whether the damage actually lands is then up to
g_combat.ts's T_Damage / CheckTeamDamage friendly-fire rules, not to this
function. Preserved on purpose; this deletion is also why this file needs
no `ctf` cvar lookup at all (unlike src/ctf/g_weapon.ts's ctfCvarValue).

The dead WEAP_BALANCE_OK `dmg = 3` tuning is dropped (file header).
=================
*/
export function bfg_think(self: EdictT): void {
  const dmg = cvarNum(gameCvars.deathmatch) ? 5 : 10;
  const owner = requireOwner(self);

  let ent: EdictT | null = null;
  for (;;) {
    ent = findradius(ent, self.s.origin, 256);
    if (ent === null) break;

    if (ent === self) continue;
    if (ent === self.owner) continue;
    if (!ent.takedamage) continue;
    if ((ent.svflags & SVF_MONSTER) === 0 && ent.client === null && ent.classname !== "misc_explobox") continue;

    // (ZOID's CTF teammate skip deleted by LM-CTF -- see doc comment above.)

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

/*
=================
fire_bfg (lmctf60/g_weapon.c:949) -- unchanged from ctf.

Note the C's own overwrite quirk, preserved: `bfg->touch`/`nextthink`/
`think` are set to the G_FreeEdict timeout pair and then immediately
reassigned to bfg_think + FRAMETIME, so the 8000/speed timeout never
applies. Written out in the same order as the C.
=================
*/
export function fire_bfg(self: EdictT, start: Vec3, dir: Vec3, damage: number, speed: number, damage_radius: number): void {
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
