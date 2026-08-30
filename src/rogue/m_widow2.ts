/*
Copyright (c) ZeniMax Media Inc.
Licensed under the GNU General Public License 2.0.
Ported from rogue/m_widow2.c (GNU GPL v2 or later).
*/
/*
==============================================================================

black widow, part 2

==============================================================================
*/
// timestamp used to prevent rapid fire of melee attack

// Deviations from the C source (all confirmed by re-reading m_widow2.c):
// - `showme` (m_widow2.c:89) is forward-declared but never implemented or
//   called anywhere in the file -- nothing to port.
// - `widow_done_spawn`/`widow2_prep_spawn` (m_widow2.c:52,54) are
//   forward-declared but never called in this file (`widow_done_spawn` is
//   implemented in the sibling m_widow.c but m_widow2.c never references
//   it) -- not imported here.
// - `sound_disrupt` (m_widow2.c:25) is declared but only ever assigned by a
//   commented-out line (m_widow2.c:1166) and never read anywhere -- dropped.
// - `pauseme`, `widow2_dead`, `Widow2BeamTargetRemove`, `Widow2StartSweep`
//   are defined in the C but never assigned to any monster callback slot or
//   mmove frame -- ported verbatim below for fidelity, just unreferenced,
//   exactly as in the original.
// - `BloodFountain` (m_widow2.c:1383) has no call sites and its body
//   `return`s unconditionally before its own loop runs (its temp-entity
//   writes are themselves commented out in the C) -- ported verbatim as
//   dead code, matching the original.
// - Widow2Beam's FRAME_spawn04 debug block (m_widow2.c:140-154, `gi.WriteByte
//   (TE_DEBUGTRAIL)`/`drawbbox`) is `/* ... */`-commented out in the source
//   -- dropped, matching dead code.
// - Widow2_CheckAttack's `chance` local (m_widow2.c:1092-1108) is only
//   assigned for AI_STAND_GROUND/RANGE_NEAR/RANGE_MID/RANGE_FAR; RANGE_MELEE
//   falls through with `chance` uninitialized in the original C (real UB in
//   the shipped code -- in practice unreachable here because the preceding
//   `self->timestamp` block already returns for close-range encounters).
//   TypeScript requires definite assignment, so RANGE_MELEE defaults to
//   `chance = 0` below (documented deviation, reported to the coordinator).

import {
  AngleVectors,
  crandom,
  vec3,
  vec3_origin,
  type Vec3,
  VectorAdd,
  VectorClear,
  VectorCopy,
  VectorLength,
  VectorMA,
  VectorNormalize,
  VectorScale,
  VectorSet,
  VectorSubtract,
} from "../shared/math";
import {
  ATTN_NONE,
  ATTN_NORM,
  CHAN_VOICE,
  CHAN_WEAPON,
  CONTENTS_LAVA,
  CONTENTS_MONSTER,
  CONTENTS_SLIME,
  CONTENTS_SOLID,
  type CplaneT,
  type CsurfaceT,
  type CvarT,
  EF_GIB,
  MASK_SHOT,
  MulticastT,
  MZ2_WIDOW2_BEAMER_1,
  MZ2_WIDOW2_BEAM_SWEEP_1,
  MZ2_WIDOW_DISRUPTOR,
  PITCH,
  RF_IR_VISIBLE,
  ROLL,
  TempEventT,
  YAW,
} from "../shared/q_shared";
import { fixedLength } from "../shared/fixed";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk, FoundTarget, infront, range } from "./g_ai";
import { T_Damage } from "./g_combat";
import {
  AI_BLOCKED,
  AI_DO_NOT_COUNT,
  AI_HOLD_FRAME,
  AI_IGNORE_SHOTS,
  AI_MANUAL_STEERING,
  AI_SPAWNED_WIDOW,
  AI_STAND_GROUND,
  AS_BLIND,
  AS_MELEE,
  AS_MISSILE,
  DamageT,
  DAMAGE_NO_KNOCKBACK,
  DEAD_DEAD,
  type EdictT,
  FL_IMMUNE_LASER,
  FL_NO_KNOCKBACK,
  g_edicts,
  gameCvars,
  GIB_METALLIC,
  GIB_ORGANIC,
  gi,
  level,
  MframeT,
  MmoveT,
  MOD_UNKNOWN,
  MovetypeT,
  POWER_ARMOR_SHIELD,
  RANGE_FAR,
  RANGE_MID,
  RANGE_NEAR,
  svc_temp_entity,
} from "./g_local";
import { type Edict, SolidT } from "./game";
import { PickCoopTarget, PredictAim, realrange } from "./g_newai";
import { ClipGibVelocity, gib_die, gib_touch, ThrowGib, ThrowHead } from "./g_misc";
import { M_ChangeYaw } from "./m_move2";
import { monster_fire_heat, monster_fire_tracker, monster_think, walkmonster_start } from "./g_monster";
import { CreateGroundMonster, FindSpawnPoint, SpawnGrow_Spawn } from "./g_spawn";
import { stalker_maxs, stalker_mins, WidowCalcSlots, widow_start_spawn, WidowPowerups } from "./m_widow";
import { monsterFlashOffset } from "./m_flash";
import { G_Find, G_FreeEdict, G_ProjectSource, G_ProjectSource2, G_Spawn, vectoangles, vectoangles2, vectoyaw2 } from "./g_utils";
import { fire_hit } from "./g_weapon";
import * as F from "./m_widow2_frames";

const NUM_STALKERS_SPAWNED = 6; // max # of stalkers she can spawn
const DISRUPT_TIME = 3;

let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_pain3 = 0;
let sound_death = 0;
let sound_search1 = 0;
let sound_tentacles_retract = 0;

// mirrors g_monster.ts's own `cvarNum` (module-local there too, so not
// reusable) rather than inventing a shared helper outside this file's SCOPE.
function cvarNum(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}

// trace_t.ent recovery idiom (see m_move2.ts's traceEdict/m_parasite.ts's
// traceEdict): sv_world.c defaults an unset trace.ent to the world edict,
// never NULL, so a null GTraceT.ent here falls back to g_edicts[0] the same
// way.
function traceEdict(ent: Edict | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
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
  allowFrameCountMismatch = false,
): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.allowFrameCountMismatch = allowFrameCountMismatch;
  m.frame = frame;
  m.endfunc = endfunc;
  return m;
}

// sqrt(64*64*2) + sqrt(28*28*2) => 130.1
const spawnpoints: Vec3[] = fixedLength("spawnpoints", 2, [vec3(30, 135, 0), vec3(30, -135, 0)]);

const sweep_angles: number[] = fixedLength("sweep_angles", 11, [
  -40.0, -32.0, -24.0, -16.0, -8.0, 0.0, 8.0, 16.0, 24.0, 32.0, 40.0,
]);

// these offsets used by the tongue
const offsets: Vec3[] = fixedLength("offsets", 8, [
  vec3(17.48, 0.1, 68.92),
  vec3(17.47, 0.29, 68.91),
  vec3(17.45, 0.53, 68.87),
  vec3(17.42, 0.78, 68.81),
  vec3(17.39, 1.02, 68.75),
  vec3(17.37, 1.2, 68.7),
  vec3(17.36, 1.24, 68.71),
  vec3(17.37, 1.21, 68.72),
]);

function pauseme(self: EdictT): void {
  self.monsterinfo.aiflags |= AI_HOLD_FRAME;
}

function widow2_search(self: EdictT): void {
  if (Math.random() < 0.5) gi.sound(self, CHAN_VOICE, sound_search1, 1, ATTN_NONE, 0);
}

function Widow2Beam(self: EdictT): void {
  if (self.enemy === null || !self.enemy.inuse) return;

  const forward = vec3();
  const right = vec3();
  const target = vec3();
  const start = vec3();
  let flashnum: number;

  AngleVectors(self.s.angles, forward, right, null);

  if (self.s.frame >= F.FRAME_fireb05 && self.s.frame <= F.FRAME_fireb09) {
    // regular beam attack
    Widow2SaveBeamTarget(self);
    flashnum = MZ2_WIDOW2_BEAMER_1 + self.s.frame - F.FRAME_fireb05;
    G_ProjectSource(self.s.origin, monsterFlashOffset()[flashnum], forward, right, start);
    VectorCopy(self.pos2, target);
    target[2] += self.enemy.viewheight - 10;
    VectorSubtract(target, start, forward);
    VectorNormalize(forward);
    monster_fire_heat(self, start, forward, vec3_origin, 10, 50, flashnum);
  } else if (self.s.frame >= F.FRAME_spawn04 && self.s.frame <= F.FRAME_spawn14) {
    // sweep
    flashnum = MZ2_WIDOW2_BEAM_SWEEP_1 + self.s.frame - F.FRAME_spawn04;
    G_ProjectSource(self.s.origin, monsterFlashOffset()[flashnum], forward, right, start);
    VectorSubtract(self.enemy.s.origin, start, target);
    const targ_angles = vec3();
    vectoangles2(target, targ_angles);

    const vec = vec3();
    VectorCopy(self.s.angles, vec);

    vec[PITCH] += targ_angles[PITCH];
    vec[YAW] -= sweep_angles[flashnum - MZ2_WIDOW2_BEAM_SWEEP_1];

    AngleVectors(vec, forward, null, null);
    monster_fire_heat(self, start, forward, vec3_origin, 10, 50, flashnum);
  } else {
    Widow2SaveBeamTarget(self);
    G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_WIDOW2_BEAMER_1], forward, right, start);

    VectorCopy(self.pos2, target);
    target[2] += self.enemy.viewheight - 10;

    VectorSubtract(target, start, forward);
    VectorNormalize(forward);

    monster_fire_heat(self, start, forward, vec3_origin, 10, 50, 0);
  }
}

function Widow2Spawn(self: EdictT): void {
  const f = vec3();
  const r = vec3();
  const u = vec3();

  AngleVectors(self.s.angles, f, r, u);

  for (let i = 0; i < 2; i++) {
    const offset = vec3();
    VectorCopy(spawnpoints[i], offset);

    const startpoint = vec3();
    G_ProjectSource2(self.s.origin, offset, f, r, u, startpoint);

    const spawnpoint = vec3();
    if (FindSpawnPoint(startpoint, stalker_mins, stalker_maxs, spawnpoint, 64)) {
      const ent = CreateGroundMonster(spawnpoint, self.s.angles, stalker_mins, stalker_maxs, "monster_stalker", 256);

      if (ent === null) continue;

      self.monsterinfo.monster_used++;
      ent.monsterinfo.commander = self;

      ent.nextthink = level.time;
      if (ent.think !== null) ent.think(ent);

      ent.monsterinfo.aiflags |= AI_SPAWNED_WIDOW | AI_DO_NOT_COUNT | AI_IGNORE_SHOTS;

      let designated_enemy: EdictT | null;
      if (!(cvarNum(gameCvars.coop) !== 0)) {
        designated_enemy = self.enemy;
      } else {
        designated_enemy = PickCoopTarget(ent);
        if (designated_enemy !== null) {
          // try to avoid using my enemy
          if (designated_enemy === self.enemy) {
            designated_enemy = PickCoopTarget(ent);
            if (designated_enemy === null) {
              designated_enemy = self.enemy;
            }
          }
        } else {
          designated_enemy = self.enemy;
        }
      }

      if (designated_enemy !== null && designated_enemy.inuse && designated_enemy.health > 0) {
        ent.enemy = designated_enemy;
        FoundTarget(ent);
        if (ent.monsterinfo.attack !== null) ent.monsterinfo.attack(ent);
      }
    }
  }
}

function widow2_spawn_check(self: EdictT): void {
  Widow2Beam(self);
  Widow2Spawn(self);
}

function widow2_ready_spawn(self: EdictT): void {
  Widow2Beam(self);

  const f = vec3();
  const r = vec3();
  const u = vec3();
  AngleVectors(self.s.angles, f, r, u);

  for (let i = 0; i < 2; i++) {
    const offset = vec3();
    VectorCopy(spawnpoints[i], offset);
    const startpoint = vec3();
    G_ProjectSource2(self.s.origin, offset, f, r, u, startpoint);
    const spawnpoint = vec3();
    if (FindSpawnPoint(startpoint, stalker_mins, stalker_maxs, spawnpoint, 64)) {
      SpawnGrow_Spawn(spawnpoint, 1);
    }
  }
}

const widow2_frames_stand: MframeT[] = [mf(ai_stand, 0)];
const widow2_move_stand = mkmove(F.FRAME_blackwidow3, F.FRAME_blackwidow3, widow2_frames_stand);

const widow2_frames_walk: MframeT[] = [
  mf(ai_walk, 9.01),
  mf(ai_walk, 7.55),
  mf(ai_walk, 7.01),
  mf(ai_walk, 6.66),
  mf(ai_walk, 6.2),
  mf(ai_walk, 5.78),
  mf(ai_walk, 7.25),
  mf(ai_walk, 8.37),
  mf(ai_walk, 10.41),
];
const widow2_move_walk = mkmove(F.FRAME_walk01, F.FRAME_walk09, widow2_frames_walk);

// C: `mmove_t widow2_move_run = {FRAME_walk01, FRAME_walk09, ...}` -- the run
// cycle reuses the walk animation's frame range verbatim (there is no
// separate run-only frame span), matched byte-for-byte here.
const widow2_frames_run: MframeT[] = [
  mf(ai_run, 9.01),
  mf(ai_run, 7.55),
  mf(ai_run, 7.01),
  mf(ai_run, 6.66),
  mf(ai_run, 6.2),
  mf(ai_run, 5.78),
  mf(ai_run, 7.25),
  mf(ai_run, 8.37),
  mf(ai_run, 10.41),
];
const widow2_move_run = mkmove(F.FRAME_walk01, F.FRAME_walk09, widow2_frames_run);

const widow2_frames_attack_pre_beam: MframeT[] = [
  mf(ai_charge, 4),
  mf(ai_charge, 4),
  mf(ai_charge, 4),
  mf(ai_charge, 4, widow2_attack_beam),
];
const widow2_move_attack_pre_beam = mkmove(F.FRAME_fireb01, F.FRAME_fireb04, widow2_frames_attack_pre_beam);

// Loop this
const widow2_frames_attack_beam: MframeT[] = [
  mf(ai_charge, 0, Widow2Beam),
  mf(ai_charge, 0, Widow2Beam),
  mf(ai_charge, 0, Widow2Beam),
  mf(ai_charge, 0, Widow2Beam),
  mf(ai_charge, 0, widow2_reattack_beam),
];
const widow2_move_attack_beam = mkmove(F.FRAME_fireb05, F.FRAME_fireb09, widow2_frames_attack_beam);

const widow2_frames_attack_post_beam: MframeT[] = [mf(ai_charge, 4), mf(ai_charge, 4), mf(ai_charge, 4)];
// C bug, not a porting error: m_widow2.c's widow2_frames_attack_post_beam[]
// has 3 rows (m_widow2.c:339-345) but widow2_move_attack_post_beam =
// {FRAME_fireb06, FRAME_fireb07, ...} only spans 2 frames (m_widow2.h:
// FRAME_fireb06=40, FRAME_fireb07=41). The engine only ever reads indices
// firstframe..lastframe, so the third row is dead in the original game too;
// preserved byte-for-byte.
const widow2_move_attack_post_beam = mkmove(
  F.FRAME_fireb06,
  F.FRAME_fireb07,
  widow2_frames_attack_post_beam,
  widow2_run,
  true,
);

function WidowDisrupt(self: EdictT): void {
  if (self.enemy === null) return; // C assumes self->enemy is set here

  const start = vec3();
  const dir = vec3();
  const forward = vec3();
  const right = vec3();

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_WIDOW_DISRUPTOR], forward, right, start);

  VectorSubtract(self.pos1, self.enemy.s.origin, dir);
  const len = VectorLength(dir);

  if (len < 30) {
    // calc direction to where we targeted
    VectorSubtract(self.pos1, start, dir);
    VectorNormalize(dir);

    monster_fire_tracker(self, start, dir, 20, 500, self.enemy, MZ2_WIDOW_DISRUPTOR);
  } else {
    PredictAim(self.enemy, start, 1200, true, 0, dir, null);
    monster_fire_tracker(self, start, dir, 20, 1200, null, MZ2_WIDOW_DISRUPTOR);
  }
}

function Widow2SaveDisruptLoc(self: EdictT): void {
  if (self.enemy !== null && self.enemy.inuse) {
    VectorCopy(self.enemy.s.origin, self.pos1); // save for aiming the shot
    self.pos1[2] += self.enemy.viewheight;
  } else {
    VectorCopy(vec3_origin, self.pos1);
  }
}

function widow2_disrupt_reattack(self: EdictT): void {
  const luck = Math.random();

  if (luck < 0.25 + cvarNum(gameCvars.skill) * 0.15) self.monsterinfo.nextframe = F.FRAME_firea01;
}

const widow2_frames_attack_disrupt: MframeT[] = [
  mf(ai_charge, 2),
  mf(ai_charge, 2),
  mf(ai_charge, 2, Widow2SaveDisruptLoc),
  mf(ai_charge, -20, WidowDisrupt),
  mf(ai_charge, 2),
  mf(ai_charge, 2),
  mf(ai_charge, 2, widow2_disrupt_reattack),
];
const widow2_move_attack_disrupt = mkmove(F.FRAME_firea01, F.FRAME_firea07, widow2_frames_attack_disrupt, widow2_run);

function Widow2SaveBeamTarget(self: EdictT): void {
  if (self.enemy !== null && self.enemy.inuse) {
    VectorCopy(self.pos1, self.pos2);
    VectorCopy(self.enemy.s.origin, self.pos1); // save for aiming the shot
  } else {
    VectorCopy(vec3_origin, self.pos1);
    VectorCopy(vec3_origin, self.pos2);
  }
}

function Widow2BeamTargetRemove(self: EdictT): void {
  VectorCopy(vec3_origin, self.pos1);
  VectorCopy(vec3_origin, self.pos2);
}

function Widow2StartSweep(self: EdictT): void {
  Widow2SaveBeamTarget(self);
}

const widow2_frames_spawn: MframeT[] = [
  mf(ai_charge, 0),
  mf(ai_charge, 0),
  mf(ai_charge, 0, widow_start_spawn),
  mf(ai_charge, 0, Widow2Beam),
  mf(ai_charge, 0, Widow2Beam), // 5
  mf(ai_charge, 0, Widow2Beam),
  mf(ai_charge, 0, Widow2Beam),
  mf(ai_charge, 0, Widow2Beam),
  mf(ai_charge, 0, Widow2Beam),
  mf(ai_charge, 0, widow2_ready_spawn), // 10
  mf(ai_charge, 0, Widow2Beam),
  mf(ai_charge, 0, Widow2Beam),
  mf(ai_charge, 0, Widow2Beam),
  mf(ai_charge, 0, widow2_spawn_check),
  mf(ai_charge, 0), // 15
  mf(ai_charge, 0),
  mf(ai_charge, 0),
  mf(ai_charge, 0, widow2_reattack_beam),
];
const widow2_move_spawn = mkmove(F.FRAME_spawn01, F.FRAME_spawn18, widow2_frames_spawn);

function widow2_tongue_attack_ok(start: Vec3, end: Vec3, range: number): boolean {
  const dir = vec3();

  // check for max distance
  VectorSubtract(start, end, dir);
  if (VectorLength(dir) > range) return false;

  // check for min/max pitch
  const angles = vec3();
  vectoangles(dir, angles);
  if (angles[0] < -180) angles[0] += 360;
  if (Math.abs(angles[0]) > 30) return false;

  return true;
}

function Widow2Tongue(self: EdictT): void {
  if (self.enemy === null) return; // C assumes self->enemy is set here

  const f = vec3();
  const r = vec3();
  const u = vec3();
  const start = vec3();
  const end = vec3();

  AngleVectors(self.s.angles, f, r, u);
  G_ProjectSource2(self.s.origin, offsets[self.s.frame - F.FRAME_tongs01], f, r, u, start);
  VectorCopy(self.enemy.s.origin, end);
  if (!widow2_tongue_attack_ok(start, end, 256)) {
    end[2] = self.enemy.s.origin[2] + self.enemy.maxs[2] - 8;
    if (!widow2_tongue_attack_ok(start, end, 256)) {
      end[2] = self.enemy.s.origin[2] + self.enemy.mins[2] + 8;
      if (!widow2_tongue_attack_ok(start, end, 256)) return;
    }
  }
  VectorCopy(self.enemy.s.origin, end);

  const tr = gi.trace(start, null, null, end, self, MASK_SHOT);
  if (traceEdict(tr.ent) !== self.enemy) return;

  gi.sound(self, CHAN_WEAPON, sound_tentacles_retract, 1, ATTN_NORM, 0);

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_PARASITE_ATTACK);
  gi.WriteShort(self.s.number);
  gi.WritePosition(start);
  gi.WritePosition(end);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);

  const dir = vec3();
  VectorSubtract(start, end, dir);
  T_Damage(self.enemy, self, self, dir, self.enemy.s.origin, vec3_origin, 2, 0, DAMAGE_NO_KNOCKBACK, MOD_UNKNOWN);
}

function Widow2TonguePull(self: EdictT): void {
  if (self.enemy === null || !self.enemy.inuse) {
    if (self.monsterinfo.run !== null) self.monsterinfo.run(self);
    return;
  }

  const f = vec3();
  const r = vec3();
  const u = vec3();
  const start = vec3();
  const end = vec3();

  AngleVectors(self.s.angles, f, r, u);
  G_ProjectSource2(self.s.origin, offsets[self.s.frame - F.FRAME_tongs01], f, r, u, start);
  VectorCopy(self.enemy.s.origin, end);

  if (!widow2_tongue_attack_ok(start, end, 256)) return;

  if (self.enemy.groundentity !== null) {
    self.enemy.s.origin[2] += 1;
    self.enemy.groundentity = null;
    // interesting, you don't have to relink the player
  }

  const vec = vec3();
  VectorSubtract(self.s.origin, self.enemy.s.origin, vec);
  // C: `len = VectorLength (vec);` computes a local that is never read
  // afterward (dead in the original) -- not computed here since it has no
  // observable effect.
  if (self.enemy.client !== null) {
    VectorNormalize(vec);
    VectorMA(self.enemy.velocity, 1000, vec, self.enemy.velocity);
  } else {
    self.enemy.ideal_yaw = vectoyaw2(vec);
    M_ChangeYaw(self.enemy);
    VectorScale(f, 1000, self.enemy.velocity);
  }
}

function Widow2Crunch(self: EdictT): void {
  if (self.enemy === null || !self.enemy.inuse) {
    if (self.monsterinfo.run !== null) self.monsterinfo.run(self);
    return;
  }

  Widow2TonguePull(self);

  // 70 + 32
  const aim = vec3(150, 0, 4);
  if (self.s.frame !== F.FRAME_tongs07) {
    fire_hit(self, aim, 20 + Math.floor(Math.random() * 6), 0);
  } else {
    if (self.enemy.groundentity !== null) fire_hit(self, aim, 20 + Math.floor(Math.random() * 6), 500);
    // not as much kick if they're in the air .. makes it harder to land on her head
    else fire_hit(self, aim, 20 + Math.floor(Math.random() * 6), 250);
  }
}

function Widow2Toss(self: EdictT): void {
  self.timestamp = level.time + 3;
}

const widow2_frames_tongs: MframeT[] = [
  mf(ai_charge, 0, Widow2Tongue),
  mf(ai_charge, 0, Widow2Tongue),
  mf(ai_charge, 0, Widow2Tongue),
  mf(ai_charge, 0, Widow2TonguePull),
  mf(ai_charge, 0, Widow2TonguePull), // 5
  mf(ai_charge, 0, Widow2TonguePull),
  mf(ai_charge, 0, Widow2Crunch),
  mf(ai_charge, 0, Widow2Toss),
];
const widow2_move_tongs = mkmove(F.FRAME_tongs01, F.FRAME_tongs08, widow2_frames_tongs, widow2_run);

const widow2_frames_pain: MframeT[] = [mf(ai_move, 0), mf(ai_move, 0), mf(ai_move, 0), mf(ai_move, 0), mf(ai_move, 0)];
const widow2_move_pain = mkmove(F.FRAME_pain01, F.FRAME_pain05, widow2_frames_pain, widow2_run);

const widow2_frames_death: MframeT[] = [
  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0, WidowExplosion1), // 3 boom
  mf(ai_move, 0),
  mf(ai_move, 0), // 5

  mf(ai_move, 0, WidowExplosion2), // 6 boom
  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0), // 10

  mf(ai_move, 0),
  mf(ai_move, 0), // 12
  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0), // 15

  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0, WidowExplosion3), // 18
  mf(ai_move, 0), // 19
  mf(ai_move, 0), // 20

  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0, WidowExplosion4), // 25

  mf(ai_move, 0), // 26
  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0, WidowExplosion5),
  mf(ai_move, 0, WidowExplosionLeg), // 30

  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0, WidowExplosion6),
  mf(ai_move, 0), // 35

  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0, WidowExplosion7),
  mf(ai_move, 0),
  mf(ai_move, 0), // 40

  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0, WidowExplode), // 44
];
const widow2_move_death = mkmove(F.FRAME_death01, F.FRAME_death44, widow2_frames_death);

const widow2_frames_dead: MframeT[] = [
  mf(ai_move, 0, widow2_start_searching),
  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0),

  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0),

  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0, widow2_keep_searching),
];
const widow2_move_dead = mkmove(F.FRAME_dthsrh01, F.FRAME_dthsrh15, widow2_frames_dead);

const widow2_frames_really_dead: MframeT[] = [
  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0),
  mf(ai_move, 0),

  mf(ai_move, 0),
  mf(ai_move, 0, widow2_finaldeath),
];
const widow2_move_really_dead = mkmove(F.FRAME_dthsrh16, F.FRAME_dthsrh22, widow2_frames_really_dead);

function widow2_start_searching(self: EdictT): void {
  self.count = 0;
}

function widow2_keep_searching(self: EdictT): void {
  if (self.count <= 2) {
    self.monsterinfo.currentmove = widow2_move_dead;
    self.s.frame = F.FRAME_dthsrh01;
    self.count++;
    return;
  }

  self.monsterinfo.currentmove = widow2_move_really_dead;
}

function widow2_finaldeath(self: EdictT): void {
  VectorSet(self.mins, -70, -70, 0);
  VectorSet(self.maxs, 70, 70, 80);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.takedamage = DamageT.DAMAGE_YES;
  self.nextthink = 0;
  gi.linkentity(self);
}

function widow2_stand(self: EdictT): void {
  self.monsterinfo.currentmove = widow2_move_stand;
}

function widow2_run(self: EdictT): void {
  self.monsterinfo.aiflags &= ~AI_HOLD_FRAME;

  if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = widow2_move_stand;
  else self.monsterinfo.currentmove = widow2_move_run;
}

function widow2_walk(self: EdictT): void {
  self.monsterinfo.currentmove = widow2_move_walk;
}

function widow2_melee(self: EdictT): void {
  self.monsterinfo.currentmove = widow2_move_tongs;
}

function widow2_attack(self: EdictT): void {
  let blocked = false;

  if (self.monsterinfo.aiflags & AI_BLOCKED) {
    blocked = true;
    self.monsterinfo.aiflags &= ~AI_BLOCKED;
  }

  if (self.enemy === null) return;

  if (self.bad_area !== null) {
    if (Math.random() < 0.75 || level.time < self.monsterinfo.attack_finished) {
      self.monsterinfo.currentmove = widow2_move_attack_pre_beam;
    } else {
      self.monsterinfo.currentmove = widow2_move_attack_disrupt;
    }
    return;
  }

  WidowCalcSlots(self);

  const SELF_SLOTS_LEFT = self.monsterinfo.monster_slots - self.monsterinfo.monster_used;

  // if we can't see the target, spawn stuff
  if (self.monsterinfo.attack_state === AS_BLIND && SELF_SLOTS_LEFT >= 2) {
    self.monsterinfo.currentmove = widow2_move_spawn;
    return;
  }

  // accept bias towards spawning
  if (blocked && SELF_SLOTS_LEFT >= 2) {
    self.monsterinfo.currentmove = widow2_move_spawn;
    return;
  }

  const range = realrange(self, self.enemy);

  if (range < 600) {
    const luck = Math.random();
    if (SELF_SLOTS_LEFT >= 2) {
      if (luck <= 0.4) self.monsterinfo.currentmove = widow2_move_attack_pre_beam;
      else if (luck <= 0.7 && !(level.time < self.monsterinfo.attack_finished)) {
        self.monsterinfo.currentmove = widow2_move_attack_disrupt;
      } else self.monsterinfo.currentmove = widow2_move_spawn;
    } else {
      if (luck <= 0.5 || level.time < self.monsterinfo.attack_finished) {
        self.monsterinfo.currentmove = widow2_move_attack_pre_beam;
      } else {
        self.monsterinfo.currentmove = widow2_move_attack_disrupt;
      }
    }
  } else {
    const luck = Math.random();
    if (SELF_SLOTS_LEFT >= 2) {
      if (luck < 0.3) self.monsterinfo.currentmove = widow2_move_attack_pre_beam;
      else if (luck < 0.65 || level.time < self.monsterinfo.attack_finished) {
        self.monsterinfo.currentmove = widow2_move_spawn;
      } else {
        self.monsterinfo.currentmove = widow2_move_attack_disrupt;
      }
    } else {
      if (luck < 0.45 || level.time < self.monsterinfo.attack_finished) {
        self.monsterinfo.currentmove = widow2_move_attack_pre_beam;
      } else {
        self.monsterinfo.currentmove = widow2_move_attack_disrupt;
      }
    }
  }
}

function widow2_attack_beam(self: EdictT): void {
  self.monsterinfo.currentmove = widow2_move_attack_beam;
}

function widow2_reattack_beam(self: EdictT): void {
  self.monsterinfo.aiflags &= ~AI_MANUAL_STEERING;

  if (self.enemy !== null && infront(self, self.enemy)) {
    if (Math.random() <= 0.5) {
      if (Math.random() < 0.7 || self.monsterinfo.monster_slots - self.monsterinfo.monster_used < 2) {
        self.monsterinfo.currentmove = widow2_move_attack_beam;
      } else {
        self.monsterinfo.currentmove = widow2_move_spawn;
      }
    } else {
      self.monsterinfo.currentmove = widow2_move_attack_post_beam;
    }
  } else {
    self.monsterinfo.currentmove = widow2_move_attack_post_beam;
  }
}

function widow2_pain(self: EdictT, _other: EdictT, _kick: number, damage: number): void {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;

  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 5;

  if (damage < 15) {
    gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NONE, 0);
  } else if (damage < 75) {
    gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NONE, 0);
    if (cvarNum(gameCvars.skill) < 3 && Math.random() < 0.6 - 0.2 * cvarNum(gameCvars.skill)) {
      self.monsterinfo.aiflags &= ~AI_MANUAL_STEERING;
      self.monsterinfo.currentmove = widow2_move_pain;
    }
  } else {
    gi.sound(self, CHAN_VOICE, sound_pain3, 1, ATTN_NONE, 0);
    if (cvarNum(gameCvars.skill) < 3 && Math.random() < 0.75 - 0.1 * cvarNum(gameCvars.skill)) {
      self.monsterinfo.aiflags &= ~AI_MANUAL_STEERING;
      self.monsterinfo.currentmove = widow2_move_pain;
    }
  }
}

function widow2_dead(_self: EdictT): void {}

function KillChildren(self: EdictT): void {
  if (self.enemy === null) return; // C assumes self->enemy is set here

  let ent: EdictT | null = null;
  for (;;) {
    ent = G_Find(ent, "classname", "monster_stalker");
    if (ent === null) return;

    // FIXME - may need to stagger
    if (ent.inuse && ent.health > 0) {
      T_Damage(ent, self, self, vec3_origin, self.enemy.s.origin, vec3_origin, ent.health + 1, 0, DAMAGE_NO_KNOCKBACK, MOD_UNKNOWN);
    }
  }
}

function widow2_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3): void {
  // check for gib
  if (self.health <= self.gib_health) {
    const clipped = Math.min(damage, 100);

    gi.sound(self, CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
    for (let n = 0; n < 2; n++) ThrowWidowGibLoc(self, "models/objects/gibs/bone/tris.md2", clipped, GIB_ORGANIC, null, false);
    for (let n = 0; n < 3; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", clipped, GIB_ORGANIC, null, false);
    for (let n = 0; n < 3; n++) {
      ThrowWidowGibSized(self, "models/monsters/blackwidow2/gib1/tris.md2", clipped, GIB_METALLIC, null, 0, false);
      ThrowWidowGibSized(
        self,
        "models/monsters/blackwidow2/gib2/tris.md2",
        clipped,
        GIB_METALLIC,
        null,
        gi.soundindex("misc/fhit3.wav"),
        false,
      );
    }
    for (let n = 0; n < 2; n++) {
      ThrowWidowGibSized(self, "models/monsters/blackwidow2/gib3/tris.md2", clipped, GIB_METALLIC, null, 0, false);
      ThrowWidowGibSized(self, "models/monsters/blackwidow/gib3/tris.md2", clipped, GIB_METALLIC, null, 0, false);
    }
    ThrowGib(self, "models/objects/gibs/chest/tris.md2", clipped, GIB_ORGANIC);
    ThrowHead(self, "models/objects/gibs/head2/tris.md2", clipped, GIB_ORGANIC);
    self.deadflag = DEAD_DEAD;
    return;
  }

  if (self.deadflag === DEAD_DEAD) return;

  gi.sound(self, CHAN_VOICE, sound_death, 1, ATTN_NONE, 0);
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_NO;
  self.count = 0;
  KillChildren(self);
  self.monsterinfo.quad_framenum = 0;
  self.monsterinfo.double_framenum = 0;
  self.monsterinfo.invincible_framenum = 0;
  self.monsterinfo.currentmove = widow2_move_death;
}

function Widow2_CheckAttack(self: EdictT): boolean {
  if (self.enemy === null) return false;

  WidowPowerups(self);

  if (Math.random() < 0.8 && self.monsterinfo.monster_slots - self.monsterinfo.monster_used >= 2 && realrange(self, self.enemy) > 150) {
    self.monsterinfo.aiflags |= AI_BLOCKED;
    self.monsterinfo.attack_state = AS_MISSILE;
    return true;
  }

  if (self.enemy.health > 0) {
    // see if any entities are in the way of the shot
    const spot1 = vec3();
    VectorCopy(self.s.origin, spot1);
    spot1[2] += self.viewheight;
    const spot2 = vec3();
    VectorCopy(self.enemy.s.origin, spot2);
    spot2[2] += self.enemy.viewheight;

    const tr = gi.trace(spot1, null, null, spot2, self, CONTENTS_SOLID | CONTENTS_MONSTER | CONTENTS_SLIME | CONTENTS_LAVA);

    // do we have a clear shot?
    if (traceEdict(tr.ent) !== self.enemy) {
      // go ahead and spawn stuff if we're mad a a client
      if (self.enemy.client !== null && self.monsterinfo.monster_slots - self.monsterinfo.monster_used >= 2) {
        self.monsterinfo.attack_state = AS_BLIND;
        return true;
      }

      // PGM - we want them to go ahead and shoot at info_notnulls if they can.
      if (self.enemy.solid !== SolidT.SOLID_NOT || tr.fraction < 1.0) return false;
    }
  }

  const enemy_infront = infront(self, self.enemy);
  const enemy_range = range(self, self.enemy);
  const temp = vec3();
  VectorSubtract(self.enemy.s.origin, self.s.origin, temp);
  const enemy_yaw = vectoyaw2(temp);

  self.ideal_yaw = enemy_yaw;

  // melee attack
  if (self.timestamp < level.time) {
    const real_enemy_range = realrange(self, self.enemy);
    if (real_enemy_range < 300) {
      const f = vec3();
      const r = vec3();
      const u = vec3();
      AngleVectors(self.s.angles, f, r, u);
      const spot1 = vec3();
      G_ProjectSource2(self.s.origin, offsets[0], f, r, u, spot1);
      const spot2 = vec3();
      VectorCopy(self.enemy.s.origin, spot2);
      if (widow2_tongue_attack_ok(spot1, spot2, 256)) {
        // melee attack ok

        // be nice in easy mode
        // C: `rand()&3` -- a nonzero-3-out-of-4 draw; rand()%N idiom per
        // PORTING.md's house style.
        if (cvarNum(gameCvars.skill) === 0 && Math.floor(Math.random() * 4) !== 0) return false;

        if (self.monsterinfo.melee !== null) self.monsterinfo.attack_state = AS_MELEE;
        else self.monsterinfo.attack_state = AS_MISSILE;
        return true;
      }
    }
  }

  if (level.time < self.monsterinfo.attack_finished) return false;

  let chance: number;
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) {
    chance = 0.4;
  } else if (enemy_range === RANGE_NEAR) {
    chance = 0.8;
  } else if (enemy_range === RANGE_MID) {
    chance = 0.8;
  } else if (enemy_range === RANGE_FAR) {
    chance = 0.5;
  } else {
    // C: `chance` is left uninitialized here (m_widow2.c:1092-1108 has no
    // RANGE_MELEE branch) -- real undefined behavior in the shipped game.
    // TypeScript requires definite assignment; 0 is used as the safest
    // deterministic substitute (documented deviation).
    chance = 0;
  }

  // PGM - go ahead and shoot every time if it's a info_notnull
  if (Math.random() < chance || self.enemy.solid === SolidT.SOLID_NOT) {
    self.monsterinfo.attack_state = AS_MISSILE;
    return true;
  }

  return false;
}

function Widow2Precache(): void {
  // cache in all of the stalker stuff, widow stuff, spawngro stuff, gibs
  gi.soundindex("parasite/parpain1.wav");
  gi.soundindex("parasite/parpain2.wav");
  gi.soundindex("parasite/pardeth1.wav");
  gi.soundindex("parasite/paratck1.wav");
  gi.soundindex("parasite/parsght1.wav");
  gi.soundindex("infantry/melee2.wav");
  gi.soundindex("misc/fhit3.wav");

  gi.soundindex("tank/tnkatck3.wav");
  gi.soundindex("weapons/disrupt.wav");
  gi.soundindex("weapons/disint2.wav");

  gi.modelindex("models/monsters/stalker/tris.md2");
  gi.modelindex("models/items/spawngro2/tris.md2");
  gi.modelindex("models/objects/gibs/sm_metal/tris.md2");
  gi.modelindex("models/proj/laser2/tris.md2");
  gi.modelindex("models/proj/disintegrator/tris.md2");

  gi.modelindex("models/monsters/blackwidow/gib1/tris.md2");
  gi.modelindex("models/monsters/blackwidow/gib2/tris.md2");
  gi.modelindex("models/monsters/blackwidow/gib3/tris.md2");
  gi.modelindex("models/monsters/blackwidow/gib4/tris.md2");
  gi.modelindex("models/monsters/blackwidow2/gib1/tris.md2");
  gi.modelindex("models/monsters/blackwidow2/gib2/tris.md2");
  gi.modelindex("models/monsters/blackwidow2/gib3/tris.md2");
  gi.modelindex("models/monsters/blackwidow2/gib4/tris.md2");
}

/*QUAKED monster_widow2 (1 .5 0) (-70 -70 0) (70 70 144) Ambush Trigger_Spawn Sight
 */
export function SP_monster_widow2(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  sound_pain1 = gi.soundindex("widow/bw2pain1.wav");
  sound_pain2 = gi.soundindex("widow/bw2pain2.wav");
  sound_pain3 = gi.soundindex("widow/bw2pain3.wav");
  sound_death = gi.soundindex("widow/death.wav");
  sound_search1 = gi.soundindex("bosshovr/bhvunqv1.wav");
  sound_tentacles_retract = gi.soundindex("brain/brnatck3.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/blackwidow2/tris.md2");
  VectorSet(self.mins, -70, -70, 0);
  VectorSet(self.maxs, 70, 70, 144);

  self.health = (2000 + 800 + 1000 * cvarNum(gameCvars.skill)) | 0;
  if (cvarNum(gameCvars.coop) !== 0) self.health = (self.health + 500 * cvarNum(gameCvars.skill)) | 0;
  self.gib_health = -900;
  self.mass = 2500;

  if (cvarNum(gameCvars.skill) === 3) {
    self.monsterinfo.power_armor_type = POWER_ARMOR_SHIELD;
    self.monsterinfo.power_armor_power = 750;
  }

  self.yaw_speed = 30;

  self.flags |= FL_IMMUNE_LASER;
  self.monsterinfo.aiflags |= AI_IGNORE_SHOTS;

  self.pain = widow2_pain;
  self.die = widow2_die;

  self.monsterinfo.melee = widow2_melee;
  self.monsterinfo.stand = widow2_stand;
  self.monsterinfo.walk = widow2_walk;
  self.monsterinfo.run = widow2_run;
  self.monsterinfo.attack = widow2_attack;
  self.monsterinfo.search = widow2_search;
  self.monsterinfo.checkattack = Widow2_CheckAttack;
  gi.linkentity(self);

  self.monsterinfo.currentmove = widow2_move_stand;
  self.monsterinfo.scale = F.MODEL_SCALE;

  Widow2Precache();
  WidowCalcSlots(self);
  walkmonster_start(self);
}

//
// Death sequence stuff
//

function WidowVelocityForDamage(damage: number, v: Vec3): void {
  v[0] = damage * crandom();
  v[1] = damage * crandom();
  v[2] = damage * crandom() + 200.0;
}

function widow_gib_touch(self: EdictT, _other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  self.solid = SolidT.SOLID_NOT;
  self.touch = null;
  self.s.angles[PITCH] = 0;
  self.s.angles[ROLL] = 0;
  VectorClear(self.avelocity);

  if (self.plat2flags !== 0) {
    gi.sound(self, CHAN_VOICE, self.plat2flags, 1, ATTN_NORM, 0);
  }
}

function ThrowWidowGib(self: EdictT, gibname: string, damage: number, gibType: number): void {
  ThrowWidowGibReal(self, gibname, damage, gibType, null, false, 0, true);
}

// exported: called externally from g_spawn.c's widowlegs_think (m_widow2.c's
// gib helpers have external linkage in the C; the sibling g_spawn.ts imports
// this one directly for the severed-leg death prop).
export function ThrowWidowGibLoc(self: EdictT, gibname: string, damage: number, gibType: number, startpos: Vec3 | null, fade: boolean): void {
  ThrowWidowGibReal(self, gibname, damage, gibType, startpos, false, 0, fade);
}

// exported: same external-linkage note as ThrowWidowGibLoc above --
// g_spawn.ts's widowlegs_think imports this one directly too.
export function ThrowWidowGibSized(
  self: EdictT,
  gibname: string,
  damage: number,
  gibType: number,
  startpos: Vec3 | null,
  hitsound: number,
  fade: boolean,
): void {
  ThrowWidowGibReal(self, gibname, damage, gibType, startpos, true, hitsound, fade);
}

function ThrowWidowGibReal(
  self: EdictT,
  gibname: string | null,
  damage: number,
  gibType: number,
  startpos: Vec3 | null,
  sized: boolean,
  hitsound: number,
  fade: boolean,
): void {
  if (gibname === null) return;

  const gib = G_Spawn();

  if (startpos !== null) {
    VectorCopy(startpos, gib.s.origin);
  } else {
    const size = vec3();
    VectorScale(self.size, 0.5, size);
    const origin = vec3();
    VectorAdd(self.absmin, size, origin);
    gib.s.origin[0] = origin[0] + crandom() * size[0];
    gib.s.origin[1] = origin[1] + crandom() * size[1];
    gib.s.origin[2] = origin[2] + crandom() * size[2];
  }

  gib.solid = SolidT.SOLID_NOT;
  gib.s.effects |= EF_GIB;
  gib.flags |= FL_NO_KNOCKBACK;
  gib.takedamage = DamageT.DAMAGE_YES;
  gib.die = gib_die;
  gib.s.renderfx |= RF_IR_VISIBLE;

  if (fade) {
    gib.think = G_FreeEdict;
    // sized gibs last longer
    if (sized) gib.nextthink = level.time + 20 + Math.random() * 15;
    else gib.nextthink = level.time + 5 + Math.random() * 10;
  } else {
    gib.think = G_FreeEdict;
    // sized gibs last longer
    if (sized) gib.nextthink = level.time + 60 + Math.random() * 15;
    else gib.nextthink = level.time + 25 + Math.random() * 10;
  }

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
  WidowVelocityForDamage(damage, vd);
  VectorMA(self.velocity, vscale, vd, gib.velocity);
  ClipGibVelocity(gib);

  gi.setmodel(gib, gibname);

  if (sized) {
    gib.plat2flags = hitsound;
    gib.solid = SolidT.SOLID_BBOX;
    gib.avelocity[0] = Math.random() * 400;
    gib.avelocity[1] = Math.random() * 400;
    gib.avelocity[2] = Math.random() * 200;
    if (gib.velocity[2] < 0) gib.velocity[2] *= -1;
    gib.velocity[0] *= 2;
    gib.velocity[1] *= 2;
    ClipGibVelocity(gib);
    gib.velocity[2] = Math.max(350 + Math.random() * 100.0, gib.velocity[2]);
    gib.gravity = 0.25;
    gib.touch = widow_gib_touch;
    gib.owner = self;
    if (gib.s.modelindex === gi.modelindex("models/monsters/blackwidow2/gib2/tris.md2")) {
      VectorSet(gib.mins, -10, -10, 0);
      VectorSet(gib.maxs, 10, 10, 10);
    } else {
      VectorSet(gib.mins, -5, -5, 0);
      VectorSet(gib.maxs, 5, 5, 5);
    }
  } else {
    gib.velocity[0] *= 2;
    gib.velocity[1] *= 2;
    gib.avelocity[0] = Math.random() * 600;
    gib.avelocity[1] = Math.random() * 600;
    gib.avelocity[2] = Math.random() * 600;
  }

  gi.linkentity(gib);
}

// Split out of BloodFountain below: TypeScript does not compute narrowed
// types for statements after an unconditional `return` (verified in
// isolation), so `startpos !== null` inside BloodFountain's dead loop
// wouldn't narrow `startpos` for VectorCopy. Passing the still-nullable
// value into a normal (independently-checked) function sidesteps that --
// this helper's own body is ordinary reachable code.
function bloodFountainOrigin(self: EdictT, startpos: Vec3 | null): Vec3 {
  const origin = vec3();
  if (startpos !== null) {
    VectorCopy(startpos, origin);
  } else {
    const size = vec3();
    VectorScale(self.size, 0.5, size);
    VectorAdd(self.absmin, size, origin);
    origin[0] += crandom() * size[0];
    origin[1] += crandom() * size[1];
    origin[2] += crandom() * size[2];
  }
  return origin;
}

function BloodFountain(self: EdictT, count: number, startpos: Vec3 | null, damage: number): void {
  return;

  // C: `return;` above is unconditional (m_widow2.c:1389) -- the loop below
  // never runs in the original either, and its own temp-entity writes are
  // `//`-commented out. Preserved whole (BloodFountain has no call sites in
  // m_widow2.c) rather than dropped, per this unit's "port every function"
  // instruction.
  for (let n = 0; n < count; n++) {
    const origin = bloodFountainOrigin(self, startpos);

    const vd = vec3();
    WidowVelocityForDamage(damage, vd);
    const velocity = vec3();
    VectorMA(self.velocity, 1.0, vd, velocity);
    velocity[0] *= 2;
    velocity[1] *= 2;
  }
}

// exported: g_spawn.c's widowlegs_think calls this directly (non-static in
// the C); the sibling g_spawn.ts imports it from here.
export function ThrowSmallStuff(self: EdictT, point: Vec3): void {
  for (let n = 0; n < 2; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", 300, GIB_ORGANIC, point, false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 300, GIB_METALLIC, point, false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 100, GIB_METALLIC, point, false);
}

// exported: forward-declared as non-static in g_spawn.c too (matching
// ThrowSmallStuff's external linkage above), even though g_spawn.c's
// widowlegs_think doesn't happen to call this particular one.
export function ThrowMoreStuff(self: EdictT, point: Vec3): void {
  if (cvarNum(gameCvars.coop) !== 0) {
    ThrowSmallStuff(self, point);
    return;
  }

  ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", 300, GIB_ORGANIC, point, false);
  for (let n = 0; n < 2; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 300, GIB_METALLIC, point, false);
  for (let n = 0; n < 3; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 100, GIB_METALLIC, point, false);
}

function WidowExplode(self: EdictT): void {
  self.think = WidowExplode;

  const org = vec3();
  VectorCopy(self.s.origin, org);
  // C: `rand()&15` / `rand()&31` -- uniform 0..15 / 0..31 draws; rand()%N
  // idiom per PORTING.md's house style (the masks are already power-of-two
  // spans so `%N` and `&(N-1)` are equivalent here).
  org[2] += 24 + Math.floor(Math.random() * 16);
  if (self.count < 8) org[2] += 24 + Math.floor(Math.random() * 32);

  switch (self.count) {
    case 0:
      org[0] -= 24;
      org[1] -= 24;
      break;
    case 1:
      org[0] += 24;
      org[1] += 24;
      ThrowSmallStuff(self, org);
      break;
    case 2:
      org[0] += 24;
      org[1] -= 24;
      break;
    case 3:
      org[0] -= 24;
      org[1] += 24;
      ThrowMoreStuff(self, org);
      break;
    case 4:
      org[0] -= 48;
      org[1] -= 48;
      break;
    case 5:
      org[0] += 48;
      org[1] += 48;
      ThrowArm1(self);
      break;
    case 6:
      org[0] -= 48;
      org[1] += 48;
      ThrowArm2(self);
      break;
    case 7:
      org[0] += 48;
      org[1] -= 48;
      ThrowSmallStuff(self, org);
      break;
    case 8:
      org[0] += 18;
      org[1] += 18;
      org[2] = self.s.origin[2] + 48;
      ThrowMoreStuff(self, org);
      break;
    case 9:
      org[0] -= 18;
      org[1] += 18;
      org[2] = self.s.origin[2] + 48;
      break;
    case 10:
      org[0] += 18;
      org[1] -= 18;
      org[2] = self.s.origin[2] + 48;
      break;
    case 11:
      org[0] -= 18;
      org[1] -= 18;
      org[2] = self.s.origin[2] + 48;
      break;
    case 12: {
      self.s.sound = 0;
      ThrowWidowGib(self, "models/objects/gibs/sm_meat/tris.md2", 400, GIB_ORGANIC);
      for (let n = 0; n < 2; n++) ThrowWidowGib(self, "models/objects/gibs/sm_metal/tris.md2", 100, GIB_METALLIC);
      for (let n = 0; n < 2; n++) ThrowWidowGib(self, "models/objects/gibs/sm_metal/tris.md2", 400, GIB_METALLIC);
      self.deadflag = DEAD_DEAD;
      self.think = monster_think;
      self.nextthink = level.time + 0.1;
      self.monsterinfo.currentmove = widow2_move_dead;
      return;
    }
  }

  self.count++;
  if (self.count >= 9 && self.count <= 12) {
    gi.WriteByte(svc_temp_entity);
    gi.WriteByte(TempEventT.TE_EXPLOSION1_BIG);
    gi.WritePosition(org);
    gi.multicast(self.s.origin, MulticastT.MULTICAST_ALL);
  } else {
    // else
    gi.WriteByte(svc_temp_entity);
    if (self.count % 2) gi.WriteByte(TempEventT.TE_EXPLOSION1);
    else gi.WriteByte(TempEventT.TE_EXPLOSION1_NP);
    gi.WritePosition(org);
    gi.multicast(self.s.origin, MulticastT.MULTICAST_ALL);
  }

  self.nextthink = level.time + 0.1;
}

function WidowExplosion1(self: EdictT): void {
  const f = vec3();
  const r = vec3();
  const u = vec3();
  const offset = vec3(23.74, -37.67, 76.96);
  const startpoint = vec3();

  AngleVectors(self.s.angles, f, r, u);
  G_ProjectSource2(self.s.origin, offset, f, r, u, startpoint);

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_EXPLOSION1);
  gi.WritePosition(startpoint);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_ALL);

  ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", 300, GIB_ORGANIC, startpoint, false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 100, GIB_METALLIC, startpoint, false);
  for (let n = 0; n < 2; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 300, GIB_METALLIC, startpoint, false);
}

function WidowExplosion2(self: EdictT): void {
  const f = vec3();
  const r = vec3();
  const u = vec3();
  const offset = vec3(-20.49, 36.92, 73.52);
  const startpoint = vec3();

  AngleVectors(self.s.angles, f, r, u);
  G_ProjectSource2(self.s.origin, offset, f, r, u, startpoint);

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_EXPLOSION1);
  gi.WritePosition(startpoint);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_ALL);

  ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", 300, GIB_ORGANIC, startpoint, false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 100, GIB_METALLIC, startpoint, false);
  for (let n = 0; n < 2; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 300, GIB_METALLIC, startpoint, false);
}

function WidowExplosion3(self: EdictT): void {
  const f = vec3();
  const r = vec3();
  const u = vec3();
  const offset = vec3(2.11, 0.05, 92.2);
  const startpoint = vec3();

  AngleVectors(self.s.angles, f, r, u);
  G_ProjectSource2(self.s.origin, offset, f, r, u, startpoint);

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_EXPLOSION1);
  gi.WritePosition(startpoint);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_ALL);

  ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", 300, GIB_ORGANIC, startpoint, false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 100, GIB_METALLIC, startpoint, false);
  for (let n = 0; n < 2; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 300, GIB_METALLIC, startpoint, false);
}

function WidowExplosion4(self: EdictT): void {
  const f = vec3();
  const r = vec3();
  const u = vec3();
  const offset = vec3(-28.04, -35.57, -77.56);
  const startpoint = vec3();

  AngleVectors(self.s.angles, f, r, u);
  G_ProjectSource2(self.s.origin, offset, f, r, u, startpoint);

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_EXPLOSION1);
  gi.WritePosition(startpoint);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_ALL);

  ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", 300, GIB_ORGANIC, startpoint, false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 100, GIB_METALLIC, startpoint, false);
  for (let n = 0; n < 2; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 300, GIB_METALLIC, startpoint, false);
}

function WidowExplosion5(self: EdictT): void {
  const f = vec3();
  const r = vec3();
  const u = vec3();
  const offset = vec3(-20.11, -1.11, 40.76);
  const startpoint = vec3();

  AngleVectors(self.s.angles, f, r, u);
  G_ProjectSource2(self.s.origin, offset, f, r, u, startpoint);

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_EXPLOSION1);
  gi.WritePosition(startpoint);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_ALL);

  ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", 300, GIB_ORGANIC, startpoint, false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 100, GIB_METALLIC, startpoint, false);
  for (let n = 0; n < 2; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 300, GIB_METALLIC, startpoint, false);
}

function WidowExplosion6(self: EdictT): void {
  const f = vec3();
  const r = vec3();
  const u = vec3();
  const offset = vec3(-20.11, -1.11, 40.76);
  const startpoint = vec3();

  AngleVectors(self.s.angles, f, r, u);
  G_ProjectSource2(self.s.origin, offset, f, r, u, startpoint);

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_EXPLOSION1);
  gi.WritePosition(startpoint);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_ALL);

  ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", 300, GIB_ORGANIC, startpoint, false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 100, GIB_METALLIC, startpoint, false);
  for (let n = 0; n < 2; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 300, GIB_METALLIC, startpoint, false);
}

function WidowExplosion7(self: EdictT): void {
  const f = vec3();
  const r = vec3();
  const u = vec3();
  const offset = vec3(-20.11, -1.11, 40.76);
  const startpoint = vec3();

  AngleVectors(self.s.angles, f, r, u);
  G_ProjectSource2(self.s.origin, offset, f, r, u, startpoint);

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_EXPLOSION1);
  gi.WritePosition(startpoint);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_ALL);

  ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", 300, GIB_ORGANIC, startpoint, false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 100, GIB_METALLIC, startpoint, false);
  for (let n = 0; n < 2; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 300, GIB_METALLIC, startpoint, false);
}

function WidowExplosionLeg(self: EdictT): void {
  const f = vec3();
  const r = vec3();
  const u = vec3();
  const offset1 = vec3(-31.89, -47.86, 67.02);
  const offset2 = vec3(-44.9, -82.14, 54.72);
  const startpoint = vec3();

  AngleVectors(self.s.angles, f, r, u);
  G_ProjectSource2(self.s.origin, offset1, f, r, u, startpoint);

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_EXPLOSION1_BIG);
  gi.WritePosition(startpoint);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_ALL);

  ThrowWidowGibSized(self, "models/monsters/blackwidow2/gib2/tris.md2", 200, GIB_METALLIC, startpoint, gi.soundindex("misc/fhit3.wav"), false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", 300, GIB_ORGANIC, startpoint, false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 100, GIB_METALLIC, startpoint, false);

  G_ProjectSource2(self.s.origin, offset2, f, r, u, startpoint);

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_EXPLOSION1);
  gi.WritePosition(startpoint);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_ALL);

  ThrowWidowGibSized(self, "models/monsters/blackwidow2/gib1/tris.md2", 300, GIB_METALLIC, startpoint, gi.soundindex("misc/fhit3.wav"), false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", 300, GIB_ORGANIC, startpoint, false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 100, GIB_METALLIC, startpoint, false);
}

function ThrowArm1(self: EdictT): void {
  const f = vec3();
  const r = vec3();
  const u = vec3();
  const offset1 = vec3(65.76, 17.52, 7.56);
  const startpoint = vec3();

  AngleVectors(self.s.angles, f, r, u);
  G_ProjectSource2(self.s.origin, offset1, f, r, u, startpoint);

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_EXPLOSION1_BIG);
  gi.WritePosition(startpoint);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_ALL);

  for (let n = 0; n < 2; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 100, GIB_METALLIC, startpoint, false);
}

function ThrowArm2(self: EdictT): void {
  const f = vec3();
  const r = vec3();
  const u = vec3();
  const offset1 = vec3(65.76, 17.52, 7.56);
  const startpoint = vec3();

  AngleVectors(self.s.angles, f, r, u);
  G_ProjectSource2(self.s.origin, offset1, f, r, u, startpoint);

  ThrowWidowGibSized(self, "models/monsters/blackwidow2/gib4/tris.md2", 200, GIB_METALLIC, startpoint, gi.soundindex("misc/fhit3.wav"), false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", 300, GIB_ORGANIC, startpoint, false);
}

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- so a save containing an entity that
// references one of these callbacks or move tables restores a real
// think/touch/use/pain/die/blocked function or monsterinfo.currentmove
// object instead of null (see g_save.ts's registerSaveFunction/
// registerSaveMmove name registry).
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("m_widow2:pauseme", pauseme);
registerSaveFunction("m_widow2:widow2_search", widow2_search);
registerSaveFunction("m_widow2:Widow2Beam", Widow2Beam);
registerSaveFunction("m_widow2:Widow2Spawn", Widow2Spawn);
registerSaveFunction("m_widow2:widow2_spawn_check", widow2_spawn_check);
registerSaveFunction("m_widow2:widow2_ready_spawn", widow2_ready_spawn);
registerSaveFunction("m_widow2:widow2_attack_beam", widow2_attack_beam);
registerSaveFunction("m_widow2:widow2_reattack_beam", widow2_reattack_beam);
registerSaveFunction("m_widow2:WidowDisrupt", WidowDisrupt);
registerSaveFunction("m_widow2:Widow2SaveDisruptLoc", Widow2SaveDisruptLoc);
registerSaveFunction("m_widow2:widow2_disrupt_reattack", widow2_disrupt_reattack);
registerSaveFunction("m_widow2:Widow2SaveBeamTarget", Widow2SaveBeamTarget);
registerSaveFunction("m_widow2:Widow2BeamTargetRemove", Widow2BeamTargetRemove);
registerSaveFunction("m_widow2:Widow2StartSweep", Widow2StartSweep);
registerSaveFunction("m_widow2:Widow2Tongue", Widow2Tongue);
registerSaveFunction("m_widow2:Widow2TonguePull", Widow2TonguePull);
registerSaveFunction("m_widow2:Widow2Crunch", Widow2Crunch);
registerSaveFunction("m_widow2:Widow2Toss", Widow2Toss);
registerSaveFunction("m_widow2:widow2_start_searching", widow2_start_searching);
registerSaveFunction("m_widow2:widow2_keep_searching", widow2_keep_searching);
registerSaveFunction("m_widow2:widow2_finaldeath", widow2_finaldeath);
registerSaveFunction("m_widow2:widow2_stand", widow2_stand);
registerSaveFunction("m_widow2:widow2_run", widow2_run);
registerSaveFunction("m_widow2:widow2_walk", widow2_walk);
registerSaveFunction("m_widow2:widow2_melee", widow2_melee);
registerSaveFunction("m_widow2:widow2_attack", widow2_attack);
registerSaveFunction("m_widow2:widow2_pain", widow2_pain);
registerSaveFunction("m_widow2:widow2_dead", widow2_dead);
registerSaveFunction("m_widow2:widow2_die", widow2_die);
registerSaveFunction("m_widow2:Widow2_CheckAttack", Widow2_CheckAttack);
registerSaveFunction("m_widow2:widow_gib_touch", widow_gib_touch);
registerSaveFunction("m_widow2:WidowExplode", WidowExplode);
registerSaveFunction("m_widow2:WidowExplosion1", WidowExplosion1);
registerSaveFunction("m_widow2:WidowExplosion2", WidowExplosion2);
registerSaveFunction("m_widow2:WidowExplosion3", WidowExplosion3);
registerSaveFunction("m_widow2:WidowExplosion4", WidowExplosion4);
registerSaveFunction("m_widow2:WidowExplosion5", WidowExplosion5);
registerSaveFunction("m_widow2:WidowExplosion6", WidowExplosion6);
registerSaveFunction("m_widow2:WidowExplosion7", WidowExplosion7);
registerSaveFunction("m_widow2:WidowExplosionLeg", WidowExplosionLeg);
registerSaveFunction("m_widow2:ThrowArm1", ThrowArm1);
registerSaveFunction("m_widow2:ThrowArm2", ThrowArm2);

registerSaveMmove("m_widow2:widow2_move_stand", widow2_move_stand);
registerSaveMmove("m_widow2:widow2_move_walk", widow2_move_walk);
registerSaveMmove("m_widow2:widow2_move_run", widow2_move_run);
registerSaveMmove("m_widow2:widow2_move_attack_pre_beam", widow2_move_attack_pre_beam);
registerSaveMmove("m_widow2:widow2_move_attack_beam", widow2_move_attack_beam);
registerSaveMmove("m_widow2:widow2_move_attack_post_beam", widow2_move_attack_post_beam);
registerSaveMmove("m_widow2:widow2_move_attack_disrupt", widow2_move_attack_disrupt);
registerSaveMmove("m_widow2:widow2_move_spawn", widow2_move_spawn);
registerSaveMmove("m_widow2:widow2_move_tongs", widow2_move_tongs);
registerSaveMmove("m_widow2:widow2_move_pain", widow2_move_pain);
registerSaveMmove("m_widow2:widow2_move_death", widow2_move_death);
registerSaveMmove("m_widow2:widow2_move_dead", widow2_move_dead);
registerSaveMmove("m_widow2:widow2_move_really_dead", widow2_move_really_dead);
