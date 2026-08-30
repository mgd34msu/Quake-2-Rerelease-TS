/*
Copyright (c) ZeniMax Media Inc.
Licensed under the GNU General Public License 2.0.
Ported from rogue/m_carrier.c (GNU GPL v2 or later).
*/
/*
==============================================================================

carrier

==============================================================================
*/

// self.timestamp used for frame calculations in grenade & spawn code
// self.wait used to prevent rapid refire of rocket launcher

import { AngleVectors, vec3, VectorCopy, VectorLength, VectorMA, VectorNormalize, VectorSet, VectorSubtract, anglemod, type Vec3 } from "../shared/math";
import {
  ATTN_NONE,
  ATTN_NORM,
  CHAN_BODY,
  CHAN_VOICE,
  CHAN_WEAPON,
  CONTENTS_LAVA,
  CONTENTS_MONSTER,
  CONTENTS_SLIME,
  CONTENTS_SOLID,
  type CvarT,
  MASK_SOLID,
  MZ2_CARRIER_GRENADE,
  MZ2_CARRIER_MACHINEGUN_L1,
  MZ2_CARRIER_MACHINEGUN_L2,
  MZ2_CARRIER_MACHINEGUN_R1,
  MZ2_CARRIER_MACHINEGUN_R2,
  MZ2_CARRIER_RAILGUN,
  MZ2_CARRIER_ROCKET_1,
  MZ2_CARRIER_ROCKET_2,
  MZ2_CARRIER_ROCKET_3,
  MZ2_CARRIER_ROCKET_4,
  MZ2_GUNNER_GRENADE_1,
  YAW,
} from "../shared/q_shared";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk, FoundTarget, infront, range } from "./g_ai";
import { below, inback, PredictAim } from "./g_newai";
import {
  AI_CHARGING,
  AI_DO_NOT_COUNT,
  AI_HOLD_FRAME,
  AI_IGNORE_SHOTS,
  AI_MANUAL_STEERING,
  AI_SPAWNED_CARRIER,
  AI_STAND_GROUND,
  AS_BLIND,
  AS_MISSILE,
  AS_SLIDING,
  AS_STRAIGHT,
  DamageT,
  DEAD_DEAD,
  type EdictT,
  FL_FLY,
  FL_IMMUNE_LASER,
  FRAMETIME,
  g_edicts,
  game,
  gameCvars,
  gi,
  level,
  MframeT,
  MmoveT,
  MovetypeT,
  RANGE_FAR,
  RANGE_MELEE,
  RANGE_MID,
  RANGE_NEAR,
} from "./g_local";
import { type Edict, SolidT, SVF_DEADMONSTER } from "./game";
import { G_FreeEdict, G_ProjectSource, vectoyaw2 } from "./g_utils";
import { CreateMonster, FindSpawnPoint, SpawnGrow_Spawn } from "./g_spawn";
import { flyer_move_attack3, flyer_move_kamikaze } from "./m_flyer";
import { monster_fire_bullet, monster_fire_grenade, monster_fire_railgun, monster_fire_rocket, flymonster_start } from "./g_monster";
import { monsterFlashOffset } from "./m_flash";
import { BossExplode } from "./m_supertank";
import * as F from "./m_carrier_frames";

// mirrors g_monster.ts's own `cvarNum` (module-local there too, so not
// reusable) rather than inventing a shared helper outside this file's SCOPE.
function cvarNum(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}

function mf(
  aifunc: ((self: EdictT, dist: number) => void) | null,
  dist: number,
  thinkfunc: ((self: EdictT) => void) | null = null,
): MframeT {
  const f = new MframeT();
  f.aifunc = aifunc;
  f.dist = dist;
  f.thinkfunc = thinkfunc;
  return f;
}

function mkmove(
  firstframe: number,
  lastframe: number,
  frame: MframeT[],
  endfunc: ((self: EdictT) => void) | null = null,
): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.frame = frame;
  m.endfunc = endfunc;
  return m;
}

// trace_t.ent recovery idiom (see g_phys.ts's traceEdict): sv_world.c
// defaults an unset trace.ent to the world edict, never NULL, so a null
// GTraceT.ent here falls back to g_edicts[0] the same way.
function traceEdict(ent: Edict | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

const CARRIER_ROCKET_TIME = 2; // number of seconds between rocket shots
const CARRIER_ROCKET_SPEED = 750;
// unused in the original C too (m_carrier.c:19) -- dead define, kept for fidelity.
const NUM_FLYERS_SPAWNED = 6; // max # of flyers he can spawn

const RAIL_FIRE_TIME = 3;

// g_local.h's DEFAULT_BULLET_HSPREAD/VSPREAD (each monster file keeps its own
// copy per this codebase's established convention -- see m_gladiator.ts and
// siblings for the same duplication).
const DEFAULT_BULLET_HSPREAD = 300;
const DEFAULT_BULLET_VSPREAD = 500;

let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_pain3 = 0;
let sound_death = 0;
// static int	sound_search1; -- carrier_search is commented out in the
// original C (m_carrier.c:76-80) and never registers this sound; not ported.
let sound_sight = 0;
let sound_rail = 0;
let sound_spawn = 0;

// file-scope global, intentionally shared across every carrier instance --
// matches the C's `float orig_yaw_speed;` (m_carrier.c:43), a real quirk of
// the original (multiple simultaneous carriers would share this value).
let orig_yaw_speed = 0;

const flyer_mins: Vec3 = vec3(-16, -16, -24);
const flyer_maxs: Vec3 = vec3(16, 16, 16);

function carrier_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
}

// code starts here
// carrier_search is entirely commented out in the original (m_carrier.c:76-80,
// `//void carrier_search (edict_t *self) { if (random() < 0.5) ... }`) and
// self->monsterinfo.search is never assigned in SP_monster_carrier -- not
// ported, matches the C's own dead code.

//
// this is the smarts for the rocket launcher in coop
//
// if there is a player behind/below the carrier, and we can shoot, and we can trace a LOS to them ..
// pick one of the group, and let it rip
function CarrierCoopCheck(self: EdictT): void {
  // if we're not in coop, this is a noop
  if (cvarNum(gameCvars.coop) === 0) return;
  // if we are, and we have recently fired, bail
  if (self.wait > level.time) return;

  // no more than 4 players in coop, so..
  const targets: EdictT[] = [];

  // cycle through players
  for (let player = 1; player <= game.maxclients; player++) {
    const ent = g_edicts[player];
    if (!ent.inuse) continue;
    if (!ent.client) continue;
    if (inback(self, ent) || below(self, ent)) {
      const tr = gi.trace(self.s.origin, null, null, ent.s.origin, self, MASK_SOLID);
      if (tr.fraction === 1.0) {
        targets.push(ent);
      }
    }
  }

  if (targets.length === 0) return;

  // get a number from 0 to (num_targets-1)
  let target = (Math.random() * targets.length) | 0;

  // just in case we got a 1.0 from random
  if (target === targets.length) target--;

  // make sure to prevent rapid fire rockets
  self.wait = level.time + CARRIER_ROCKET_TIME;

  // save off the real enemy
  const savedEnemy = self.enemy;
  // set the new guy as temporary enemy
  self.enemy = targets[target];
  CarrierRocket(self);
  // put the real enemy back
  self.enemy = savedEnemy;

  // we're done
  return;
}

function CarrierGrenade(self: EdictT): void {
  CarrierCoopCheck(self);

  if (self.enemy === null) return;

  // from lower left to upper right, or lower right to upper left
  const direction = Math.random() < 0.5 ? -1.0 : 1.0;

  const mytime = ((level.time - self.timestamp) / 0.4) | 0;

  let spreadR: number;
  let spreadU: number;
  if (mytime === 0) {
    spreadR = 0.15 * direction;
    spreadU = 0.1 - 0.1 * direction;
  } else if (mytime === 1) {
    spreadR = 0;
    spreadU = 0.1;
  } else if (mytime === 2) {
    spreadR = -0.15 * direction;
    spreadU = 0.1 - -0.1 * direction;
  } else if (mytime === 3) {
    spreadR = 0;
    spreadU = 0.1;
  } else {
    // error, shoot straight
    spreadR = 0;
    spreadU = 0;
  }

  const forward = vec3();
  const right = vec3();
  const up = vec3();
  const start = vec3();
  const aim = vec3();

  AngleVectors(self.s.angles, forward, right, up);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_CARRIER_GRENADE], forward, right, start);

  VectorSubtract(self.enemy.s.origin, start, aim);
  VectorNormalize(aim);

  VectorMA(aim, spreadR, right, aim);
  VectorMA(aim, spreadU, up, aim);

  if (aim[2] > 0.15) aim[2] = 0.15;
  else if (aim[2] < -0.5) aim[2] = -0.5;

  monster_fire_grenade(self, start, aim, 50, 600, MZ2_GUNNER_GRENADE_1);
}

function CarrierPredictiveRocket(self: EdictT): void {
  const forward = vec3();
  const right = vec3();
  const start = vec3();
  const dir = vec3();

  AngleVectors(self.s.angles, forward, right, null);

  //1
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_CARRIER_ROCKET_1], forward, right, start);
  PredictAim(self.enemy, start, CARRIER_ROCKET_SPEED, false, -0.3, dir, null);
  monster_fire_rocket(self, start, dir, 50, CARRIER_ROCKET_SPEED, MZ2_CARRIER_ROCKET_1);

  //2
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_CARRIER_ROCKET_2], forward, right, start);
  PredictAim(self.enemy, start, CARRIER_ROCKET_SPEED, false, -0.15, dir, null);
  monster_fire_rocket(self, start, dir, 50, CARRIER_ROCKET_SPEED, MZ2_CARRIER_ROCKET_2);

  //3
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_CARRIER_ROCKET_3], forward, right, start);
  PredictAim(self.enemy, start, CARRIER_ROCKET_SPEED, false, 0, dir, null);
  monster_fire_rocket(self, start, dir, 50, CARRIER_ROCKET_SPEED, MZ2_CARRIER_ROCKET_3);

  //4
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_CARRIER_ROCKET_4], forward, right, start);
  PredictAim(self.enemy, start, CARRIER_ROCKET_SPEED, false, 0.15, dir, null);
  monster_fire_rocket(self, start, dir, 50, CARRIER_ROCKET_SPEED, MZ2_CARRIER_ROCKET_4);
}

function CarrierRocket(self: EdictT): void {
  // C: `if (self->enemy) { if (self->enemy->client && random() < 0.5) {
  // CarrierPredictiveRocket(self); return; } } else return;` -- restructured
  // as an equivalent early-return guard (m_carrier.c:261-270).
  if (self.enemy === null) return;

  if (self.enemy.client && Math.random() < 0.5) {
    CarrierPredictiveRocket(self);
    return;
  }

  const forward = vec3();
  const right = vec3();
  const start = vec3();
  const dir = vec3();
  const vec = vec3();

  AngleVectors(self.s.angles, forward, right, null);

  //1
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_CARRIER_ROCKET_1], forward, right, start);
  VectorCopy(self.enemy.s.origin, vec);
  vec[2] -= 15;
  VectorSubtract(vec, start, dir);
  VectorNormalize(dir);
  VectorMA(dir, 0.4, right, dir);
  VectorNormalize(dir);
  monster_fire_rocket(self, start, dir, 50, 500, MZ2_CARRIER_ROCKET_1);

  //2
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_CARRIER_ROCKET_2], forward, right, start);
  VectorCopy(self.enemy.s.origin, vec);
  VectorSubtract(vec, start, dir);
  VectorNormalize(dir);
  VectorMA(dir, 0.025, right, dir);
  VectorNormalize(dir);
  monster_fire_rocket(self, start, dir, 50, 500, MZ2_CARRIER_ROCKET_2);

  //3
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_CARRIER_ROCKET_3], forward, right, start);
  VectorCopy(self.enemy.s.origin, vec);
  VectorSubtract(vec, start, dir);
  VectorNormalize(dir);
  VectorMA(dir, -0.025, right, dir);
  VectorNormalize(dir);
  monster_fire_rocket(self, start, dir, 50, 500, MZ2_CARRIER_ROCKET_3);

  //4
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_CARRIER_ROCKET_4], forward, right, start);
  VectorCopy(self.enemy.s.origin, vec);
  vec[2] -= 15;
  VectorSubtract(vec, start, dir);
  VectorNormalize(dir);
  VectorMA(dir, -0.4, right, dir);
  VectorNormalize(dir);
  monster_fire_rocket(self, start, dir, 50, 500, MZ2_CARRIER_ROCKET_4);
}

function carrier_firebullet_right(self: EdictT): void {
  if (self.enemy === null) return; // C assumes self->enemy is set here

  // if we're in manual steering mode, it means we're leaning down .. use the lower shot
  const flashnum =
    self.monsterinfo.aiflags & AI_MANUAL_STEERING ? MZ2_CARRIER_MACHINEGUN_R2 : MZ2_CARRIER_MACHINEGUN_R1;

  const forward = vec3();
  const right = vec3();
  const target = vec3();
  const start = vec3();

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[flashnum], forward, right, start);

  VectorMA(self.enemy.s.origin, 0.2, self.enemy.velocity, target);
  target[2] += self.enemy.viewheight;

  VectorSubtract(target, start, forward);
  VectorNormalize(forward);

  monster_fire_bullet(self, start, forward, 6, 4, DEFAULT_BULLET_HSPREAD * 3, DEFAULT_BULLET_VSPREAD, flashnum);
}

function carrier_firebullet_left(self: EdictT): void {
  if (self.enemy === null) return; // C assumes self->enemy is set here

  // if we're in manual steering mode, it means we're leaning down .. use the lower shot
  const flashnum =
    self.monsterinfo.aiflags & AI_MANUAL_STEERING ? MZ2_CARRIER_MACHINEGUN_L2 : MZ2_CARRIER_MACHINEGUN_L1;

  const forward = vec3();
  const right = vec3();
  const target = vec3();
  const start = vec3();

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[flashnum], forward, right, start);

  VectorMA(self.enemy.s.origin, -0.2, self.enemy.velocity, target);

  target[2] += self.enemy.viewheight;
  VectorSubtract(target, start, forward);

  VectorNormalize(forward);

  monster_fire_bullet(self, start, forward, 6, 4, DEFAULT_BULLET_HSPREAD * 3, DEFAULT_BULLET_VSPREAD, flashnum);
}

function CarrierMachineGun(self: EdictT): void {
  CarrierCoopCheck(self);
  if (self.enemy !== null) carrier_firebullet_left(self);
  if (self.enemy !== null) carrier_firebullet_right(self);
}

function CarrierSpawn(self: EdictT): void {
  // real distance needed is (sqrt (56*56*2) + sqrt(16*16*2)) or 101.8
  const offset = vec3(105, 0, -58);
  const f = vec3();
  const r = vec3();
  const startpoint = vec3();
  const spawnpoint = vec3();

  AngleVectors(self.s.angles, f, r, null);

  G_ProjectSource(self.s.origin, offset, f, r, startpoint);

  // the +0.1 is because level.time is sometimes a little low
  const mytime = ((level.time + 0.1 - self.timestamp) / 0.5) | 0;

  if (FindSpawnPoint(startpoint, flyer_mins, flyer_maxs, spawnpoint, 32)) {
    // the second flier should be a kamikaze flyer
    //
    // C: `if (!ent) return;` (m_carrier.c:422-423) -- this port's
    // CreateMonster (g_spawn.ts) always returns a real EdictT (it never
    // returned NULL in the C body either: `newEnt = G_Spawn(); ...; return
    // newEnt;`), so the defensive null check is unreachable and dropped.
    const ent =
      mytime !== 2
        ? CreateMonster(spawnpoint, self.s.angles, "monster_flyer")
        : CreateMonster(spawnpoint, self.s.angles, "monster_kamikaze");

    gi.sound(self, CHAN_BODY, sound_spawn, 1, ATTN_NONE, 0);

    self.monsterinfo.monster_slots--;

    if (ent.think !== null) {
      ent.nextthink = level.time;
      ent.think(ent);
    }

    ent.monsterinfo.aiflags |= AI_SPAWNED_CARRIER | AI_DO_NOT_COUNT | AI_IGNORE_SHOTS;
    ent.monsterinfo.commander = self;

    if (self.enemy !== null && self.enemy.inuse && self.enemy.health > 0) {
      ent.enemy = self.enemy;
      FoundTarget(ent);
      if (mytime === 1) {
        ent.monsterinfo.lefty = 0;
        ent.monsterinfo.attack_state = AS_SLIDING;
        ent.monsterinfo.currentmove = flyer_move_attack3;
      } else if (mytime === 2) {
        ent.monsterinfo.lefty = 0;
        ent.monsterinfo.attack_state = AS_STRAIGHT;
        ent.monsterinfo.currentmove = flyer_move_kamikaze;
        ent.mass = 100;
        ent.monsterinfo.aiflags |= AI_CHARGING;
      } else if (mytime === 3) {
        ent.monsterinfo.lefty = 1;
        ent.monsterinfo.attack_state = AS_SLIDING;
        ent.monsterinfo.currentmove = flyer_move_attack3;
      }
    }
  }
}

function carrier_prep_spawn(self: EdictT): void {
  CarrierCoopCheck(self);
  self.monsterinfo.aiflags |= AI_MANUAL_STEERING;
  self.timestamp = level.time;
  self.yaw_speed = 10;
  CarrierMachineGun(self);
}

function carrier_spawn_check(self: EdictT): void {
  CarrierCoopCheck(self);
  CarrierMachineGun(self);
  CarrierSpawn(self);

  if (level.time > self.timestamp + 1.1) {
    // 0.5 seconds per flyer.  this gets three
    self.monsterinfo.aiflags &= ~AI_MANUAL_STEERING;
    self.yaw_speed = orig_yaw_speed;
    return;
  } else self.monsterinfo.nextframe = F.FRAME_spawn08;
}

function carrier_ready_spawn(self: EdictT): void {
  CarrierCoopCheck(self);
  CarrierMachineGun(self);

  const current_yaw = anglemod(self.s.angles[YAW]);

  if (Math.abs(current_yaw - self.ideal_yaw) > 0.1) {
    self.monsterinfo.aiflags |= AI_HOLD_FRAME;
    self.timestamp += FRAMETIME;
    return;
  }

  self.monsterinfo.aiflags &= ~AI_HOLD_FRAME;

  const offset = vec3(105, 0, -58);
  const f = vec3();
  const r = vec3();
  const startpoint = vec3();
  const spawnpoint = vec3();
  AngleVectors(self.s.angles, f, r, null);
  G_ProjectSource(self.s.origin, offset, f, r, startpoint);
  if (FindSpawnPoint(startpoint, flyer_mins, flyer_maxs, spawnpoint, 32)) {
    SpawnGrow_Spawn(spawnpoint, 0);
  }
}

function carrier_start_spawn(self: EdictT): void {
  CarrierCoopCheck(self);
  if (!orig_yaw_speed) orig_yaw_speed = self.yaw_speed;

  if (self.enemy === null) return;

  const mytime = ((level.time - self.timestamp) / 0.5) | 0;

  const temp = vec3();
  VectorSubtract(self.enemy.s.origin, self.s.origin, temp);
  const enemy_yaw = vectoyaw2(temp);

  // note that the offsets are based on a forward of 105 from the end angle
  if (mytime === 0) {
    self.ideal_yaw = anglemod(enemy_yaw - 30);
  } else if (mytime === 1) {
    self.ideal_yaw = anglemod(enemy_yaw);
  } else if (mytime === 2) {
    self.ideal_yaw = anglemod(enemy_yaw + 30);
  }

  CarrierMachineGun(self);
}

// carrier_frames_stand originally had a commented-out first row using
// drawbbox as a debug hook (m_carrier.c:566, `//	ai_stand, 0, drawbbox,`);
// disabled in the shipped C, not ported.
const carrier_frames_stand: MframeT[] = Array.from({ length: 13 }, () => mf(ai_stand, 0, null));
const carrier_move_stand = mkmove(F.FRAME_search01, F.FRAME_search13, carrier_frames_stand, null);

const carrier_frames_walk: MframeT[] = Array.from({ length: 13 }, () => mf(ai_walk, 4, null));
const carrier_move_walk = mkmove(F.FRAME_search01, F.FRAME_search13, carrier_frames_walk, null);

const carrier_frames_run: MframeT[] = Array.from({ length: 13 }, () => mf(ai_run, 6, CarrierCoopCheck));
const carrier_move_run = mkmove(F.FRAME_search01, F.FRAME_search13, carrier_frames_run, null);

const carrier_frames_attack_pre_mg: MframeT[] = [
  mf(ai_charge, 4, CarrierCoopCheck),
  mf(ai_charge, 4, CarrierCoopCheck),
  mf(ai_charge, 4, CarrierCoopCheck),
  mf(ai_charge, 4, CarrierCoopCheck),
  mf(ai_charge, 4, CarrierCoopCheck),
  mf(ai_charge, 4, CarrierCoopCheck),
  mf(ai_charge, 4, CarrierCoopCheck),
  mf(ai_charge, 4, carrier_attack_mg),
];
const carrier_move_attack_pre_mg = mkmove(F.FRAME_firea01, F.FRAME_firea08, carrier_frames_attack_pre_mg, null);

// Loop this
const carrier_frames_attack_mg: MframeT[] = [
  mf(ai_charge, -2, CarrierMachineGun),
  mf(ai_charge, -2, CarrierMachineGun),
  mf(ai_charge, -2, carrier_reattack_mg),
];
const carrier_move_attack_mg = mkmove(F.FRAME_firea09, F.FRAME_firea11, carrier_frames_attack_mg, null);

const carrier_frames_attack_post_mg: MframeT[] = [
  mf(ai_charge, 4, CarrierCoopCheck),
  mf(ai_charge, 4, CarrierCoopCheck),
  mf(ai_charge, 4, CarrierCoopCheck),
  mf(ai_charge, 4, CarrierCoopCheck),
];
const carrier_move_attack_post_mg = mkmove(F.FRAME_firea12, F.FRAME_firea15, carrier_frames_attack_post_mg, carrier_run);

const carrier_frames_attack_pre_gren: MframeT[] = [
  mf(ai_charge, 4, CarrierCoopCheck),
  mf(ai_charge, 4, CarrierCoopCheck),
  mf(ai_charge, 4, CarrierCoopCheck),
  mf(ai_charge, 4, CarrierCoopCheck),
  mf(ai_charge, 4, CarrierCoopCheck),
  mf(ai_charge, 4, carrier_attack_gren),
];
const carrier_move_attack_pre_gren = mkmove(F.FRAME_fireb01, F.FRAME_fireb06, carrier_frames_attack_pre_gren, null);

const carrier_frames_attack_gren: MframeT[] = [
  mf(ai_charge, -15, CarrierGrenade),
  mf(ai_charge, 4, CarrierCoopCheck),
  mf(ai_charge, 4, CarrierCoopCheck),
  mf(ai_charge, 4, carrier_reattack_gren),
];
const carrier_move_attack_gren = mkmove(F.FRAME_fireb07, F.FRAME_fireb10, carrier_frames_attack_gren, null);

const carrier_frames_attack_post_gren: MframeT[] = [
  mf(ai_charge, 4, CarrierCoopCheck),
  mf(ai_charge, 4, CarrierCoopCheck),
  mf(ai_charge, 4, CarrierCoopCheck),
  mf(ai_charge, 4, CarrierCoopCheck),
  mf(ai_charge, 4, CarrierCoopCheck),
  mf(ai_charge, 4, CarrierCoopCheck),
];
const carrier_move_attack_post_gren = mkmove(F.FRAME_fireb11, F.FRAME_fireb16, carrier_frames_attack_post_gren, carrier_run);

const carrier_frames_attack_rocket: MframeT[] = [mf(ai_charge, 15, CarrierRocket)];
const carrier_move_attack_rocket = mkmove(F.FRAME_fireb01, F.FRAME_fireb01, carrier_frames_attack_rocket, carrier_run);

function CarrierRail(self: EdictT): void {
  CarrierCoopCheck(self);

  const forward = vec3();
  const right = vec3();
  const start = vec3();
  const dir = vec3();

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_CARRIER_RAILGUN], forward, right, start);

  // calc direction to where we targeted
  VectorSubtract(self.pos1, start, dir);
  VectorNormalize(dir);

  monster_fire_railgun(self, start, dir, 50, 100, MZ2_CARRIER_RAILGUN);
  self.monsterinfo.attack_finished = level.time + RAIL_FIRE_TIME;
}

function CarrierSaveLoc(self: EdictT): void {
  CarrierCoopCheck(self);
  if (self.enemy === null) return; // C assumes self->enemy is set here
  VectorCopy(self.enemy.s.origin, self.pos1); // save for aiming the shot
  self.pos1[2] += self.enemy.viewheight;
}

const carrier_frames_attack_rail: MframeT[] = [
  mf(ai_charge, 2, CarrierCoopCheck),
  mf(ai_charge, 2, CarrierSaveLoc),
  mf(ai_charge, 2, CarrierCoopCheck),
  mf(ai_charge, -20, CarrierRail),
  mf(ai_charge, 2, CarrierCoopCheck),
  mf(ai_charge, 2, CarrierCoopCheck),
  mf(ai_charge, 2, CarrierCoopCheck),
  mf(ai_charge, 2, CarrierCoopCheck),
  mf(ai_charge, 2, CarrierCoopCheck),
];
const carrier_move_attack_rail = mkmove(F.FRAME_search01, F.FRAME_search09, carrier_frames_attack_rail, carrier_run);

const carrier_frames_spawn: MframeT[] = [
  mf(ai_charge, -2, CarrierMachineGun),
  mf(ai_charge, -2, CarrierMachineGun),
  mf(ai_charge, -2, CarrierMachineGun),
  mf(ai_charge, -2, CarrierMachineGun),
  mf(ai_charge, -2, CarrierMachineGun),
  mf(ai_charge, -2, CarrierMachineGun),
  mf(ai_charge, -2, carrier_prep_spawn), // 7 - end of wind down
  mf(ai_charge, -2, carrier_start_spawn), // 8 - start of spawn
  mf(ai_charge, -2, carrier_ready_spawn),
  mf(ai_charge, -2, CarrierMachineGun),
  mf(ai_charge, -2, CarrierMachineGun),
  mf(ai_charge, -10, carrier_spawn_check), //12 - actual spawn
  mf(ai_charge, -2, CarrierMachineGun), //13 - begin of wind down
  mf(ai_charge, -2, CarrierMachineGun),
  mf(ai_charge, -2, CarrierMachineGun),
  mf(ai_charge, -2, CarrierMachineGun),
  mf(ai_charge, -2, CarrierMachineGun),
  mf(ai_charge, -2, carrier_reattack_mg), //18 - end of wind down
];
const carrier_move_spawn = mkmove(F.FRAME_spawn01, F.FRAME_spawn18, carrier_frames_spawn, null);

const carrier_frames_pain_heavy: MframeT[] = Array.from({ length: 10 }, () => mf(ai_move, 0, null));
const carrier_move_pain_heavy = mkmove(F.FRAME_death01, F.FRAME_death10, carrier_frames_pain_heavy, carrier_run);

const carrier_frames_pain_light: MframeT[] = Array.from({ length: 4 }, () => mf(ai_move, 0, null));
const carrier_move_pain_light = mkmove(F.FRAME_spawn01, F.FRAME_spawn04, carrier_frames_pain_light, carrier_run);

const carrier_frames_death: MframeT[] = [
  ...Array.from({ length: 15 }, () => mf(ai_move, 0, null)),
  mf(ai_move, 0, BossExplode),
];
const carrier_move_death = mkmove(F.FRAME_death01, F.FRAME_death16, carrier_frames_death, carrier_dead);

function carrier_stand(self: EdictT): void {
  self.monsterinfo.currentmove = carrier_move_stand;
}

function carrier_run(self: EdictT): void {
  self.monsterinfo.aiflags &= ~AI_HOLD_FRAME;

  if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = carrier_move_stand;
  else self.monsterinfo.currentmove = carrier_move_run;
}

function carrier_walk(self: EdictT): void {
  self.monsterinfo.currentmove = carrier_move_walk;
}

// CarrierMachineGunHold's body in the shipped C is entirely commented out
// except for the plain CarrierMachineGun() call (m_carrier.c:827-833); the
// AI_HOLD_FRAME/yaw_speed/currentmove lines are dead code, not ported.
function CarrierMachineGunHold(self: EdictT): void {
  CarrierMachineGun(self);
}

function carrier_attack(self: EdictT): void {
  self.monsterinfo.aiflags &= ~AI_HOLD_FRAME;

  if (self.enemy === null || !self.enemy.inuse) return;

  const enemy_inback = inback(self, self.enemy);
  const enemy_infront = infront(self, self.enemy);
  const enemy_below = below(self, self.enemy);

  if (self.bad_area) {
    if (enemy_inback || enemy_below) self.monsterinfo.currentmove = carrier_move_attack_rocket;
    else if (Math.random() < 0.1 || level.time < self.monsterinfo.attack_finished)
      self.monsterinfo.currentmove = carrier_move_attack_pre_mg;
    else {
      gi.sound(self, CHAN_WEAPON, sound_rail, 1, ATTN_NORM, 0);
      self.monsterinfo.currentmove = carrier_move_attack_rail;
    }
    return;
  }

  if (self.monsterinfo.attack_state === AS_BLIND) {
    self.monsterinfo.currentmove = carrier_move_spawn;
    return;
  }

  if (!enemy_inback && !enemy_infront && !enemy_below) {
    // to side and not under
    if (Math.random() < 0.1 || level.time < self.monsterinfo.attack_finished)
      self.monsterinfo.currentmove = carrier_move_attack_pre_mg;
    else {
      gi.sound(self, CHAN_WEAPON, sound_rail, 1, ATTN_NORM, 0);
      self.monsterinfo.currentmove = carrier_move_attack_rail;
    }
    return;
  }

  if (enemy_infront) {
    const vec = vec3();
    VectorSubtract(self.enemy.s.origin, self.s.origin, vec);
    const dist = VectorLength(vec);
    if (dist <= 125) {
      if (Math.random() < 0.8 || level.time < self.monsterinfo.attack_finished)
        self.monsterinfo.currentmove = carrier_move_attack_pre_mg;
      else {
        gi.sound(self, CHAN_WEAPON, sound_rail, 1, ATTN_NORM, 0);
        self.monsterinfo.currentmove = carrier_move_attack_rail;
      }
    } else if (dist < 600) {
      const luck = Math.random();
      if (self.monsterinfo.monster_slots > 2) {
        if (luck <= 0.2) self.monsterinfo.currentmove = carrier_move_attack_pre_mg;
        else if (luck <= 0.4) self.monsterinfo.currentmove = carrier_move_attack_pre_gren;
        else if (luck <= 0.7 && !(level.time < self.monsterinfo.attack_finished)) {
          gi.sound(self, CHAN_WEAPON, sound_rail, 1, ATTN_NORM, 0);
          self.monsterinfo.currentmove = carrier_move_attack_rail;
        } else self.monsterinfo.currentmove = carrier_move_spawn;
      } else {
        if (luck <= 0.3) self.monsterinfo.currentmove = carrier_move_attack_pre_mg;
        else if (luck <= 0.65) self.monsterinfo.currentmove = carrier_move_attack_pre_gren;
        else if (level.time >= self.monsterinfo.attack_finished) {
          gi.sound(self, CHAN_WEAPON, sound_rail, 1, ATTN_NORM, 0);
          self.monsterinfo.currentmove = carrier_move_attack_rail;
        } else self.monsterinfo.currentmove = carrier_move_attack_pre_mg;
      }
    } else {
      // won't use grenades at this range
      const luck = Math.random();
      if (self.monsterinfo.monster_slots > 2) {
        if (luck < 0.3) self.monsterinfo.currentmove = carrier_move_attack_pre_mg;
        else if (luck < 0.65 && !(level.time < self.monsterinfo.attack_finished)) {
          gi.sound(self, CHAN_WEAPON, sound_rail, 1, ATTN_NORM, 0);
          VectorCopy(self.enemy.s.origin, self.pos1); // save for aiming the shot
          self.pos1[2] += self.enemy.viewheight;
          self.monsterinfo.currentmove = carrier_move_attack_rail;
        } else self.monsterinfo.currentmove = carrier_move_spawn;
      } else {
        if (luck < 0.45 || level.time < self.monsterinfo.attack_finished)
          self.monsterinfo.currentmove = carrier_move_attack_pre_mg;
        else {
          gi.sound(self, CHAN_WEAPON, sound_rail, 1, ATTN_NORM, 0);
          self.monsterinfo.currentmove = carrier_move_attack_rail;
        }
      }
    }
  } else if (enemy_below || enemy_inback) {
    self.monsterinfo.currentmove = carrier_move_attack_rocket;
  }
}

function carrier_attack_mg(self: EdictT): void {
  CarrierCoopCheck(self);
  self.monsterinfo.currentmove = carrier_move_attack_mg;
}

function carrier_reattack_mg(self: EdictT): void {
  CarrierCoopCheck(self);
  if (self.enemy === null) return; // C assumes self->enemy is set here
  if (infront(self, self.enemy)) {
    if (Math.random() <= 0.5) {
      if (Math.random() < 0.7 || self.monsterinfo.monster_slots <= 2)
        self.monsterinfo.currentmove = carrier_move_attack_mg;
      else self.monsterinfo.currentmove = carrier_move_spawn;
    } else self.monsterinfo.currentmove = carrier_move_attack_post_mg;
  } else self.monsterinfo.currentmove = carrier_move_attack_post_mg;
}

function carrier_attack_gren(self: EdictT): void {
  CarrierCoopCheck(self);
  self.timestamp = level.time;
  self.monsterinfo.currentmove = carrier_move_attack_gren;
}

function carrier_reattack_gren(self: EdictT): void {
  CarrierCoopCheck(self);
  if (self.enemy !== null && infront(self, self.enemy)) {
    if (self.timestamp + 1.3 > level.time) {
      // four grenades
      self.monsterinfo.currentmove = carrier_move_attack_gren;
      return;
    }
  }
  self.monsterinfo.currentmove = carrier_move_attack_post_gren;
}

function carrier_pain(self: EdictT, _other: EdictT, _kick: number, damage: number): void {
  let changed = false;

  if (self.health < self.max_health / 2) self.s.skinnum = 1;

  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 5;

  if (damage < 10) {
    gi.sound(self, CHAN_VOICE, sound_pain3, 1, ATTN_NONE, 0);
  } else if (damage < 30) {
    gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NONE, 0);
    if (Math.random() < 0.5) {
      changed = true;
      self.monsterinfo.currentmove = carrier_move_pain_light;
    }
  } else {
    gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NONE, 0);
    self.monsterinfo.currentmove = carrier_move_pain_heavy;
    changed = true;
  }

  // if we changed frames, clean up our little messes
  if (changed) {
    self.monsterinfo.aiflags &= ~AI_HOLD_FRAME;
    self.monsterinfo.aiflags &= ~AI_MANUAL_STEERING;
    self.yaw_speed = orig_yaw_speed;
  }
}

function carrier_dead(self: EdictT): void {
  VectorSet(self.mins, -56, -56, 0);
  VectorSet(self.maxs, 56, 56, 80);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

function carrier_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3): void {
  gi.sound(self, CHAN_VOICE, sound_death, 1, ATTN_NONE, 0);
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_NO;
  self.count = 0;
  self.monsterinfo.currentmove = carrier_move_death;
}

function Carrier_CheckAttack(self: EdictT): boolean {
  if (self.enemy === null) return false; // C assumes self->enemy is set here

  if (self.enemy.health > 0) {
    // see if any entities are in the way of the shot
    const spot1 = vec3();
    const spot2 = vec3();
    VectorCopy(self.s.origin, spot1);
    spot1[2] += self.viewheight;
    VectorCopy(self.enemy.s.origin, spot2);
    spot2[2] += self.enemy.viewheight;

    const tr = gi.trace(spot1, null, null, spot2, self, CONTENTS_SOLID | CONTENTS_MONSTER | CONTENTS_SLIME | CONTENTS_LAVA);

    // do we have a clear shot?
    if (traceEdict(tr.ent) !== self.enemy) {
      // go ahead and spawn stuff if we're mad a a client
      if (self.enemy.client && self.monsterinfo.monster_slots > 2) {
        self.monsterinfo.attack_state = AS_BLIND;
        return true;
      }

      // PGM - we want them to go ahead and shoot at info_notnulls if they can.
      if (self.enemy.solid !== SolidT.SOLID_NOT || tr.fraction < 1.0) return false;
    }
  }

  const enemy_infront = infront(self, self.enemy);
  const enemy_inback = inback(self, self.enemy);
  const enemy_below = below(self, self.enemy);

  const enemy_range = range(self, self.enemy);
  const temp = vec3();
  VectorSubtract(self.enemy.s.origin, self.s.origin, temp);
  const enemy_yaw = vectoyaw2(temp);

  self.ideal_yaw = enemy_yaw;

  // PMM - shoot out the back if appropriate
  if (enemy_inback || (!enemy_infront && enemy_below)) {
    // this is using wait because the attack is supposed to be independent
    if (level.time >= self.wait) {
      self.wait = level.time + CARRIER_ROCKET_TIME;
      if (self.monsterinfo.attack !== null) self.monsterinfo.attack(self);
      if (Math.random() < 0.6) self.monsterinfo.attack_state = AS_SLIDING;
      else self.monsterinfo.attack_state = AS_STRAIGHT;
      return true;
    }
  }

  // melee attack
  if (enemy_range === RANGE_MELEE) {
    self.monsterinfo.attack_state = AS_MISSILE;
    return true;
  }

  // C leaves `chance` uninitialized here since the range() return values it
  // switches on (RANGE_MELEE/NEAR/MID/FAR) are exhaustively covered by the
  // branches below; `= 0` only satisfies TS definite-assignment analysis
  // (plain `number` consts aren't a closed union TS can prove exhaustive
  // over) and is never actually read. Note the `enemy_range === RANGE_MELEE`
  // branch below is dead code in the original too -- the melee-range check
  // above (m_carrier.c:1149-1153) already returns before this chain runs.
  let chance = 0;
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) {
    chance = 0.4;
  } else if (enemy_range === RANGE_MELEE) {
    chance = 0.8;
  } else if (enemy_range === RANGE_NEAR) {
    chance = 0.8;
  } else if (enemy_range === RANGE_MID) {
    chance = 0.8;
  } else if (enemy_range === RANGE_FAR) {
    chance = 0.5;
  }

  // PGM - go ahead and shoot every time if it's a info_notnull
  if (Math.random() < chance || self.enemy.solid === SolidT.SOLID_NOT) {
    self.monsterinfo.attack_state = AS_MISSILE;
    return true;
  }

  if (self.flags & FL_FLY) {
    if (Math.random() < 0.6) self.monsterinfo.attack_state = AS_SLIDING;
    else self.monsterinfo.attack_state = AS_STRAIGHT;
  }

  return false;
}

function CarrierPrecache(): void {
  gi.soundindex("flyer/flysght1.wav");
  gi.soundindex("flyer/flysrch1.wav");
  gi.soundindex("flyer/flypain1.wav");
  gi.soundindex("flyer/flypain2.wav");
  gi.soundindex("flyer/flyatck2.wav");
  gi.soundindex("flyer/flyatck1.wav");
  gi.soundindex("flyer/flydeth1.wav");
  gi.soundindex("flyer/flyatck3.wav");
  gi.soundindex("flyer/flyidle1.wav");
  gi.soundindex("weapons/rockfly.wav");
  gi.soundindex("infantry/infatck1.wav");
  gi.soundindex("gunner/gunatck3.wav");
  gi.soundindex("weapons/grenlb1b.wav");
  gi.soundindex("tank/rocket.wav");

  gi.modelindex("models/monsters/flyer/tris.md2");
  gi.modelindex("models/objects/rocket/tris.md2");
  gi.modelindex("models/objects/debris2/tris.md2");
  gi.modelindex("models/objects/grenade/tris.md2");
  gi.modelindex("models/items/spawngro/tris.md2");
  gi.modelindex("models/items/spawngro2/tris.md2");
  gi.modelindex("models/objects/gibs/sm_metal/tris.md2");
  gi.modelindex("models/objects/gibs/gear/tris.md2");
}

/*QUAKED monster_carrier (1 .5 0) (-56 -56 -44) (56 56 44) Ambush Trigger_Spawn Sight
 */
export function SP_monster_carrier(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  sound_pain1 = gi.soundindex("carrier/pain_md.wav");
  sound_pain2 = gi.soundindex("carrier/pain_lg.wav");
  sound_pain3 = gi.soundindex("carrier/pain_sm.wav");
  sound_death = gi.soundindex("carrier/death.wav");
  sound_rail = gi.soundindex("gladiator/railgun.wav");
  sound_sight = gi.soundindex("carrier/sight.wav");
  sound_spawn = gi.soundindex("medic_commander/monsterspawn1.wav");

  self.s.sound = gi.soundindex("bosshovr/bhvengn1.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/carrier/tris.md2");
  VectorSet(self.mins, -56, -56, -44);
  VectorSet(self.maxs, 56, 56, 44);

  // 2000 - 4000 health
  self.health = Math.max(2000, 2000 + 1000 * (cvarNum(gameCvars.skill) - 1));
  // add health in coop (500 * skill)
  if (cvarNum(gameCvars.coop) !== 0) self.health += 500 * cvarNum(gameCvars.skill);

  self.gib_health = -200;
  self.mass = 1000;

  self.yaw_speed = 15;
  orig_yaw_speed = self.yaw_speed;

  self.flags |= FL_IMMUNE_LASER;
  self.monsterinfo.aiflags |= AI_IGNORE_SHOTS;

  self.pain = carrier_pain;
  self.die = carrier_die;

  self.monsterinfo.melee = null;
  self.monsterinfo.stand = carrier_stand;
  self.monsterinfo.walk = carrier_walk;
  self.monsterinfo.run = carrier_run;
  self.monsterinfo.attack = carrier_attack;
  self.monsterinfo.sight = carrier_sight;
  self.monsterinfo.checkattack = Carrier_CheckAttack;
  gi.linkentity(self);

  self.monsterinfo.currentmove = carrier_move_stand;
  self.monsterinfo.scale = F.MODEL_SCALE;

  CarrierPrecache();

  flymonster_start(self);

  self.monsterinfo.attack_finished = 0;
  switch (cvarNum(gameCvars.skill) | 0) {
    case 0:
      self.monsterinfo.monster_slots = 3;
      break;
    case 1:
    case 2:
      self.monsterinfo.monster_slots = 6;
      break;
    case 3:
      self.monsterinfo.monster_slots = 9;
      break;
    default:
      self.monsterinfo.monster_slots = 6;
      break;
  }
}

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- so a save containing an entity that
// references one of these callbacks or move tables restores a real
// think/touch/use/pain/die/blocked function or monsterinfo.currentmove
// object instead of null (see g_save.ts's registerSaveFunction/
// registerSaveMmove name registry).
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("m_carrier:carrier_sight", carrier_sight);
registerSaveFunction("m_carrier:CarrierCoopCheck", CarrierCoopCheck);
registerSaveFunction("m_carrier:CarrierGrenade", CarrierGrenade);
registerSaveFunction("m_carrier:CarrierPredictiveRocket", CarrierPredictiveRocket);
registerSaveFunction("m_carrier:CarrierRocket", CarrierRocket);
registerSaveFunction("m_carrier:carrier_firebullet_right", carrier_firebullet_right);
registerSaveFunction("m_carrier:carrier_firebullet_left", carrier_firebullet_left);
registerSaveFunction("m_carrier:CarrierMachineGun", CarrierMachineGun);
registerSaveFunction("m_carrier:CarrierSpawn", CarrierSpawn);
registerSaveFunction("m_carrier:carrier_prep_spawn", carrier_prep_spawn);
registerSaveFunction("m_carrier:carrier_spawn_check", carrier_spawn_check);
registerSaveFunction("m_carrier:carrier_ready_spawn", carrier_ready_spawn);
registerSaveFunction("m_carrier:carrier_start_spawn", carrier_start_spawn);
registerSaveFunction("m_carrier:CarrierRail", CarrierRail);
registerSaveFunction("m_carrier:CarrierSaveLoc", CarrierSaveLoc);
registerSaveFunction("m_carrier:carrier_stand", carrier_stand);
registerSaveFunction("m_carrier:carrier_run", carrier_run);
registerSaveFunction("m_carrier:carrier_walk", carrier_walk);
registerSaveFunction("m_carrier:CarrierMachineGunHold", CarrierMachineGunHold);
registerSaveFunction("m_carrier:carrier_attack", carrier_attack);
registerSaveFunction("m_carrier:carrier_attack_mg", carrier_attack_mg);
registerSaveFunction("m_carrier:carrier_reattack_mg", carrier_reattack_mg);
registerSaveFunction("m_carrier:carrier_attack_gren", carrier_attack_gren);
registerSaveFunction("m_carrier:carrier_reattack_gren", carrier_reattack_gren);
registerSaveFunction("m_carrier:carrier_pain", carrier_pain);
registerSaveFunction("m_carrier:carrier_dead", carrier_dead);
registerSaveFunction("m_carrier:carrier_die", carrier_die);
registerSaveFunction("m_carrier:Carrier_CheckAttack", Carrier_CheckAttack);

registerSaveMmove("m_carrier:carrier_move_stand", carrier_move_stand);
registerSaveMmove("m_carrier:carrier_move_walk", carrier_move_walk);
registerSaveMmove("m_carrier:carrier_move_run", carrier_move_run);
registerSaveMmove("m_carrier:carrier_move_attack_pre_mg", carrier_move_attack_pre_mg);
registerSaveMmove("m_carrier:carrier_move_attack_mg", carrier_move_attack_mg);
registerSaveMmove("m_carrier:carrier_move_attack_post_mg", carrier_move_attack_post_mg);
registerSaveMmove("m_carrier:carrier_move_attack_pre_gren", carrier_move_attack_pre_gren);
registerSaveMmove("m_carrier:carrier_move_attack_gren", carrier_move_attack_gren);
registerSaveMmove("m_carrier:carrier_move_attack_post_gren", carrier_move_attack_post_gren);
registerSaveMmove("m_carrier:carrier_move_attack_rocket", carrier_move_attack_rocket);
registerSaveMmove("m_carrier:carrier_move_attack_rail", carrier_move_attack_rail);
registerSaveMmove("m_carrier:carrier_move_spawn", carrier_move_spawn);
registerSaveMmove("m_carrier:carrier_move_pain_heavy", carrier_move_pain_heavy);
registerSaveMmove("m_carrier:carrier_move_pain_light", carrier_move_pain_light);
registerSaveMmove("m_carrier:carrier_move_death", carrier_move_death);
