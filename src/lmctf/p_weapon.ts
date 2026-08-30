// Ports a SUBSET of lmctf60/p_weapon.c (diff vs quake-2/ctf/p_weapon.c is
// 1201 lines of 2226 total).
//
// STATUS: only P_ProjectSource and the offhand-hook priority feature's
// entire fire chain are ported: hook_touch, Grapple_Bolt_Think, hook_die,
// fire_hook, Draw_Hook, Weapon_Hook_Fire. `Weapon_Hook` (the entry point
// used ONLY when the grapple is the client's currently-EQUIPPED weapon,
// dispatched through the normal weapon-frame system) is a stub that throws
// -- it depends on Weapon_Generic/ChangeWeapon/NoAmmoWeaponChange, none of
// which are ported (Weapon_Generic alone is a ~150-line rewrite from ctf's
// version, with its own ChangeWeapon/NoAmmoWeaponChange dependencies -- a
// separate unit of work). This does NOT affect the offhand hook itself:
// per lmctf60/g_cmds.c's Cmd_Hook_f (see g_cmds.ts), the offhand path calls
// Weapon_Hook_Fire directly and never goes through Weapon_Hook/
// Weapon_Generic at all. Every other weapon in p_weapon.c (blaster,
// shotgun, machinegun, chaingun, hyperblaster, railgun, bfg, grenade
// launcher, grenades, and the SKWiD plasma rifle handled in plasma.ts) is
// NOT ported here.

import { AngleVectors, type Vec3, vec3, vec3_origin, VectorAdd, VectorClear, VectorCopy, VectorLength, VectorMA, VectorNormalize, VectorScale, VectorSet, VectorSubtract } from "../shared/math";
import { ATTN_NORM, CHAN_AUTO, type CplaneT, type CsurfaceT, MASK_SHOT, MulticastT, PITCH, SURF_SKY, TempEventT } from "../shared/q_shared";
import { T_Damage } from "./g_combat";
import { CTF_TEAM_ANYTEAM, ctf_hook_abort, ctf_validateplayer } from "./g_ctffunc";
import {
  type EdictT,
  CENTER_HANDED,
  CTF_NO_GRAP_DAMAGE,
  DAMAGE_ENERGY,
  type GClientT,
  LEFT_HANDED,
  MOD_CTF_GRAPPLE,
  MovetypeT,
  g_edicts,
  gameCvars,
  gi,
  level,
  svc_temp_entity,
  world,
} from "./g_local";
import { type Edict, SolidT } from "./game";
import { G_ProjectSource, G_Spawn, vectoangles } from "./g_utils";

// Recovers the game-private EdictT from a trace's game-visible `Edict`, per
// PORTING.md's EDICT_NUM idiom (`g_edicts[ent.s.number]`, never a cast) --
// identical to src/ctf/g_weapon.ts's traceEdict, including its NULL ->
// world-edict fallback (matches EdictT.touch's non-nullable `other`
// parameter; `fire_hook` only invokes touch when `tr.fraction < 1.0`,
// i.e. something was actually hit, so this fallback is defensive, not a
// path exercised in practice).
function traceEdict(ent: Edict | null): EdictT {
  if (ent === null) return world();
  return g_edicts[ent.s.number] ?? world();
}

// lmctf60/p_weapon.c: `#define GRAPPLE_FIRE_HOOK_SPEED 800` /
// `#define GRAPPLE_PULL_SPEED 800` / `#define GRAPPLE_PULL_BALANCED_SPEED 800`
// (file-local #defines, ported as module-scoped consts). The "balanced"
// variant is dead code: it is only read under `#ifdef WEAP_BALANCE_OK`,
// which the Makefile never defines (see g_local.ts's CTF_WEAP_BALANCE
// comment) -- and even if it were live, it is numerically identical to
// GRAPPLE_PULL_SPEED (both 800), so there would be no observable difference
// either way.
export const GRAPPLE_FIRE_HOOK_SPEED = 800;
export const GRAPPLE_PULL_SPEED = 800;

/*
=================
P_ProjectSource (lmctf60/p_weapon.c) -- unchanged from src/ctf/p_weapon.ts.
=================
*/
export function P_ProjectSource(client: GClientT, point: Vec3, distance: Vec3, forward: Vec3, right: Vec3, result: Vec3): void {
  const _distance = vec3();
  VectorCopy(distance, _distance);
  if (client.pers.hand === LEFT_HANDED) _distance[1] *= -1;
  else if (client.pers.hand === CENTER_HANDED) _distance[1] = 0;
  G_ProjectSource(point, _distance, forward, right, result);
}

/*
=================
hook_touch (lmctf60/p_weapon.c, "// CTF CODE -- LM_JORM" section)

Touch handler for the flying/attached hook bolt. Ignores touching its own
owner. Once a hook_target is locked, ignores touches from anything else
(ctf_touch is exclusive to whatever it first grabbed). Aborts (frees the
hook) if what it touched is not a player, bodyque, worldspawn, a "func"-
prefixed classname, or an "info_flag"-prefixed classname, or if it hit the
sky, a teammate, or a dead body.
Otherwise: zeroes the bolt's velocity, transitions the owner's hookstate to
2 ("pulling") the first time it registers a hit, deals damage (gated by
CTF_NO_GRAP_DAMAGE, always allowed against non-clients) -- 8/8 bonus damage
on the FIRST hit of a given target, or 1/1 every 7th frame while
continuously latched onto the SAME target -- aborts again if the target
died from that damage, and otherwise (first-ever touch of this target)
captures `hook_offset` (the bolt's current offset from the target's
absmin) and switches the bolt to SOLID_TRIGGER so it can keep "touching"
a target it is now riding along with. Always broadcasts a TE_BLASTER
sprite at the impact point.
=================
*/
export function hook_touch(self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  // C: `if (!other) return;` -- defensive; EdictT.touch's signature is
  // non-nullable (see traceEdict's world-edict fallback above), so this
  // condition cannot occur through this port's call paths. Preserved as a
  // citation, not a live branch.
  if (other === self.owner) return; // we hit ourselves, ignore us
  if (self.hook_target !== null && self.hook_target !== other) return; // already have a target

  const classname = other.classname ?? "";
  if (
    classname !== "bodyque" &&
    !ctf_validateplayer(other, CTF_TEAM_ANYTEAM) &&
    classname !== "worldspawn" &&
    !classname.startsWith("func") &&
    !classname.startsWith("info_flag")
  ) {
    ctf_hook_abort(self.owner);
    return;
  }

  const owner = self.owner;
  if (
    (surf !== null && (surf.flags & SURF_SKY) !== 0) ||
    (other.client !== null && owner !== null && owner.client !== null && owner.client.ctf.teamnum === other.client.ctf.teamnum) ||
    other.deadflag !== 0
  ) {
    ctf_hook_abort(owner);
    return;
  }

  VectorClear(self.velocity);

  if (owner !== null && owner.client !== null) {
    if (owner.client.hookstate === 1) {
      // have we just hit? (sound cues commented out in the C source itself)
    }
    owner.client.hookstate = 2;
  }

  const ctfflags = gameCvars.ctfflags?.value ?? 0;
  if ((ctfflags & CTF_NO_GRAP_DAMAGE) === 0 || other.client === null) {
    if (self.hook_target === other) {
      if (level.framenum % 7 === 0 && level.framenum !== self.hook_lastframe) {
        if (ctf_validateplayer(other, CTF_TEAM_ANYTEAM)) {
          gi.sound(self, CHAN_AUTO, gi.soundindex("weapons/grapple/gkilling.wav"), 1, ATTN_NORM, 0);
        }
        if (owner !== null) {
          T_Damage(other, self, owner, self.velocity, self.s.origin, plane !== null ? plane.normal : vec3_origin, 1, 1, DAMAGE_ENERGY, MOD_CTF_GRAPPLE);
        }
        self.hook_lastframe = level.framenum;
      }
    } else {
      if (ctf_validateplayer(other, CTF_TEAM_ANYTEAM)) {
        gi.sound(self, CHAN_AUTO, gi.soundindex("weapons/grapple/ghit.wav"), 1, ATTN_NORM, 0);
      } else {
        gi.sound(self, CHAN_AUTO, gi.soundindex("weapons/grapple/ghitwall.wav"), 0.8, ATTN_NORM, 0);
      }
      if (owner !== null) {
        T_Damage(other, self, owner, self.velocity, self.s.origin, plane !== null ? plane.normal : vec3_origin, 8, 8, DAMAGE_ENERGY, MOD_CTF_GRAPPLE);
      }
    }
  }

  if (other.deadflag !== 0) {
    ctf_hook_abort(owner);
    return;
  }

  if (self.hook_target === null) {
    self.hook_target = other;
    const dest = vec3();
    VectorSubtract(self.s.origin, other.absmin, dest);
    VectorCopy(dest, self.hook_offset);
    self.solid = SolidT.SOLID_TRIGGER;
    gi.linkentity(self);
  }

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_BLASTER);
  gi.WritePosition(self.s.origin);
  gi.WriteDir(plane === null ? vec3_origin : plane.normal);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);
}

/*
=================
Grapple_Bolt_Think (lmctf60/p_weapon.c)

Periodic sound-cue think, independent of the actual physics: plays an
"in flight" sound every 0.4s while nothing is latched and hooklength > 126,
a "retracting" sound every 0.8s once something IS latched and
hooklength > 126, and stops re-scheduling itself entirely (no sound) once
hooklength drops to <= 126 -- so a hook fired and immediately retrieved at
close range goes silent, matching the C source exactly (this is NOT tied to
the live current distance during pulling, only to the last value
Weapon_Hook_Fire wrote into hooklength).
=================
*/
export function Grapple_Bolt_Think(self: EdictT): void {
  const owner = self.owner;
  const hooklength = owner !== null && owner.client !== null ? owner.client.hooklength : 0;

  if (self.hook_target === null && hooklength > 126) {
    gi.sound(self, CHAN_AUTO, gi.soundindex("weapons/grapple/gflyair.wav"), 1, ATTN_NORM, 0);
    self.nextthink = level.time + 0.4;
    self.think = Grapple_Bolt_Think;
  } else if (hooklength > 126) {
    gi.sound(self, CHAN_AUTO, gi.soundindex("weapons/grapple/gpulling.wav"), 1, ATTN_NORM, 0);
    self.nextthink = level.time + 0.8;
    self.think = Grapple_Bolt_Think;
  } else {
    self.nextthink = 0;
    self.think = null;
  }
}

/*
=================
hook_die (lmctf60/p_weapon.c) -- shot down (health 59, dmg 2): just aborts
the owner's hook.
=================
*/
export function hook_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3): void {
  ctf_hook_abort(self.owner);
}

/*
=================
fire_hook (lmctf60/p_weapon.c)

Spawns the hook bolt: MOVETYPE_FLYMISSILE, MASK_SHOT clipmask, zero-size
bbox, 59 health / takes 2 damage per hit (so 30 direct hits would down it,
though nothing in this port currently fires damage at it besides whatever
the caller wires up), 1-tick-delayed Grapple_Bolt_Think. If the initial
trace from the firer to the spawn point is already blocked
(`tr.fraction < 1.0`), immediately backs the bolt up 10 units along `dir`
and calls hook_touch on whatever it hit right there -- this is how a hook
fired point-blank into a wall/player registers on the very first frame
instead of waiting for its next physics tick.
=================
*/
export function fire_hook(self: EdictT, start: Vec3, dirIn: Vec3, speed: number): EdictT {
  const dir = vec3();
  VectorCopy(dirIn, dir);
  VectorNormalize(dir);

  const bolt = G_Spawn();
  VectorCopy(start, bolt.s.origin);
  VectorCopy(start, bolt.s.old_origin);
  vectoangles(dir, bolt.s.angles);
  bolt.s.angles[PITCH] += 90;
  VectorScale(dir, speed, bolt.velocity);
  bolt.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  bolt.clipmask = MASK_SHOT;
  bolt.solid = SolidT.SOLID_BBOX;
  VectorClear(bolt.mins);
  VectorClear(bolt.maxs);
  bolt.s.modelindex = gi.modelindex("models/objects/ghook/tris.md2");
  bolt.owner = self;
  bolt.touch = hook_touch;
  bolt.die = hook_die;
  bolt.nextthink = level.time + 1;
  bolt.think = Grapple_Bolt_Think;
  bolt.dmg = 2;
  bolt.takedamage = 1; // DamageT.DAMAGE_YES
  bolt.health = 59;
  gi.linkentity(bolt);

  gi.sound(self, CHAN_AUTO, gi.soundindex("weapons/grapple/grfire.wav"), 0.8, ATTN_NORM, 0);

  const tr = gi.trace(self.s.origin, null, null, bolt.s.origin, self, MASK_SHOT);
  if (tr.fraction < 1.0) {
    VectorMA(bolt.s.origin, -10, dir, bolt.s.origin);
    if (bolt.touch) bolt.touch(bolt, traceEdict(tr.ent), null, null);
  }
  return bolt;
}

/*
=================
Draw_Hook (lmctf60/p_weapon.c)

Broadcasts the TE_GRAPPLE_CABLE temp-entity effect from `start` to `end`,
but ONLY once the cable is longer than 64 units -- a hook that has already
reeled the player in close stops drawing its line, matching the C source's
early-out. `ent` identifies whose cable this is on the wire (the owning
player's edict index).

The C source also computes `mins`/`maxs` (-15/15 cube) via its local `tv()`
helper but never reads them anywhere in the function body -- genuinely dead
local computation, not an #ifdef branch, so per the same reasoning this
port already applies to Draw_Hook's sibling dead-write fields (see
g_local.ts's hookend comment), it is not reproduced.
=================
*/
export function Draw_Hook(ent: EdictT, start: Vec3, end: Vec3): void {
  const dir = vec3();
  const offset = vec3();
  VectorSubtract(end, start, dir);
  VectorSet(offset, 0, 0, 0);

  if (VectorLength(dir) > 64) {
    gi.WriteByte(svc_temp_entity);
    gi.WriteByte(TempEventT.TE_GRAPPLE_CABLE);
    // `ent - g_edicts` (pointer offset) -- see G_InitEdict's identical note;
    // `s.number` is stamped at allocation time, matching the rest of this
    // port's `ent - g_edicts -> ent.s.number` convention.
    gi.WriteShort(ent.s.number);
    gi.WritePosition(start);
    gi.WritePosition(end);
    gi.WritePosition(offset);
    gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);
  }
}

/*
=================
Weapon_Hook_Fire (lmctf60/p_weapon.c) -- THE OFFHAND HOOK'S FIRE/PULL STATE
MACHINE.

Called every server frame while `client.hookstate !== 0`, from EITHER:
  - Cmd_Hook_f (g_cmds.ts), the very first time (hookstate transitions
    0 -> 1 inside this function itself), when the hook is fired offhand;
  - p_view.ts's ClientEndServerFrame, every subsequent frame, as long as
    hookstate stays non-zero (this is what makes it "offhand": it runs
    independent of the equipped weapon's own think dispatch).

`client.isfiring` is unconditionally zeroed at the top and only set back to
1 in the hookstate-0 branch -- so despite running every frame, this only
counts as "firing" (for g_runes.ts's isfiring-gated hooks) on the exact
frame the hook launches, not while it is flying or pulling.

State machine (`client.hookstate`):
  0 (idle/starting): capture `hookangle` from the current view angle (a
     write-only field -- see g_local.ts's GClientT.hookangle comment, it is
     never read again anywhere in lmctf60), apply a small view-kick
     (`kick_origin`/`kick_angles[0] = -1`), advance to state 1, spawn the
     bolt via fire_hook at GRAPPLE_FIRE_HOOK_SPEED (800 u/s), and draw the
     cable immediately (falls through to case 1 in the same call -- the C
     source has no `break` after case 0, preserved here as an explicit
     fallthrough).
  1 (bolt in flight): just keep drawing the cable from the player to the
     bolt's current position.
  2 (pulling, hook_target locked): recompute the bolt's rendered position
     from `hook_target.absmin + hook_offset` (tracks a moving target),
     redraw the cable, then compute `dir` = bolt position - muzzle start
     and `speed` = |dir| (this is DISTANCE, reused as a velocity-shaping
     input, not literally a speed). `hooklength` is updated to this
     distance every frame (there is no smoothing). Velocity is then banded
     by distance:
       > 120:  dir scaled to GRAPPLE_FIRE_HOOK_SPEED magnitude (800); this
               branch also calls addGravity(ent) (SV_AddGravity in the C
               source), BUT -- confirmed by direct testing, a real,
               preserved C-source bug, not a porting error -- addGravity's
               write to `ent.velocity[2]` is unconditionally overwritten a
               few lines later by `VectorCopy(dir, ent.velocity)`, which
               every band (including this one) falls through to. Gravity is
               genuinely invoked here but its effect on velocity never
               survives to the end of the function; only in this band, and
               nowhere else, is gravity even nominally attempted.
       100-120: dir scaled to distance*5 (grows with distance, no gravity)
       80-100:  dir scaled to distance*4
       40-80:   dir scaled to distance*3
       20-40:   dir scaled to distance*2
       10-20:   dir scaled to distance*1
       <=10:    no band matches; `dir` stays a UNIT vector (magnitude ~1)
                from the prior VectorNormalize -- an intentionally tiny
                but non-zero pull that never fully "locks" the player in
                place the way ThreeWave's HANG state does (see
                p_weapon.ts's file-level divergence note / the port
                report's ThreeWave comparison).
     The result is copied into both `ent.velocity` and
     `client.oldvelocity` (the latter specifically to suppress fall
     damage on release, per the C comment).
  default: treated as a bug in the C source; aborts the hook.
=================
*/
export function Weapon_Hook_Fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  client.isfiring = 0;

  if (client.hookstate === 0) {
    VectorCopy(client.v_angle, client.hookangle);
  }

  const forward = vec3();
  const right = vec3();
  const offset = vec3();
  const start = vec3();
  AngleVectors(client.v_angle, forward, right, null);
  VectorSet(offset, 8, 8, ent.viewheight - 8);
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);

  switch (client.hookstate) {
    case 0: {
      VectorScale(forward, -2, client.kick_origin);
      client.kick_angles[0] = -1;
      client.hookstate = 1;
      client.isfiring = 1;

      client.hook = fire_hook(ent, start, forward, GRAPPLE_FIRE_HOOK_SPEED);
      Draw_Hook(ent, start, client.hook.s.origin);
      // fallthrough to case 1, exactly like the C source (no `break`)
    }
    // eslint-disable-next-line no-fallthrough
    case 1: {
      if (client.hook !== null) {
        Draw_Hook(ent, start, client.hook.s.origin);
      }
      break;
    }
    case 2: {
      const hook = client.hook;
      if (hook !== null) {
        if (hook.hook_target !== null) {
          const dest = vec3();
          VectorAdd(hook.hook_target.absmin, hook.hook_offset, dest);
          VectorCopy(dest, hook.s.origin);
        }
        Draw_Hook(ent, start, hook.s.origin);

        const dir = vec3();
        VectorSubtract(hook.s.origin, start, dir);
        const speed = VectorLength(dir);

        if (!client.hooklength) client.hooklength = speed;
        client.hooklength = speed;
        VectorNormalize(dir);

        if (speed > 120) {
          VectorScale(dir, GRAPPLE_PULL_SPEED, dir);
          addGravity(ent);
        } else if (speed > 100) {
          VectorScale(dir, speed * 5, dir);
        } else if (speed > 80) {
          VectorScale(dir, speed * 4, dir);
        } else if (speed > 40) {
          VectorScale(dir, speed * 3, dir);
        } else if (speed > 20) {
          VectorScale(dir, speed * 2, dir);
        } else if (speed > 10) {
          VectorScale(dir, speed * 1, dir);
        }

        VectorCopy(dir, ent.velocity);
        VectorCopy(ent.velocity, client.oldvelocity);
      } else {
        client.hookstate = 0;
      }
      break;
    }
    default:
      ctf_hook_abort(ent);
      break;
  }
}

// `SV_AddGravity` (g_phys.c, not yet ported to src/lmctf) -- ported inline
// here as the one-line function it is everywhere else in this codebase
// (see src/ctf/g_phys.ts's SV_AddGravity), rather than pulling in the rest
// of g_phys.c for a single call site. Reported as a follow-up to replace
// with a real import once src/lmctf/g_phys.ts exists.
function addGravity(ent: EdictT): void {
  const sv_gravity = gameCvars.sv_gravity;
  const gravityValue = sv_gravity === null ? 800 : sv_gravity.value;
  ent.velocity[2] -= ent.gravity * gravityValue * 0.1; // FRAMETIME
}

/*
=================
Weapon_Hook (lmctf60/p_weapon.c) -- NOT PORTED (see file header).

This is only reached when the grapple is the client's current equipped
weapon (normal weapon-frame dispatch, e.g. after "use Grappling Hook" in
non-offhand mode, or if a player manually switches to it even while
CTF_OFFHAND_HOOK is on). Throws rather than silently no-op-ing so a caller
that reaches this path gets an honest, loud failure instead of a quiet
behavior gap.
=================
*/
export function Weapon_Hook(_ent: EdictT): void {
  throw new Error(
    "Weapon_Hook (equipped-weapon dispatch) is not ported: depends on Weapon_Generic/ChangeWeapon/" +
      "NoAmmoWeaponChange, none of which exist in src/lmctf yet. The offhand path " +
      "(Cmd_Hook_f -> Weapon_Hook_Fire, g_cmds.ts/p_weapon.ts) does not go through this function.",
  );
}
