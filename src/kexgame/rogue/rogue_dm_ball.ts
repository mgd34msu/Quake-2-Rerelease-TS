// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// rogue_dm_ball.cpp -- the ROGUE mission pack's "Deathball" deathmatch
// gametype (2023 Quake II re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/rogue/rogue_dm_ball.cpp (687
// lines, C++17): the carryable/pushable ball entity (spawn, respawn,
// crush-damage-on-touch, pain/die), the goal trigger, the one-way speed-
// change field, damage/knockback rescaling between players and the ball,
// and the `dm_game_rt` vtable hooks (`DBall_GameInit`/`DBall_PostInitSetup`/
// `DBall_ClientBegin`/`DBall_SelectSpawnPoint`/`DBall_ChangeDamage`/
// `DBall_ChangeKnockback`/`DBall_CheckDMRules`) g_rogue_newdm.ts's
// `InitGameRules` wires up under `RDM_DEATHBALL`.
//
// ============================================================================
// GAMETYPE ACTIVATION -- see rogue_dm_tag.ts's identical note
// ============================================================================
// Every function here is reached only via g_rogue_newdm.ts's `InitGameRules`
// (itself reached only when `gamerules` is nonzero -- default 0), or via the
// `SP_dm_dball_*` spawn functions, reached only when a map places one of
// those entities AND `gamerules` is already `RDM_DEATHBALL` (3) when it
// spawns. No server this port line can currently configure reaches either
// path (see g_main.ts's/g_combat.ts's/p_client.ts's own "DMGame -- concrete
// faithful value, not a stub" precedent). Ported for real anyway, same
// reasoning as rogue_dm_tag.ts.
//
// ============================================================================
// QUIRKS (bug-for-bug, not "fixed") -- MOST IMPORTANT ONE FIRST
// ============================================================================
// - `DBall_ClientBegin` and `DBall_GoalTouch`'s ENTIRE bodies are wrapped in
//   `#if 0 ... #endif` in the shipped C++ source (rogue_dm_ball.cpp:60-107
//   and 296-366) -- preprocessed out of the compiled re-release binary
//   entirely, not merely unreachable at runtime. `DBall_ClientBegin` is
//   therefore a true no-op (team-skin auto-assignment code that was written
//   but never shipped), and **the goal trigger's touch handler does
//   NOTHING** -- deathball goals in the shipped re-release never actually
//   score, free the ball, or call `G_UseTargets`; the entire scoring flow
//   documented in the `#if 0` block (team-score bump, per-player frag
//   scoring, `DBall_BallDie`, `G_UseTargets`) is dead source, not dead
//   code-path -- it was never even compiled. Ported bug-for-bug: both
//   functions' bodies are empty here, matching the actual shipped binary,
//   not the aspirational commented-out C++ that never built. `DBall_GoalTouch`
//   is still `RegisterTouch`'d and wired to `self.touch` in
//   `SP_dm_dball_goal` (matching the C++ source's own `self->touch =
//   DBall_GoalTouch;"), since the *touch itself* is real -- it just happens
//   to do nothing once invoked.
// - `DBall_SelectSpawnPoint`'s team-skin-based spawn-point selection is
//   ALSO `#if 0`'d (rogue_dm_ball.cpp:118-159) -- the live tail is just
//   `bool lm = false; return SelectSpawnPoint(ent, origin, angles,
//   force_spawn, lm);`, a plain passthrough to the normal spawn-point
//   picker. Ported as exactly that passthrough (bridged through this port's
//   boxed `SelectSpawnPoint` calling convention -- see below).
// - `DBall_BallTouch`'s `dot = dir.dot(ent->velocity)` uses the UN-
//   normalized `dir` (`ent->s.origin - other->s.origin`), not a unit
//   vector, so `dot > 0.7f` is really "is the ball's velocity component
//   toward `other`, scaled by distance, over 0.7" -- not a clean angle
//   check. Preserved exactly (not silently normalized to "fix" it).
// - `DBall_ChangeKnockback`'s knockback-scaling `switch` and the "zero
//   knockback" `Com_PrintFmt` warning are transcribed verbatim, including
//   the FIXME comment about quad/double not being accounted for.
//
// ============================================================================
// SELECTSPAWNPOINT BRIDGING (DmGameRt.SelectSpawnPoint vs this port's
// boxed p_client.ts's SelectSpawnPoint)
// ============================================================================
// `DmGameRt.SelectSpawnPoint` (g_local_types.ts) is typed `(ent, origin:
// Vec3, angles: Vec3, force_spawn) => boolean` -- the C++ source's `vec3_t
// &origin, vec3_t &angles` references map onto this port's mutable
// `Float32Array`-backed `Vec3` directly (in-place mutation is a legal
// "out parameter", no boxing needed for the *outer* interface). But this
// port's own `SelectSpawnPoint` (p_client.ts) instead uses a one-element-
// tuple "box" convention (`[Vec3]`) for its own out-params, needed
// internally because it sometimes *replaces* the vector reference rather
// than mutating it in place. `DBall_SelectSpawnPoint` bridges the two:
// wraps the caller's `origin`/`angles` in throwaway boxes, calls the real
// `SelectSpawnPoint`, then copies the box's result back into the caller's
// arrays with `VectorCopy` on success (matching C++ reference-out-param
// semantics exactly; a no-op copy back into a fresh array on failure since
// nothing reads `origin`/`angles` when the return value is `false`).

import { type Vec3, vec3, VectorCopy } from "../../shared/math";
import {
  ServerCommandT,
  KexTempEventT,
  KexMulticastT,
  KexEntityEventT,
  PrintTypeT,
  type KexTraceT,
  CvarFlagsT,
  SolidT,
  SvflagsT,
  MASK_MONSTERSOLID,
} from "../../kexapi/game";
import { type EdictT, ModIdT, MovetypeT, DamageflagsT } from "../g_local";
import type { ModT } from "../g_local_types";
import { gi, level } from "../g_main_globals";
import { Gtime_add, Gtime_from_sec } from "../gtime";
import { RegisterThink, RegisterTouch, RegisterPain, RegisterDie, type ThinkFn, type TouchFn, type PainFn, type DieFn } from "../g_save_registry";
import { vec3_origin, vec3_sub, vec3_dot, vec3_length, vec3_normalized, vec3_muls } from "../q_vec3";
import { G_FindByString, G_SetMovedir, KillBox } from "../g_utils";
import { T_Damage } from "../g_combat";
import { SelectSpawnPoint } from "../p_client";
import { EndDMLevel } from "../g_main";
import { SpawnFlags_from, SpawnFlags_has, type SpawnFlags } from "../spawnflags";
import { irandom } from "../q_std";

function cvarInt(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): number {
  const c = gi.cvar(name, def, flags);
  return c === null ? Math.trunc(Number(def)) : Math.trunc(c.value);
}

function deathmatchEnabled(): boolean {
  return cvarInt("deathmatch", "0", CvarFlagsT.CVAR_LATCH) !== 0;
}

function gamerulesIsDeathball(): boolean {
  return cvarInt("gamerules", "0", CvarFlagsT.CVAR_LATCH) === 3 /* RDM_DEATHBALL */;
}

/** `gi.LocBroadcast_Print` has no ported counterpart -- see g_items.ts's own
 *  identical `LocClient_Print` note (no localization backend anywhere in
 *  this port; thin pass-through to the plain, non-localized primitive). */
function LocBroadcast_Print(printlevel: PrintTypeT, message: string): void {
  gi.Broadcast_Print(printlevel, message);
}

function G_FreeEdict(ent: EdictT): void {
  ent.inuse = false;
}

// ---------------------------------------------------------------------------
// module-level state -- rogue_dm_ball.cpp:16-23
// ---------------------------------------------------------------------------

let dball_ball_entity: EdictT | null = null;
let dball_ball_startpt_count = 0;
let dball_team1_goalscore = 0;
let dball_team2_goalscore = 0;

let goallimit_value = 0;

// ---------------------------------------------------------------------------
// Game rules (rogue_dm_ball.cpp:35-56)
// ---------------------------------------------------------------------------

/** rogue_dm_ball.cpp:38-56: `int DBall_CheckDMRules()`. */
export function DBall_CheckDMRules(): number {
  if (goallimit_value !== 0) {
    if (dball_team1_goalscore >= goallimit_value) {
      LocBroadcast_Print(PrintTypeT.PRINT_HIGH, "Team 1 Wins.\n");
    } else if (dball_team2_goalscore >= goallimit_value) {
      LocBroadcast_Print(PrintTypeT.PRINT_HIGH, "Team 2 Wins.\n");
    } else {
      return 0;
    }

    EndDMLevel();
    return 1;
  }

  return 0;
}

/** rogue_dm_ball.cpp:58-107: `void DBall_ClientBegin(edict_t *ent)` -- see
 *  file header's QUIRKS note: the entire body is `#if 0`'d in the shipped
 *  source, so this is a faithful no-op, not a placeholder. */
export function DBall_ClientBegin(_ent: EdictT): void {
  // intentionally empty -- see file header.
}

/** rogue_dm_ball.cpp:115-159: `bool DBall_SelectSpawnPoint(edict_t *ent,
 *  vec3_t &origin, vec3_t &angles, bool force_spawn)` -- see file header's
 *  "SELECTSPAWNPOINT BRIDGING" note for the live (non-`#if 0`) tail this
 *  ports. */
export function DBall_SelectSpawnPoint(ent: EdictT, origin: Vec3, angles: Vec3, force_spawn: boolean): boolean {
  const originBox: [Vec3] = [origin];
  const anglesBox: [Vec3] = [angles];
  const landmarkBox: [boolean] = [false];
  const ok = SelectSpawnPoint(ent, originBox, anglesBox, force_spawn, landmarkBox);
  if (ok) {
    VectorCopy(originBox[0], origin);
    VectorCopy(anglesBox[0], angles);
  }
  return ok;
}

/** rogue_dm_ball.cpp:163-181: `void DBall_GameInit()`. */
export function DBall_GameInit(): void {
  // we don't want a minimum speed for friction to take effect. this will
  // allow any knockback to move stuff.
  gi.cvar_forceset("sv_stopspeed", "0");
  dball_team1_goalscore = 0;
  dball_team2_goalscore = 0;

  gi.cvar_forceset("g_no_mines", "1");
  gi.cvar_forceset("g_no_nukes", "1");
  gi.cvar_forceset("g_dm_no_stack_double", "1");
  gi.cvar_forceset("g_friendly_fire", "0");

  gi.cvar("dball_team1_skin", "male/ctf_r", CvarFlagsT.CVAR_NOFLAGS);
  gi.cvar("dball_team2_skin", "male/ctf_b", CvarFlagsT.CVAR_NOFLAGS);
  const goallimit = gi.cvar("goallimit", "0", CvarFlagsT.CVAR_NOFLAGS);
  goallimit_value = goallimit === null ? 0 : Math.trunc(goallimit.value);
}

/** rogue_dm_ball.cpp:184-198: `void DBall_PostInitSetup()`. */
export function DBall_PostInitSetup(): void {
  // turn teleporter destinations nonsolid.
  let e = G_FindByString(null, "classname", "misc_teleporter_dest");
  while (e !== null) {
    e.solid = SolidT.SOLID_NOT;
    gi.linkentity(e);
    e = G_FindByString(e, "classname", "misc_teleporter_dest");
  }

  // count the ball start points
  dball_ball_startpt_count = 0;
  e = G_FindByString(null, "classname", "dm_dball_ball_start");
  while (e !== null) {
    dball_ball_startpt_count++;
    e = G_FindByString(e, "classname", "dm_dball_ball_start");
  }

  if (dball_ball_startpt_count === 0) gi.Com_Print("No Deathball start points!\n");
}

/**
 * rogue_dm_ball.cpp:206-219: `int DBall_ChangeDamage(edict_t *targ, edict_t
 * *attacker, int damage, mod_t mod)` -- half damage between players, full
 * (well, cut to 1) if it involves the ball entity.
 */
export function DBall_ChangeDamage(targ: EdictT, attacker: EdictT, damage: number, _mod: ModT): number {
  // cut player -> ball damage to 1
  if (targ === dball_ball_entity) return 1;

  // damage player -> player is halved
  if (attacker !== dball_ball_entity) return Math.trunc(damage / 2);

  return damage;
}

/** rogue_dm_ball.cpp:227-280: `int DBall_ChangeKnockback(edict_t *targ, edict_t *attacker, int knockback, mod_t mod)`. */
export function DBall_ChangeKnockback(targ: EdictT, _attacker: EdictT, knockbackIn: number, mod: ModT): number {
  let knockback = knockbackIn;

  if (targ !== dball_ball_entity) return knockback;

  if (knockback < 1) {
    // FIXME - these don't account for quad/double
    if (mod.id === ModIdT.MOD_ROCKET) knockback = 70;
    else if (mod.id === ModIdT.MOD_BFG_EFFECT) knockback = 90;
    else gi.Com_Print(`zero knockback, mod ${mod.id}\n`);
  } else {
    // FIXME - change this to an array?
    switch (mod.id) {
      case ModIdT.MOD_BLASTER:
        knockback *= 3;
        break;
      case ModIdT.MOD_SHOTGUN:
        knockback = Math.trunc((knockback * 3) / 8);
        break;
      case ModIdT.MOD_SSHOTGUN:
        knockback = Math.trunc(knockback / 3);
        break;
      case ModIdT.MOD_MACHINEGUN:
        knockback = Math.trunc((knockback * 3) / 2);
        break;
      case ModIdT.MOD_HYPERBLASTER:
        knockback *= 4;
        break;
      case ModIdT.MOD_GRENADE:
      case ModIdT.MOD_HANDGRENADE:
      case ModIdT.MOD_PROX:
      case ModIdT.MOD_G_SPLASH:
      case ModIdT.MOD_HG_SPLASH:
      case ModIdT.MOD_HELD_GRENADE:
      case ModIdT.MOD_TRACKER:
      case ModIdT.MOD_DISINTEGRATOR:
        knockback = Math.trunc(knockback / 2);
        break;
      case ModIdT.MOD_R_SPLASH:
        knockback = Math.trunc((knockback * 3) / 2);
        break;
      case ModIdT.MOD_RAILGUN:
      case ModIdT.MOD_HEATBEAM:
        knockback = Math.trunc(knockback / 3);
        break;
      default:
        break;
    }
  }

  return knockback;
}

// ---------------------------------------------------------------------------
// Goals (rogue_dm_ball.cpp:284-368)
// ---------------------------------------------------------------------------

/** rogue_dm_ball.cpp:292-366: `TOUCH(DBall_GoalTouch)` -- see file header's
 *  QUIRKS note: the entire body is `#if 0`'d in the shipped source, so this
 *  touch callback is a faithful no-op, not a placeholder for unported
 *  scoring logic. */
export const DBall_GoalTouch: TouchFn = RegisterTouch(
  "DBall_GoalTouch",
  (_self: EdictT, _other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
    // intentionally empty -- see file header.
  },
);

// ---------------------------------------------------------------------------
// Ball (rogue_dm_ball.cpp:370-491)
// ---------------------------------------------------------------------------

/** rogue_dm_ball.cpp:370-393: `edict_t *PickBallStart(edict_t *ent)`. */
export function PickBallStart(_ent: EdictT): EdictT | null {
  const which = irandom(dball_ball_startpt_count);
  let e = G_FindByString(null, "classname", "dm_dball_ball_start");
  let current = 0;

  while (e !== null) {
    current++;
    if (current === which) return e;
    e = G_FindByString(e, "classname", "dm_dball_ball_start");
  }

  if (current === 0) gi.Com_Print("No ball start points found!\n");

  return G_FindByString(null, "classname", "dm_dball_ball_start");
}

/**
 * rogue_dm_ball.cpp:395-421: `TOUCH(DBall_BallTouch)` -- if the ball hit
 * another player, hurt them. See file header's QUIRKS note on the
 * un-normalized `dir` used in the `dot` check.
 */
export const DBall_BallTouch: TouchFn = RegisterTouch(
  "DBall_BallTouch",
  (ent: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
    if (!other.takedamage) return;

    // hit a player
    if (other.client !== null) {
      if (ent.velocity[0] !== 0 || ent.velocity[1] !== 0 || ent.velocity[2] !== 0) {
        const speed = vec3_length(ent.velocity);

        const dir = vec3_sub(ent.s.origin, other.s.origin);
        const dot = vec3_dot(dir, ent.velocity);

        if (dot > 0.7) {
          T_Damage(
            other,
            ent,
            ent,
            vec3_origin,
            ent.s.origin,
            vec3_origin,
            Math.trunc(speed / 10),
            Math.trunc(speed / 10),
            DamageflagsT.DAMAGE_NONE,
            { id: ModIdT.MOD_DBALL_CRUSH, friendly_fire: false, no_point_loss: false },
          );
        }
      }
    }
  },
);

/** rogue_dm_ball.cpp:426-432: `PAIN(DBall_BallPain)`. */
export const DBall_BallPain: PainFn = RegisterPain("DBall_BallPain", (self: EdictT, other: EdictT, _kick: number, _damage: number, _mod: ModT): void => {
  self.enemy = other;
  self.health = self.max_health;
});

/** rogue_dm_ball.cpp:434-452: `DIE(DBall_BallDie)`. */
export const DBall_BallDie: DieFn = RegisterDie(
  "DBall_BallDie",
  (self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3, _mod: ModT): void => {
    // do the splash effect
    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(KexTempEventT.TE_DBALL_GOAL);
    gi.WritePosition(self.s.origin);
    gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PVS, false);

    self.s.angles = vec3(0, 0, 0);
    self.velocity = vec3(0, 0, 0);
    self.avelocity = vec3(0, 0, 0);

    // make it invisible and desolid until respawn time
    self.solid = SolidT.SOLID_NOT;
    self.think = DBall_BallRespawn;
    self.nextthink = Gtime_add(level.time, Gtime_from_sec(2));
    gi.linkentity(self);
  },
);

/** rogue_dm_ball.cpp:454-491: `THINK(DBall_BallRespawn)`. */
export const DBall_BallRespawn: ThinkFn = RegisterThink("DBall_BallRespawn", (self: EdictT): void => {
  // do the splash effect
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_DBALL_GOAL);
  gi.WritePosition(self.s.origin);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PVS, false);

  // move the ball and stop it
  const start = PickBallStart(self);
  if (start !== null) {
    self.s.origin = start.s.origin;
    self.s.old_origin = start.s.origin;
  }

  self.s.angles = vec3(0, 0, 0);
  self.velocity = vec3(0, 0, 0);
  self.avelocity = vec3(0, 0, 0);

  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/objects/dball/tris.md2");
  self.s.event = KexEntityEventT.EV_PLAYER_TELEPORT;
  self.groundentity = null;

  gi.linkentity(self);

  // kill anything at the destination
  KillBox(self, false);
});

// ---------------------------------------------------------------------------
// Speed changes (rogue_dm_ball.cpp:495-524)
// ---------------------------------------------------------------------------

const SPAWNFLAG_DBALL_SPEED_ONEWAY: SpawnFlags = SpawnFlags_from(0x0001);

/** rogue_dm_ball.cpp:493-524: `TOUCH(DBall_SpeedTouch)`. */
export const DBall_SpeedTouch: TouchFn = RegisterTouch(
  "DBall_SpeedTouch",
  (self: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
    if (other !== dball_ball_entity) return;

    if (self.timestamp >= level.time) return;

    if (vec3_length(other.velocity) < 1) return;

    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_DBALL_SPEED_ONEWAY)) {
      const vel = vec3_normalized(other.velocity);
      const dot = vec3_dot(vel, self.movedir);
      if (dot < 0.8) return;
    }

    self.timestamp = Gtime_add(level.time, Gtime_from_sec(self.delay));
    other.velocity = vec3_muls(other.velocity, self.speed);
  },
);

// ---------------------------------------------------------------------------
// Spawn functions (rogue_dm_ball.cpp:526-687)
// ---------------------------------------------------------------------------

const SPAWNFLAG_DBALL_GOAL_TEAM1: SpawnFlags = SpawnFlags_from(0x0001);
void SPAWNFLAG_DBALL_GOAL_TEAM1; // unused in the live (non-`#if 0`) code path -- see file header QUIRKS note; kept to match the C++ source's own `[[maybe_unused]]` constant 1:1.

function gatedSpawn(self: EdictT): boolean {
  if (!deathmatchEnabled()) {
    G_FreeEdict(self);
    return false;
  }
  if (!gamerulesIsDeathball()) {
    G_FreeEdict(self);
    return false;
  }
  return true;
}

/*QUAKED dm_dball_ball (1 .5 .5) (-48 -48 -48) (48 48 48) ONEWAY
Deathball Ball
*/
/** rogue_dm_ball.cpp:527-563: `void SP_dm_dball_ball(edict_t *self)`. */
export function SP_dm_dball_ball(self: EdictT): void {
  if (!gatedSpawn(self)) return;

  dball_ball_entity = self;

  self.s.modelindex = gi.modelindex("models/objects/dball/tris.md2");
  self.mins = vec3(-32, -32, -32);
  self.maxs = vec3(32, 32, 32);
  self.solid = SolidT.SOLID_BBOX;
  self.movetype = MovetypeT.MOVETYPE_NEWTOSS;
  self.clipmask = MASK_MONSTERSOLID;

  self.takedamage = true;
  self.mass = 50;
  self.health = 50000;
  self.max_health = 50000;
  self.pain = DBall_BallPain;
  self.die = DBall_BallDie;
  self.touch = DBall_BallTouch;

  gi.linkentity(self);
}

/*QUAKED dm_dball_team1_start (1 .5 .5) (-16 -16 -24) (16 16 32)
Deathball team 1 start point
*/
/** rogue_dm_ball.cpp:565-580: `void SP_dm_dball_team1_start(edict_t *self)`. */
export function SP_dm_dball_team1_start(self: EdictT): void {
  gatedSpawn(self);
}

/*QUAKED dm_dball_team2_start (1 .5 .5) (-16 -16 -24) (16 16 32)
Deathball team 2 start point
*/
/** rogue_dm_ball.cpp:582-597: `void SP_dm_dball_team2_start(edict_t *self)`. */
export function SP_dm_dball_team2_start(self: EdictT): void {
  gatedSpawn(self);
}

/*QUAKED dm_dball_ball_start (1 .5 .5) (-48 -48 -48) (48 48 48)
Deathball ball start point
*/
/** rogue_dm_ball.cpp:599-618: `void SP_dm_dball_ball_start(edict_t *self)`. */
export function SP_dm_dball_ball_start(self: EdictT): void {
  gatedSpawn(self);
}

/*QUAKED dm_dball_speed_change (1 .5 .5) ? ONEWAY
Deathball ball speed changing field.

speed: multiplier for speed (.5 = half, 2 = double, etc) (default = double)
angle: used with ONEWAY so speed change is only one way.
delay: time between speed changes (default: 0.2 sec)
*/
/** rogue_dm_ball.cpp:620-658: `void SP_dm_dball_speed_change(edict_t *self)`. */
export function SP_dm_dball_speed_change(self: EdictT): void {
  if (!gatedSpawn(self)) return;

  if (self.speed === 0) self.speed = 2;
  if (self.delay === 0) self.delay = 0.2;

  self.touch = DBall_SpeedTouch;
  self.solid = SolidT.SOLID_TRIGGER;
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.svflags |= SvflagsT.SVF_NOCLIENT;

  if (self.s.angles[0] !== 0 || self.s.angles[1] !== 0 || self.s.angles[2] !== 0) {
    G_SetMovedir(self.s.angles, self.movedir);
  } else {
    self.movedir = vec3(1, 0, 0);
  }

  gi.setmodel(self, self.model ?? "");
  gi.linkentity(self);
}

/*QUAKED dm_dball_goal (1 .5 .5) ? TEAM1 TEAM2
Deathball goal

Team1/Team2 - beneficiary of this goal. when the ball enters this goal, the beneficiary team will score.

"wait": score to be given for this goal (default 10) player gets score+5.
*/
/** rogue_dm_ball.cpp:660-687: `void SP_dm_dball_goal(edict_t *self)`. */
export function SP_dm_dball_goal(self: EdictT): void {
  if (!gatedSpawn(self)) return;

  if (self.wait === 0) self.wait = 10;

  self.touch = DBall_GoalTouch;
  self.solid = SolidT.SOLID_TRIGGER;
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.svflags |= SvflagsT.SVF_NOCLIENT;

  if (self.s.angles[0] !== 0 || self.s.angles[1] !== 0 || self.s.angles[2] !== 0) {
    G_SetMovedir(self.s.angles, self.movedir);
  }

  gi.setmodel(self, self.model ?? "");
  gi.linkentity(self);
}
