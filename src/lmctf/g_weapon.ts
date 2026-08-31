// Ports a SUBSET of lmctf60/g_weapon.c (the file's full scope is every
// player weapon's fire_* function; that whole dispatch belongs to
// p_weapon.ts, not this unit's SCOPE). Only fire_blaster, its touch
// callback blaster_touch, and the check_dodge support routine they pull in
// are ported here -- the exact subset g_target.ts's use_target_blaster
// (the sole non-player caller of fire_blaster in this port) actually
// reaches. lmctf60/g_target.c calls
// `fire_blaster (self, self->s.origin, self->movedir, self->dmg,
// self->speed, effect, MOD_TARGET_BLASTER)` with `self` being the
// target_blaster entity itself (never a client), so every branch below
// gated on `self.client`/`self.owner.client` is unreachable through that
// call path and is preserved as a throwing citation rather than silently
// dropped, per this port's established "spawn succeeds, only unreached
// behavior throws" convention (see g_target.ts's own prior header note).
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
// this is not a typo to fix, it is the actual observed C behavior.
//
// `WEAP_BALANCE_OK` (`#ifdef` in fire_blaster, wrapping an alternate
// SVF_DEADMONSTER beam-bolt path with CTF_WEAP_BALANCE team coloring) is
// never `#define`d anywhere in lmctf60 -- dead code, not reproduced, same
// as this port's other dropped-never-defined-macro citations.

import { random, vec3, VectorCopy, VectorMA, VectorNormalize, VectorScale, VectorClear, type Vec3 } from "../shared/math";
import { type CplaneT, type CsurfaceT, MASK_SHOT, MulticastT, SURF_SKY, TempEventT } from "../shared/q_shared";
import { SolidT, SVF_DEADMONSTER, type Edict } from "./game";
import { DAMAGE_ENERGY, type EdictT, g_edicts, MOD_BLASTER, MOD_HYPERBLASTER, MovetypeT, gameCvars, gi, level, svc_temp_entity } from "./g_local";
import { T_Damage } from "./g_combat";
import { G_FreeEdict, G_Spawn, vectoangles } from "./g_utils";

// Recovers the game-private EdictT from a trace's game-visible `Edict`, per
// PORTING.md's EDICT_NUM idiom (`g_edicts[ent.s.number]`, never a cast) --
// same as src/ctf/g_weapon.ts's identical helper. NULL (nothing hit) falls
// back to the world edict.
function traceEdict(ent: Edict | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
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
blaster_touch (lmctf60/g_weapon.c) -- byte-identical branching to the C
source, `hyper`/mod attribution included (see this file's header for the
MOD_TARGET_BLASTER truthiness quirk this preserves).

`self.owner.client` is checked here only to decide whether to call
PlayerNoise -- unreachable via this unit's only real caller
(use_target_blaster passes a target_blaster entity as fire_blaster's
`self`/bolt-owner, never a client), so PlayerNoise (lmctf60/p_weapon.c:51,
plasma.ts's own cited "not yet ported" dependency) is never actually
needed; the guard throws instead of silently no-opping if that ever
changes, matching this port's established convention for a genuinely
unreached branch.
=================
*/
function blaster_touch(self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  if (other === self.owner) return;

  if (surf !== null && (surf.flags & SURF_SKY) !== 0) {
    G_FreeEdict(self);
    return;
  }

  if (self.owner !== null && self.owner.client !== null) {
    throw new Error(
      "blaster_touch: PlayerNoise (lmctf60/p_weapon.c:51) is not ported -- unreachable via fire_blaster's only caller (use_target_blaster), whose bolt owner is a target_blaster entity, never a client; see plasma.ts's own PlayerNoise citation for the real dependency",
    );
  }

  // plane can be NULL here (fire_blaster's own immediate self-trace call
  // passes NULL); the C source dereferences plane->normal unconditionally
  // in the takedamage branch below, a latent null-deref in the original
  // this port cannot express -- falls back to vec3_origin, matching the
  // existing NULL guard already present in the sibling (non-takedamage)
  // branch, same idiom as src/ctf/g_weapon.ts's blaster_touch.
  const normal = plane === null ? vec3() : plane.normal;

  if (other.takedamage) {
    const mod = (self.spawnflags & 1) !== 0 ? MOD_HYPERBLASTER : MOD_BLASTER;
    if (self.owner === null) {
      throw new Error("blaster_touch: self.owner is null (C dereferences it unconditionally as T_Damage's attacker here)");
    }
    T_Damage(other, self, self.owner, self.velocity, self.s.origin, normal, self.dmg, 1, DAMAGE_ENERGY, mod);
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
fire_blaster (lmctf60/g_weapon.c:332) -- byte-identical to the C source
with the dead WEAP_BALANCE_OK branch dropped (see file header).
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
