// dm_ball.c
// pmack
// june 98
//
// "Deathball" game rules: a MOVETYPE_NEWTOSS ball entity two skin-based
// teams knock into each other's goal. Never wired into DMGame in the
// shipped rerelease -- g_newdm.ts's InitGameRules keeps the RDM_DEATHBALL
// case commented out exactly as the C source has it -- but the file is
// still a complete, callable port per this unit's SCOPE.
//
// `edict_t *dball_ball_entity`, `dball_ball_startpt_count`,
// `dball_team1_goalscore`, `dball_team2_goalscore`, and the
// `dball_team1_skin`/`dball_team2_skin`/`goallimit` cvars are C globals
// private to this file (nothing outside dm_ball.c reads them) -- module
// state, same treatment as dm_tag.ts's `tag` holder.

import { DotProduct, random, VectorClear, VectorCompare, VectorCopy, VectorLength, VectorNormalize, VectorScale, VectorSet, VectorSubtract, vec3, vec3_origin, type Vec3 } from "../shared/math";
import {
  type CplaneT,
  type CsurfaceT,
  type CvarT,
  DF_NO_FRIENDLY_FIRE,
  DF_NO_MINES,
  DF_NO_NUKES,
  DF_NO_STACK_DOUBLE,
  DF_SKINTEAMS,
  EntityEventT,
  Info_SetValueForKey,
  Info_ValueForKey,
  MASK_MONSTERSOLID,
  MulticastT,
  PRINT_HIGH,
  TempEventT,
} from "../shared/q_shared";
import { SolidT, SVF_NOCLIENT } from "./game";
import {
  type EdictT,
  DamageT,
  g_edicts,
  game,
  gameCvars,
  gi,
  level,
  MOD_BFG_EFFECT,
  MOD_BLASTER,
  MOD_DBALL_CRUSH,
  MOD_DISINTEGRATOR,
  MOD_G_SPLASH,
  MOD_GRENADE,
  MOD_HANDGRENADE,
  MOD_HEATBEAM,
  MOD_HELD_GRENADE,
  MOD_HG_SPLASH,
  MOD_HYPERBLASTER,
  MOD_MACHINEGUN,
  MOD_PROX,
  MOD_R_SPLASH,
  MOD_RAILGUN,
  MOD_ROCKET,
  MOD_SHOTGUN,
  MOD_SSHOTGUN,
  MOD_TRACKER,
  MovetypeT,
  RDM_DEATHBALL,
  svc_temp_entity,
} from "./g_local";
import { T_Damage } from "./g_combat";
import { G_Find, G_FreeEdict, G_SetMovedir, G_UseTargets, KillBox } from "./g_utils";
import { ClientUserinfoChanged, PlayersRangeFromSpot, SelectSpawnPoint } from "./p_client";
import { EndDMLevel } from "./g_main";

const DBALL_GOAL_TEAM1 = 0x0001;
const DBALL_GOAL_TEAM2 = 0x0002;

// globals
let dball_ball_entity: EdictT | null = null;
let dball_ball_startpt_count = 0;
let dball_team1_goalscore = 0;
let dball_team2_goalscore = 0;

let dball_team1_skin: CvarT | null = null;
let dball_team2_skin: CvarT | null = null;
let goallimit: CvarT | null = null;

function cvarStr(c: CvarT | null): string {
  return c === null ? "" : c.string;
}
function cvarNum(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}

function requireClient(ent: EdictT, what: string): NonNullable<EdictT["client"]> {
  if (ent.client === null) {
    throw new Error(`${what}.client is null (C dereferences it unconditionally here)`);
  }
  return ent.client;
}

// **************************
// Game rules
// **************************

export function DBall_CheckDMRules(): number {
  if (goallimit !== null && goallimit.value) {
    if (dball_team1_goalscore >= goallimit.value) {
      gi.bprintf(PRINT_HIGH, "Team 1 Wins.\n");
    } else if (dball_team2_goalscore >= goallimit.value) {
      gi.bprintf(PRINT_HIGH, "Team 2 Wins.\n");
    } else {
      return 0;
    }

    EndDMLevel();
    return 1;
  }

  return 0;
}

//==================
//==================
export function DBall_ClientBegin(ent: EdictT): void {
  let team1 = 0;
  let team2 = 0;
  let unassigned = 0;

  for (let j = 1; j <= game.maxclients; j++) {
    const other = g_edicts[j];
    if (other === undefined) continue;
    if (!other.inuse) continue;
    if (other.client === null) continue;
    if (other === ent) continue; // don't count the new player

    const value = Info_ValueForKey(other.client.pers.userinfo, "skin");
    if (value.includes("/")) {
      if (cvarStr(dball_team1_skin) === value) team1++;
      else if (cvarStr(dball_team2_skin) === value) team2++;
      else unassigned++;
    } else {
      unassigned++;
    }
  }

  const client = requireClient(ent, "DBall_ClientBegin: ent");
  if (team1 > team2) {
    gi.dprintf("assigned to team 2\n");
    client.pers.userinfo = Info_SetValueForKey(client.pers.userinfo, "skin", cvarStr(dball_team2_skin));
  } else {
    gi.dprintf("assigned to team 1\n");
    client.pers.userinfo = Info_SetValueForKey(client.pers.userinfo, "skin", cvarStr(dball_team1_skin));
  }

  ClientUserinfoChanged(ent, client.pers.userinfo);

  if (unassigned) gi.dprintf(`${unassigned} unassigned players present!\n`);
}

//==================
//==================
export function DBall_SelectSpawnPoint(ent: EdictT, origin: Vec3, angles: Vec3): void {
  const client = requireClient(ent, "DBall_SelectSpawnPoint: ent");
  const skin = Info_ValueForKey(client.pers.userinfo, "skin");
  let spottype: string;
  if (cvarStr(dball_team1_skin) === skin) spottype = "dm_dball_team1_start";
  else if (cvarStr(dball_team2_skin) === skin) spottype = "dm_dball_team2_start";
  else spottype = "info_player_deathmatch";

  let spot: EdictT | null = null;
  let bestspot: EdictT | null = null;
  let bestdistance = 0;
  while ((spot = G_Find(spot, "classname", spottype)) !== null) {
    const bestplayerdistance = PlayersRangeFromSpot(spot);

    if (bestplayerdistance > bestdistance) {
      bestspot = spot;
      bestdistance = bestplayerdistance;
    }
  }

  if (bestspot !== null) {
    VectorCopy(bestspot.s.origin, origin);
    origin[2] += 9;
    VectorCopy(bestspot.s.angles, angles);
    return;
  }

  // if we didn't find an appropriate spawnpoint, just
  // call the standard one.
  SelectSpawnPoint(ent, origin, angles);
}

//==================
//==================
export function DBall_GameInit(): void {
  // we don't want a minimum speed for friction to take effect.
  // this will allow any knockback to move stuff.
  if (gameCvars.sv_stopspeed !== null) gameCvars.sv_stopspeed.value = 0;
  dball_team1_goalscore = 0;
  dball_team2_goalscore = 0;

  if (gameCvars.dmflags !== null) {
    gameCvars.dmflags.value =
      (cvarNum(gameCvars.dmflags) | 0) | DF_NO_MINES | DF_NO_NUKES | DF_NO_STACK_DOUBLE | DF_NO_FRIENDLY_FIRE | DF_SKINTEAMS;
  }

  dball_team1_skin = gi.cvar("dball_team1_skin", "male/ctf_r", 0);
  dball_team2_skin = gi.cvar("dball_team2_skin", "male/ctf_b", 0);
  goallimit = gi.cvar("goallimit", "0", 0);
}

//==================
//==================
export function DBall_PostInitSetup(): void {
  // turn teleporter destinations nonsolid.
  let e: EdictT | null = null;
  while ((e = G_Find(e, "classname", "misc_teleporter_dest")) !== null) {
    e.solid = SolidT.SOLID_NOT;
    gi.linkentity(e);
  }

  // count the ball start points
  dball_ball_startpt_count = 0;
  e = null;
  while ((e = G_Find(e, "classname", "dm_dball_ball_start")) !== null) {
    dball_ball_startpt_count++;
  }

  if (dball_ball_startpt_count === 0) gi.dprintf("No Deathball start points!\n");
}

//==================
// DBall_ChangeDamage - half damage between players. full if it involves
//		the ball entity
//==================
export function DBall_ChangeDamage(targ: EdictT, attacker: EdictT, damage: number, _mod: number): number {
  // cut player -> ball damage to 1
  if (targ === dball_ball_entity) return 1;

  // damage player -> player is halved
  if (attacker !== dball_ball_entity) return (damage / 2) | 0;

  return damage;
}

//==================
//==================
export function DBall_ChangeKnockback(targ: EdictT, _attacker: EdictT, knockbackIn: number, mod: number): number {
  let knockback = knockbackIn;

  if (targ !== dball_ball_entity) return knockback;

  if (knockback < 1) {
    // FIXME - these don't account for quad/double
    if (mod === MOD_ROCKET) knockback = 70;
    else if (mod === MOD_BFG_EFFECT) knockback = 90;
    else gi.dprintf(`zero knockback, mod ${mod}\n`);
  } else {
    // FIXME - change this to an array?
    switch (mod) {
      case MOD_BLASTER:
        knockback *= 3;
        break;
      case MOD_SHOTGUN:
        knockback = ((knockback * 3) / 8) | 0;
        break;
      case MOD_SSHOTGUN:
        knockback = (knockback / 3) | 0;
        break;
      case MOD_MACHINEGUN:
        knockback = ((knockback * 3) / 2) | 0;
        break;
      case MOD_HYPERBLASTER:
        knockback *= 4;
        break;
      case MOD_GRENADE:
      case MOD_HANDGRENADE:
      case MOD_PROX:
      case MOD_G_SPLASH:
      case MOD_HG_SPLASH:
      case MOD_HELD_GRENADE:
      case MOD_TRACKER:
      case MOD_DISINTEGRATOR:
        knockback = (knockback / 2) | 0;
        break;
      case MOD_R_SPLASH:
        knockback = ((knockback * 3) / 2) | 0;
        break;
      case MOD_RAILGUN:
      case MOD_HEATBEAM:
        knockback = (knockback / 3) | 0;
        break;
      default:
        break;
    }
  }

  return knockback;
}

// **************************
// Goals
// **************************

export function DBall_GoalTouch(self: EdictT, other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  if (other !== dball_ball_entity) return;

  self.health = self.max_health;

  // determine which team scored, and bump the team score
  let team_score: number;
  if (self.spawnflags & DBALL_GOAL_TEAM1) {
    dball_team1_goalscore += self.wait;
    team_score = 1;
  } else {
    dball_team2_goalscore += self.wait;
    team_score = 2;
  }

  // bump the score for everyone on the correct team.
  for (let j = 1; j <= game.maxclients; j++) {
    const ent = g_edicts[j];
    if (ent === undefined) continue;
    if (!ent.inuse) continue;
    if (ent.client === null) continue;

    let scorechange: number;
    if (ent === other.enemy) scorechange = self.wait + 5;
    else scorechange = self.wait;

    const value = Info_ValueForKey(ent.client.pers.userinfo, "skin");
    if (value.includes("/")) {
      if (cvarStr(dball_team1_skin) === value) {
        if (team_score === 1) ent.client.resp.score += scorechange;
        else if (other.enemy === ent) ent.client.resp.score -= scorechange;
      } else if (cvarStr(dball_team2_skin) === value) {
        if (team_score === 2) ent.client.resp.score += scorechange;
        else if (other.enemy === ent) ent.client.resp.score -= scorechange;
      } else {
        gi.dprintf("unassigned player!!!!\n");
      }
    }
  }

  if (other.enemy !== null) {
    const enemyClient = requireClient(other.enemy, "DBall_GoalTouch: other.enemy");
    gi.dprintf(`score for team ${team_score} by ${enemyClient.pers.netname}\n`);
  } else {
    gi.dprintf(`score for team ${team_score} by someone\n`);
  }

  const enemy = other.enemy;
  if (enemy === null) throw new Error("DBall_GoalTouch: other.enemy is null (C dereferences it unconditionally here)");
  DBall_BallDie(other, enemy, enemy, 0, vec3_origin);

  G_UseTargets(self, other);
}

// **************************
// Ball
// **************************

export function PickBallStart(_ent: EdictT): EdictT | null {
  const which = Math.ceil(random() * dball_ball_startpt_count);
  let e: EdictT | null = null;
  let current = 0;

  while ((e = G_Find(e, "classname", "dm_dball_ball_start")) !== null) {
    current++;
    if (current === which) return e;
  }

  if (current === 0) gi.dprintf("No ball start points found!\n");

  return G_Find(null, "classname", "dm_dball_ball_start");
}

//==================
// DBall_BallTouch - if the ball hit another player, hurt them
//==================
export function DBall_BallTouch(ent: EdictT, other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  if (other.takedamage === DamageT.DAMAGE_NO) return;

  // hit a player
  if (other.client !== null) {
    if (ent.velocity[0] || ent.velocity[1] || ent.velocity[2]) {
      const speed = VectorLength(ent.velocity);

      const dir = vec3();
      VectorSubtract(ent.s.origin, other.s.origin, dir);
      const dot = DotProduct(dir, ent.velocity);

      if (dot > 0.7) {
        T_Damage(other, ent, ent, vec3_origin, ent.s.origin, vec3_origin, (speed / 10) | 0, (speed / 10) | 0, 0, MOD_DBALL_CRUSH);
      }
    }
  }
}

//==================
// DBall_BallPain
//==================
export function DBall_BallPain(self: EdictT, other: EdictT, _kick: number, _damage: number): void {
  self.enemy = other;
  self.health = self.max_health;
  // if(other->classname)
  //   gi.dprintf("hurt by %s -- %d\n", other->classname, self->health);
}

export function DBall_BallDie(self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3): void {
  // do the splash effect
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_DBALL_GOAL);
  gi.WritePosition(self.s.origin);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);

  VectorClear(self.s.angles);
  VectorClear(self.velocity);
  VectorClear(self.avelocity);

  // make it invisible and desolid until respawn time
  self.solid = SolidT.SOLID_NOT;
  // self.s.modelindex = 0;
  self.think = DBall_BallRespawn;
  self.nextthink = level.time + 2;
  gi.linkentity(self);
}

export function DBall_BallRespawn(self: EdictT): void {
  // do the splash effect
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_DBALL_GOAL);
  gi.WritePosition(self.s.origin);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);

  // move the ball and stop it
  const start = PickBallStart(self);
  if (start !== null) {
    VectorCopy(start.s.origin, self.s.origin);
    VectorCopy(start.s.origin, self.s.old_origin);
  }

  VectorClear(self.s.angles);
  VectorClear(self.velocity);
  VectorClear(self.avelocity);

  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/objects/dball/tris.md2");
  self.s.event = EntityEventT.EV_PLAYER_TELEPORT;
  self.groundentity = null;

  // kill anything at the destination
  KillBox(self);

  gi.linkentity(self);
}

// ************************
// SPEED CHANGES
// ************************

const DBALL_SPEED_ONEWAY = 1;

export function DBall_SpeedTouch(self: EdictT, other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  if (other !== dball_ball_entity) return;

  if (self.timestamp >= level.time) return;

  if (VectorLength(other.velocity) < 1) return;

  if (self.spawnflags & DBALL_SPEED_ONEWAY) {
    const vel = vec3();
    VectorCopy(other.velocity, vel);
    VectorNormalize(vel);
    const dot = DotProduct(vel, self.movedir);
    if (dot < 0.8) return;
  }

  self.timestamp = level.time + self.delay;
  VectorScale(other.velocity, self.speed, other.velocity);
}

// ************************
// SPAWN FUNCTIONS
// ************************

/*QUAKED dm_dball_ball (1 .5 .5) (-48 -48 -48) (48 48 48)
Deathball Ball
*/
export function SP_dm_dball_ball(self: EdictT): void {
  if (gameCvars.deathmatch === null || !gameCvars.deathmatch.value) {
    G_FreeEdict(self);
    return;
  }

  if (gameCvars.gamerules !== null && gameCvars.gamerules.value !== RDM_DEATHBALL) {
    G_FreeEdict(self);
    return;
  }

  dball_ball_entity = self;
  // VectorCopy (self->s.origin, dball_ball_startpt);

  self.s.modelindex = gi.modelindex("models/objects/dball/tris.md2");
  VectorSet(self.mins, -32, -32, -32);
  VectorSet(self.maxs, 32, 32, 32);
  self.solid = SolidT.SOLID_BBOX;
  self.movetype = MovetypeT.MOVETYPE_NEWTOSS;
  self.clipmask = MASK_MONSTERSOLID;

  self.takedamage = DamageT.DAMAGE_YES;
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
export function SP_dm_dball_team1_start(self: EdictT): void {
  if (gameCvars.deathmatch === null || !gameCvars.deathmatch.value) {
    G_FreeEdict(self);
    return;
  }
  if (gameCvars.gamerules !== null && gameCvars.gamerules.value !== RDM_DEATHBALL) {
    G_FreeEdict(self);
    return;
  }
}

/*QUAKED dm_dball_team2_start (1 .5 .5) (-16 -16 -24) (16 16 32)
Deathball team 2 start point
*/
export function SP_dm_dball_team2_start(self: EdictT): void {
  if (gameCvars.deathmatch === null || !gameCvars.deathmatch.value) {
    G_FreeEdict(self);
    return;
  }
  if (gameCvars.gamerules !== null && gameCvars.gamerules.value !== RDM_DEATHBALL) {
    G_FreeEdict(self);
    return;
  }
}

/*QUAKED dm_dball_ball_start (1 .5 .5) (-48 -48 -48) (48 48 48)
Deathball ball start point
*/
export function SP_dm_dball_ball_start(self: EdictT): void {
  if (gameCvars.deathmatch === null || !gameCvars.deathmatch.value) {
    G_FreeEdict(self);
    return;
  }
  if (gameCvars.gamerules !== null && gameCvars.gamerules.value !== RDM_DEATHBALL) {
    G_FreeEdict(self);
    return;
  }
}

/*QUAKED dm_dball_speed_change (1 .5 .5) ? ONEWAY
Deathball ball speed changing field.

speed: multiplier for speed (.5 = half, 2 = double, etc) (default = double)
angle: used with ONEWAY so speed change is only one way.
delay: time between speed changes (default: 0.2 sec)
*/
export function SP_dm_dball_speed_change(self: EdictT): void {
  if (gameCvars.deathmatch === null || !gameCvars.deathmatch.value) {
    G_FreeEdict(self);
    return;
  }
  if (gameCvars.gamerules !== null && gameCvars.gamerules.value !== RDM_DEATHBALL) {
    G_FreeEdict(self);
    return;
  }

  if (!self.speed) self.speed = 2;

  if (!self.delay) self.delay = 0.2;

  self.touch = DBall_SpeedTouch;
  self.solid = SolidT.SOLID_TRIGGER;
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.svflags |= SVF_NOCLIENT;

  if (VectorCompare(self.s.angles, vec3_origin) === 0) G_SetMovedir(self.s.angles, self.movedir);
  else VectorSet(self.movedir, 1, 0, 0);

  gi.setmodel(self, self.model ?? "");
  gi.linkentity(self);
}

/*QUAKED dm_dball_goal (1 .5 .5) ? TEAM1 TEAM2
Deathball goal

Team1/Team2 - beneficiary of this goal. when the ball enters this goal, the beneficiary team will score.

"wait": score to be given for this goal (default 10) player gets score+5.
*/
export function SP_dm_dball_goal(self: EdictT): void {
  if (gameCvars.deathmatch === null || !gameCvars.deathmatch.value) {
    G_FreeEdict(self);
    return;
  }

  if (gameCvars.gamerules !== null && gameCvars.gamerules.value !== RDM_DEATHBALL) {
    G_FreeEdict(self);
    return;
  }

  if (!self.wait) self.wait = 10;

  self.touch = DBall_GoalTouch;
  self.solid = SolidT.SOLID_TRIGGER;
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.svflags |= SVF_NOCLIENT;

  if (VectorCompare(self.s.angles, vec3_origin) === 0) G_SetMovedir(self.s.angles, self.movedir);

  gi.setmodel(self, self.model ?? "");
  gi.linkentity(self);
}
