// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_xatrix_weapon.cpp -- xatrix (Ground Zero mission pack) shared
// weapon-effect primitives, called by both player weapon code
// (p_xatrix_weapon.ts) and monster weapon code (g_xatrix_monster.ts),
// exactly mirroring g_weapon.ts's own player/monster-shared role for the
// base game. Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/xatrix/g_xatrix_weapon.cpp (605
// lines, C++17): fire_blueblaster, ionripper_sparks/ionripper_touch/
// fire_ionripper, fire_plasma + plasma_touch, and the food-cube TRAP family
// (Trap_Gib_Think, trap_die, Trap_Think, fire_trap). Behavioral code, ported
// bug-for-bug per PORTING.md.
//
// ============================================================================
// fire_heat / heat_think -- NOT duplicated here; m_supertank.ts is this
// porting batch's canonical home
// ============================================================================
// g_xatrix_weapon.cpp:132-237 also defines `fire_heat`/`heat_think` (the
// homing RAFAEL rocket used by supertank's Powershield variant and, via
// `monster_fire_heat`, its own callers). m_supertank.ts landed earlier in
// this port line and, per ITS OWN header, already ported real, exported
// `fire_heat`/`heat_think`/`monster_fire_heat` bodies, explicitly citing
// this file and xatrix/g_xatrix_monster.cpp as their real C++ home and
// flagging the eventual reconciliation. Per this unit's own brief
// ("m_supertank's fire_heat is already real there -- do not duplicate,
// import if needed"), that reconciliation is NOT performed by re-defining
// `fire_heat`/`heat_think` here: doing so would double-register the
// `RegisterThink("heat_think", ...)` save-registry key the moment both
// files loaded in the same process (g_save_registry.ts throws on duplicate
// registration -- see m_guncmdr.ts's header for the identical concern about
// re-registering `M_MonsterDodge`). Nothing in THIS file's own five
// functions (fire_blueblaster/fire_ionripper/fire_plasma/fire_trap and
// their touch/think helpers) calls fire_heat, so no import is even needed
// here; g_xatrix_monster.ts (the real home of the `monster_fire_heat`
// wrapper) re-exports m_supertank.ts's copy instead of redefining it -- see
// that file's own header for the one-line re-export.
//
// ============================================================================
// SpawnDamage -- forward-declared, never called; not ported
// ============================================================================
// `void SpawnDamage(int type, const vec3_t &origin, const vec3_t &normal,
// int damage);` is forward-declared right above `Trap_Think` (line 356) but
// never actually called anywhere in this 605-line file (verified: grepped
// the whole file for the identifier a second time before writing this
// port) -- a genuine dead forward declaration in the shipped source, not
// ported (nothing to port: it has no body in this translation unit and no
// call site to wire up).
//
// ============================================================================
// QUIRKS PRESERVED BUG-FOR-BUG
// ============================================================================
// - `fire_ionripper`'s spawned entity uses `MOVETYPE_WALLBOUNCE` (not
//   `MOVETYPE_FLYMISSILE` like blueblaster/plasma) -- preserved verbatim.
// - `Trap_Think`'s frame-5 "spawn food cube" branch decrements `ent->wait`
//   by 2 every 10Hz tick starting from 64 and only advances `ent->s.frame`
//   once `ent->wait < 19` -- a deliberately slow multi-tick hold, preserved
//   exactly (not simplified to a timer).
// - `Trap_Think`'s live-gib adoption loop (`for (uint32_t i = 0; i <
//   globals.num_edicts; i++)`) reparents every `"gib"`-classed entity within
//   128 units into orbit around the trap via `Trap_Gib_Think`, regardless of
//   which monster spawned them -- preserved verbatim, including the
//   unbounded distance check against the TRAP's origin (not the eaten
//   monster's).
// - `fire_trap`'s `avelocity` is hardcoded to `{0, 300, 0}` (spin only on
//   yaw) and its bounce-up velocity is scaled by `level.gravity / 800`, not
//   a fixed constant -- preserved.
// - `weapon_trap_fire`'s corpse-toss speed floor (`ent->health <= 0 ?
//   TRAP_MINSPEED : ...`) lives in p_xatrix_weapon.ts, not here; `fire_trap`
//   itself takes a pre-computed `speed` and does no health check.

import { vec3, type Vec3 } from "../shared/math";
import { vec3_add, vec3_sub, vec3_muls, vec3_normalized, vectoangles, AngleVectors_destructured, RotatePointAroundVector } from "./q_vec3";
import { clamp, crandom, frandom, irandom } from "./q_std";
import {
  ATTN_NORM,
  ATTN_IDLE,
  ContentsT,
  CvarFlagsT,
  EffectsT,
  type KexTraceT,
  KexMulticastT,
  KexTempEventT,
  MASK_PROJECTILE,
  MASK_WATER,
  RenderfxT,
  ServerCommandT,
  SolidT,
  SoundchanT,
  SurfflagsT,
  SvflagsT,
  WaterLevelT,
} from "../kexapi/game";
import { DamageflagsT, type EdictT, EntFlagsT, type ModT, ModIdT, MovetypeT, PlayerNoiseT, type DieFn, type ThinkFn, type TouchFn } from "./g_local";
import { RegisterThink, RegisterTouch, RegisterDie } from "./g_save_registry";
import { gi, globals, g_edicts, level } from "./g_main_globals";
import { Gtime_add, Gtime_from_sec, Gtime_from_hz, GTIME_ZERO } from "./gtime";
import { G_Spawn, G_FreeEdict, findradius } from "./g_utils";
import { T_Damage, T_RadiusDamage, CheckTeamDamage } from "./g_combat";
import { M_ProcessPain } from "./g_monster";
import { BecomeExplosion1 } from "./g_misc";
import { visible } from "./g_ai";
import { blaster_touch } from "./g_weapon";
import { PlayerNoise } from "./p_weapon";
import { G_ShouldPlayersCollide } from "./p_client";
import { SP_item_foodcube } from "./g_xatrix_items";

// ---------------------------------------------------------------------------
// small per-file helpers (see g_weapon.ts's own header: duplicated on
// purpose, per this port line's established convention for tiny
// header-only wrappers)
// ---------------------------------------------------------------------------

/** `mod_t`'s implicit single-argument constructor (g_local.h:1081-1093). */
function modFromId(id: ModIdT): ModT {
  return { id, friendly_fire: false, no_point_loss: false };
}

function cvarInt(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): number {
  const c = gi.cvar(name, def, flags);
  return c === null ? Math.trunc(Number(def)) : Math.trunc(c.value);
}
function deathmatchEnabled(): boolean {
  return cvarInt("deathmatch", "0") !== 0;
}

/** See g_weapon.ts's own "unconditional pointer dereferences" note. */
function requireOwner(ent: EdictT, context: string): EdictT {
  if (ent.owner === null) throw new Error(`${context}: ent.owner is null (invariant violated -- always set by the fire_* spawn function immediately before this can run)`);
  return ent.owner;
}
function requireTeammaster(ent: EdictT, context: string): EdictT {
  if (ent.teammaster === null) throw new Error(`${context}: ent.teammaster is null (invariant violated -- always set by fire_trap immediately before this can run)`);
  return ent.teammaster;
}
function requireThink<T>(fn: T | null, name: string, self: EdictT): T {
  if (fn === null) throw new Error(`${name} is null on ${self.classname ?? "?"} (invariant violated)`);
  return fn;
}

const vec3_origin: Vec3 = vec3(0, 0, 0);

// ---------------------------------------------------------------------------
// fire_blueblaster (g_xatrix_weapon.cpp:6-42)
// ---------------------------------------------------------------------------

/** `void fire_blueblaster(edict_t*, const vec3_t&, const vec3_t&, int, int,
 *  effects_t)`. Reuses g_weapon.ts's own real, exported `blaster_touch` --
 *  the C++ literally assigns the SAME `blaster_touch` function pointer, it
 *  is not a distinct xatrix touch handler. */
export function fire_blueblaster(self: EdictT, start: Vec3, dir: Vec3, damage: number, speed: number, effect: EffectsT): void {
  const bolt = G_Spawn();
  bolt.s.origin = vec3(start[0], start[1], start[2]);
  bolt.s.old_origin = vec3(start[0], start[1], start[2]);
  bolt.s.angles = vectoangles(dir);
  bolt.velocity = vec3_muls(dir, speed);
  bolt.svflags |= SvflagsT.SVF_PROJECTILE;
  bolt.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  bolt.flags |= EntFlagsT.FL_DODGE;
  bolt.clipmask = MASK_PROJECTILE;
  bolt.solid = SolidT.SOLID_BBOX;
  bolt.s.effects |= effect;
  bolt.s.modelindex = gi.modelindex("models/objects/laser/tris.md2");
  bolt.s.skinnum = 1;
  bolt.s.sound = gi.soundindex("misc/lasfly.wav");
  bolt.owner = self;
  bolt.touch = blaster_touch;
  bolt.nextthink = Gtime_add(level.time, Gtime_from_sec(2));
  bolt.think = G_FreeEdict;
  bolt.dmg = damage;
  bolt.classname = "bolt";
  bolt.style = ModIdT.MOD_BLUEBLASTER;
  gi.linkentity(bolt);

  const tr = gi.trace(self.s.origin, null, null, bolt.s.origin, self, bolt.clipmask);
  if (tr.fraction < 1.0) {
    bolt.s.origin = vec3_add(tr.endpos, vec3_muls(tr.plane.normal, 1));
    requireThink(bolt.touch, "bolt.touch", bolt)(bolt, tr.ent !== null ? g_edicts[tr.ent.s.number] : g_edicts[0], tr, false);
  }
}

// ---------------------------------------------------------------------------
// fire_ionripper (g_xatrix_weapon.cpp:50-129)
// ---------------------------------------------------------------------------

/** `THINK(ionripper_sparks)` (g_xatrix_weapon.cpp:50-61). */
const ionripper_sparks: ThinkFn = RegisterThink("ionripper_sparks", (self: EdictT): void => {
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_WELDING_SPARKS);
  gi.WriteByte(0);
  gi.WritePosition(self.s.origin);
  gi.WriteDir(vec3_origin);
  gi.WriteByte(irandom(0xe4, 0xe8));
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PVS, false);

  G_FreeEdict(self);
});

/** `TOUCH(ionripper_touch)` (g_xatrix_weapon.cpp:64-88). */
const ionripper_touch: TouchFn = RegisterTouch("ionripper_touch", (self: EdictT, other: EdictT, tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (other === self.owner) return;

  if (tr.surface !== null && (tr.surface.flags & SurfflagsT.SURF_SKY) !== 0) {
    G_FreeEdict(self);
    return;
  }

  const owner = requireOwner(self, "ionripper_touch");
  if (owner.client !== null) PlayerNoise(owner, self.s.origin, PlayerNoiseT.PNOISE_IMPACT);

  if (!other.takedamage) return;

  T_Damage(other, self, owner, self.velocity, self.s.origin, tr.plane.normal, self.dmg, 1, DamageflagsT.DAMAGE_ENERGY, modFromId(ModIdT.MOD_RIPPER));

  G_FreeEdict(self);
});

/** `void fire_ionripper(edict_t*, const vec3_t&, const vec3_t&, int, int,
 *  effects_t)` (g_xatrix_weapon.cpp:91-129). */
export function fire_ionripper(self: EdictT, start: Vec3, dir: Vec3, damage: number, speed: number, effect: EffectsT): void {
  const ion = G_Spawn();
  ion.s.origin = vec3(start[0], start[1], start[2]);
  ion.s.old_origin = vec3(start[0], start[1], start[2]);
  ion.s.angles = vectoangles(dir);
  ion.velocity = vec3_muls(dir, speed);
  ion.movetype = MovetypeT.MOVETYPE_WALLBOUNCE;
  ion.clipmask = MASK_PROJECTILE;

  // [Paril-KEX]
  if (self.client !== null && !G_ShouldPlayersCollide(true)) ion.clipmask &= ~ContentsT.CONTENTS_PLAYER;

  ion.solid = SolidT.SOLID_BBOX;
  ion.s.effects |= effect;
  ion.svflags |= SvflagsT.SVF_PROJECTILE;
  ion.flags |= EntFlagsT.FL_DODGE;
  ion.s.renderfx |= RenderfxT.RF_FULLBRIGHT;
  ion.s.modelindex = gi.modelindex("models/objects/boomrang/tris.md2");
  ion.s.sound = gi.soundindex("misc/lasfly.wav");
  ion.owner = self;
  ion.touch = ionripper_touch;
  ion.nextthink = Gtime_add(level.time, Gtime_from_sec(3));
  ion.think = ionripper_sparks;
  ion.dmg = damage;
  ion.dmg_radius = 100;
  gi.linkentity(ion);

  const tr = gi.trace(self.s.origin, null, null, ion.s.origin, self, ion.clipmask);
  if (tr.fraction < 1.0) {
    ion.s.origin = vec3_add(tr.endpos, vec3_muls(tr.plane.normal, 1));
    requireThink(ion.touch, "ion.touch", ion)(ion, tr.ent !== null ? g_edicts[tr.ent.s.number] : g_edicts[0], tr, false);
  }
}

// ---------------------------------------------------------------------------
// fire_plasma (g_xatrix_weapon.cpp:239-312) -- the Phalanx's projectile
// ---------------------------------------------------------------------------

/** `TOUCH(plasma_touch)` (g_xatrix_weapon.cpp:245-277). */
const plasma_touch: TouchFn = RegisterTouch("plasma_touch", (ent: EdictT, other: EdictT, tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (other === ent.owner) return;

  if (tr.surface !== null && (tr.surface.flags & SurfflagsT.SURF_SKY) !== 0) {
    G_FreeEdict(ent);
    return;
  }

  const owner = requireOwner(ent, "plasma_touch");
  if (owner.client !== null) PlayerNoise(owner, ent.s.origin, PlayerNoiseT.PNOISE_IMPACT);

  // calculate position for the explosion entity
  const origin = vec3_add(ent.s.origin, vec3_muls(ent.velocity, -0.02));

  if (other.takedamage) {
    T_Damage(other, ent, owner, ent.velocity, ent.s.origin, tr.plane.normal, ent.dmg, 0, DamageflagsT.DAMAGE_ENERGY, modFromId(ModIdT.MOD_PHALANX));
  }

  T_RadiusDamage(ent, owner, ent.radius_dmg, other, ent.dmg_radius, DamageflagsT.DAMAGE_ENERGY, modFromId(ModIdT.MOD_PHALANX));

  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_PLASMA_EXPLOSION);
  gi.WritePosition(origin);
  gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PHS, false);

  G_FreeEdict(ent);
});

/** `void fire_plasma(edict_t*, const vec3_t&, const vec3_t&, int, int,
 *  float, int)` (g_xatrix_weapon.cpp:280-312). */
export function fire_plasma(self: EdictT, start: Vec3, dir: Vec3, damage: number, speed: number, damage_radius: number, radius_damage: number): void {
  const plasma = G_Spawn();
  plasma.s.origin = vec3(start[0], start[1], start[2]);
  plasma.movedir = vec3(dir[0], dir[1], dir[2]);
  plasma.s.angles = vectoangles(dir);
  plasma.velocity = vec3_muls(dir, speed);
  plasma.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  plasma.clipmask = MASK_PROJECTILE;

  // [Paril-KEX]
  if (self.client !== null && !G_ShouldPlayersCollide(true)) plasma.clipmask &= ~ContentsT.CONTENTS_PLAYER;

  plasma.solid = SolidT.SOLID_BBOX;
  plasma.svflags |= SvflagsT.SVF_PROJECTILE;
  plasma.flags |= EntFlagsT.FL_DODGE;
  plasma.owner = self;
  plasma.touch = plasma_touch;
  plasma.nextthink = Gtime_add(level.time, Gtime_from_sec(8000 / speed));
  plasma.think = G_FreeEdict;
  plasma.dmg = damage;
  plasma.radius_dmg = radius_damage;
  plasma.dmg_radius = damage_radius;
  plasma.s.sound = gi.soundindex("weapons/rockfly.wav");

  plasma.s.modelindex = gi.modelindex("sprites/s_photon.sp2");
  plasma.s.effects |= EffectsT.EF_PLASMA | EffectsT.EF_ANIM_ALLFAST;

  gi.linkentity(plasma);
}

// ---------------------------------------------------------------------------
// TRAP (g_xatrix_weapon.cpp:314-605) -- the food-cube trap
// ---------------------------------------------------------------------------

/** `THINK(Trap_Gib_Think)` (g_xatrix_weapon.cpp:314-347). Orbits an eaten
 *  monster's already-spawned gibs around the trap while it "digests". */
const Trap_Gib_Think: ThinkFn = RegisterThink("Trap_Gib_Think", (ent: EdictT): void => {
  const owner = requireOwner(ent, "Trap_Gib_Think");
  if (owner.s.frame !== 5) {
    G_FreeEdict(ent);
    return;
  }

  const { up } = AngleVectors_destructured(owner.s.angles);

  // rotate us around the center
  const degrees = 150 * gi.frame_time_s + owner.delay;
  const diff = vec3_sub(owner.s.origin, ent.s.origin);
  const rotated = RotatePointAroundVector(up, diff, degrees);
  ent.s.angles[1] += degrees;
  const new_origin = vec3_sub(owner.s.origin, rotated);

  const tr = gi.trace(ent.s.origin, null, null, new_origin, ent, ContentsT.CONTENTS_SOLID);
  ent.s.origin = vec3(tr.endpos[0], tr.endpos[1], tr.endpos[2]);

  // pull us towards the trap's center
  const diffNorm = vec3_normalized(diff);
  ent.s.origin = vec3_add(ent.s.origin, vec3_muls(diffNorm, 15.0 * gi.frame_time_s));

  ent.watertype = gi.pointcontents(ent.s.origin);
  if ((ent.watertype & MASK_WATER) !== 0) ent.waterlevel = WaterLevelT.WATER_FEET;

  ent.nextthink = Gtime_add(level.time, Gtime_from_sec(gi.frame_time_s));
  gi.linkentity(ent);
});

/** `DIE(trap_die)` (g_xatrix_weapon.cpp:349-352). */
const trap_die: DieFn = RegisterDie("trap_die", (self: EdictT): void => {
  BecomeExplosion1(self);
});

/** `THINK(Trap_Think)` (g_xatrix_weapon.cpp:358-556). */
const Trap_Think: ThinkFn = RegisterThink("Trap_Think", (ent: EdictT): void => {
  if (ent.timestamp < level.time) {
    BecomeExplosion1(ent);
    return;
  }

  ent.nextthink = Gtime_add(level.time, Gtime_from_hz(10));

  if (ent.groundentity === null) return;

  // ok lets do the blood effect
  if (ent.s.frame > 4) {
    if (ent.s.frame === 5) {
      const spawn = ent.wait === 64;

      ent.wait -= 2;

      if (spawn) gi.sound(ent, SoundchanT.CHAN_VOICE, gi.soundindex("weapons/trapdown.wav"), 1, ATTN_IDLE, 0);

      ent.delay += 2;

      if (ent.wait < 19) ent.s.frame++;

      return;
    }
    ent.s.frame++;
    if (ent.s.frame === 8) {
      ent.nextthink = Gtime_add(level.time, Gtime_from_sec(1));
      ent.think = G_FreeEdict;
      ent.s.effects &= ~EffectsT.EF_TRAP;

      const best = G_Spawn();
      best.count = ent.mass;
      best.s.scale = 1.0 + ((ent.accel - 100) / 300) * 1.0;
      SP_item_foodcube(best);
      best.s.origin = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2] + 24 * best.s.scale);
      best.s.angles[1] = frandom() * 360;
      best.velocity = vec3(0, 0, 400);
      requireThink(best.think, "best.think", best)(best);
      best.nextthink = GTIME_ZERO;
      best.s.old_origin = vec3(best.s.origin[0], best.s.origin[1], best.s.origin[2]);
      gi.linkentity(best);

      gi.sound(best, SoundchanT.CHAN_AUTO, gi.soundindex("misc/fhit3.wav"), 1.0, ATTN_NORM, 0);

      return;
    }
    return;
  }

  ent.s.effects &= ~EffectsT.EF_TRAP;
  if (ent.s.frame >= 4) {
    ent.s.effects |= EffectsT.EF_TRAP;
    // clear the owner if in deathmatch
    if (deathmatchEnabled()) ent.owner = null;
  }

  if (ent.s.frame < 4) {
    ent.s.frame++;
    return;
  }

  let target: EdictT | null = null;
  let best: EdictT | null = null;
  let oldlen = 8000;

  for (;;) {
    target = findradius(target, ent.s.origin, 256);
    if (target === null) break;
    if (target === ent) continue;

    // [Paril-KEX] don't allow traps to be placed near flags or teleporters
    const cn = target.classname;
    if (
      cn !== null &&
      deathmatchEnabled() &&
      (cn.startsWith("info_player_") || cn === "misc_teleporter_dest" || cn.startsWith("item_flag_")) &&
      visible(target, ent)
    ) {
      BecomeExplosion1(ent);
      return;
    }

    if ((target.svflags & SvflagsT.SVF_MONSTER) === 0 && target.client === null) continue;
    if (target !== ent.teammaster && CheckTeamDamage(target, requireTeammaster(ent, "Trap_Think"))) continue;
    // [Paril-KEX]
    if (!deathmatchEnabled() && target.client !== null) continue;
    if (target.health <= 0) continue;
    if (!visible(ent, target)) continue;

    const vec = vec3_sub(ent.s.origin, target.s.origin);
    const len = Math.hypot(vec[0], vec[1], vec[2]);
    if (best === null) {
      best = target;
      oldlen = len;
      continue;
    }
    if (len < oldlen) {
      oldlen = len;
      best = target;
    }
  }

  // pull the enemy in
  if (best !== null) {
    if (best.groundentity !== null) {
      best.s.origin[2] += 1;
      best.groundentity = null;
    }
    let vec = vec3_sub(ent.s.origin, best.s.origin);
    const len = Math.hypot(vec[0], vec[1], vec[2]);
    vec = len > 0 ? vec3_muls(vec, 1 / len) : vec3(0, 0, 0);

    const max_speed = best.client !== null ? 290 : 150;

    best.velocity = vec3_add(best.velocity, vec3_muls(vec, clamp(max_speed - len, 64, max_speed)));

    ent.s.sound = gi.soundindex("weapons/trapsuck.wav");

    if (len < 48) {
      if (best.mass < 400) {
        ent.takedamage = false;
        ent.solid = SolidT.SOLID_NOT;
        ent.die = null;

        T_Damage(best, ent, requireTeammaster(ent, "Trap_Think"), vec3(0, 0, 0), best.s.origin, vec3(0, 0, 0), 100000, 1, DamageflagsT.DAMAGE_NONE, modFromId(ModIdT.MOD_TRAP));

        if ((best.svflags & SvflagsT.SVF_MONSTER) !== 0) M_ProcessPain(best);

        ent.enemy = best;
        ent.wait = 64;
        ent.s.old_origin = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2]);
        ent.timestamp = Gtime_add(level.time, Gtime_from_sec(30));
        ent.accel = best.mass;
        ent.mass = deathmatchEnabled() ? Math.trunc(best.mass / 4) : Math.trunc(best.mass / 10);
        // ok spawn the food cube
        ent.s.frame = 5;

        // link up any gibs that this monster may have spawned
        for (let i = 0; i < globals.num_edicts; i++) {
          const e = g_edicts[i];
          if (e === undefined || !e.inuse) continue;
          if (e.classname !== "gib") continue;
          const d = vec3_sub(e.s.origin, ent.s.origin);
          if (Math.hypot(d[0], d[1], d[2]) > 128) continue;

          e.movetype = MovetypeT.MOVETYPE_NONE;
          e.nextthink = Gtime_add(level.time, Gtime_from_sec(gi.frame_time_s));
          e.think = Trap_Gib_Think;
          e.owner = ent;
          Trap_Gib_Think(e);
        }
      } else {
        BecomeExplosion1(ent);
        return;
      }
    }
  }
});

/** `void fire_trap(edict_t*, const vec3_t&, const vec3_t&, int)`
 *  (g_xatrix_weapon.cpp:559-605). */
export function fire_trap(self: EdictT, start: Vec3, aimdir: Vec3, speed: number): void {
  const dir = vectoangles(aimdir);
  const { right, up } = AngleVectors_destructured(dir);

  const trap = G_Spawn();
  trap.s.origin = vec3(start[0], start[1], start[2]);
  trap.velocity = vec3_muls(aimdir, speed);

  const gravityAdjustment = level.gravity / 800;

  trap.velocity = vec3_add(trap.velocity, vec3_muls(up, (200 + crandom() * 10.0) * gravityAdjustment));
  trap.velocity = vec3_add(trap.velocity, vec3_muls(right, crandom() * 10.0));

  trap.avelocity = vec3(0, 300, 0);
  trap.movetype = MovetypeT.MOVETYPE_BOUNCE;

  trap.solid = SolidT.SOLID_BBOX;
  trap.takedamage = true;
  trap.mins = vec3(-4, -4, 0);
  trap.maxs = vec3(4, 4, 8);
  trap.die = trap_die;
  trap.health = 20;
  trap.s.modelindex = gi.modelindex("models/weapons/z_trap/tris.md2");
  trap.owner = self;
  trap.teammaster = self;
  trap.nextthink = Gtime_add(level.time, Gtime_from_sec(1));
  trap.think = Trap_Think;
  trap.classname = "food_cube_trap";
  // RAFAEL 16-APR-98
  trap.s.sound = gi.soundindex("weapons/traploop.wav");
  // END 16-APR-98

  trap.flags |= EntFlagsT.FL_DAMAGEABLE | EntFlagsT.FL_MECHANICAL | EntFlagsT.FL_TRAP;
  trap.clipmask = MASK_PROJECTILE & ~ContentsT.CONTENTS_DEADMONSTER;

  // [Paril-KEX]
  if (self.client !== null && !G_ShouldPlayersCollide(true)) trap.clipmask &= ~ContentsT.CONTENTS_PLAYER;

  gi.linkentity(trap);

  trap.timestamp = Gtime_add(level.time, Gtime_from_sec(30));
}
