// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_xatrix_fixbot.cpp / m_xatrix_fixbot.h -- the FIXBOT monster (xatrix /
// Ground Zero mission pack, 2023 Quake II re-release / "KEX" engine). Ported
// from ~/Projects/quake2-rerelease-dll/rerelease/xatrix/m_xatrix_fixbot.cpp
// (1,404 lines, C++17) and m_xatrix_fixbot.h (224 lines, 221-entry frame
// enum plus MODEL_SCALE). Behavioral code, ported bug-for-bug per
// PORTING.md. A flying welder/repair bot: roaming goal-seeking (scans for
// `object_repair` props via `use_scanner`), a laser "heal" attack that
// resurrects a dead, undercounted monster back to full health (borrowing
// m_medic.ts's `abortHeal`/`cleanupHealTarget`), a welding-spark melee-range
// attack on props, and a blaster attack when it has no medic target.
//
// ============================================================================
// FRAME_ constants (only identifiers named by the .cpp are declared, see
// m_gladiator.ts/m_guncmdr.ts precedent) -- computed from m_xatrix_fixbot.h's
// single sequential anonymous enum: charging 0-30, landing 31-88, pushback
// 89-104, takeoff 105-120, ambient 121-139, paina 140-145, painb 146-153,
// pickup 154-180, freeze 181, shoot 182-187, weldstart 188-197, weldmiddle
// 198-204, weldend 205-211.
//
// ============================================================================
// SP_monster_fixbot's own wiring -- an honest reading of the shipped source
// ============================================================================
// `SP_monster_fixbot` (m_xatrix_fixbot.cpp:1362-1403) ONLY wires
// `stand`/`walk`/`run`/`attack`/`pain`/`die` plus `AI_ALTERNATE_FLY`. It does
// NOT set `monsterinfo.search`/`sight`/`idle`/`checkattack`/`blocked` to
// anything -- `fixbot_search`'s only caller is `change_to_roam` (itself only
// reached as a per-frame THINK inside `fixbot_move_stand`/`fixbot_move_stand2`,
// not any monsterinfo callback), and the entire roam-goal/weld/heal state
// machine below is driven purely by frame-table thinkfuncs
// (`fixbot_move_stand`'s last frame -> `change_to_roam` -> `roam_goal`/
// `landing_goal`/`takeoff_goal`/`fixbot_move_stand2`, `fixbot_move_forward`'s
// `use_scanner`, `fixbot_move_weld_start`/`_weld`/`_weld_end`'s `weldstate`).
// This is a faithful, complete transcription of that exact (slightly
// convoluted) wiring, not a simplification -- verified by re-reading the
// 1,404-line source end to end before writing this file.
//
// ============================================================================
// go_roam / fixbot_start_attack -- declared, never called (pre-existing
// dead code)
// ============================================================================
// Both are defined in the shipped source (m_xatrix_fixbot.cpp:775-778,
// 1295-1298) but have zero call sites anywhere in the same 1,404-line file
// (verified: grepped both identifiers a second time before writing this
// port). Ported verbatim, kept unexported, `void`-referenced to document the
// dead-code status -- matching m_supertank.ts's own `supertank_forward`
// precedent for the identical shape.

import { vec3, type Vec3 } from "../shared/math";
import { ATTN_IDLE, ATTN_NORM, ContentsT, EffectsT, KexMulticastT, KexTempEventT, MASK_PROJECTILE, MASK_WATER, RenderfxT, ServerCommandT, SolidT, SoundchanT, SplashColorT, SurfflagsT, SvflagsT, type KexTraceT, MonsterMuzzleflashIdT } from "../kexapi/game";
import {
  type EdictT,
  type MframeAifuncFn,
  type MframeThinkfuncFn,
  type MmoveEndfuncFn,
  type ModT,
  type PrethinkFn,
  type ThinkFn,
  MframeT,
  MmoveT,
  MonsterAiFlagsT,
  MovetypeT,
  EntFlagsT,
  DamageflagsT,
  ModIdT,
  ItemIdT,
  PlayerNoiseT,
  AI_SPAWNED_MASK,
  HOLD_FOREVER,
  DEFAULT_SHOTGUN_HSPREAD,
  DEFAULT_SHOTGUN_VSPREAD,
  SPAWNFLAG_FIXBOT_FIXIT,
  SPAWNFLAG_FIXBOT_TAKEOFF,
  SPAWNFLAG_FIXBOT_LANDING,
  SPAWNFLAG_FIXBOT_WORKING,
} from "./g_local";
import {
  RegisterThink,
  RegisterPain,
  RegisterDie,
  RegisterMonsterinfoStand,
  RegisterMonsterinfoWalk,
  RegisterMonsterinfoRun,
  RegisterMonsterinfoAttack,
  RegisterPrethink,
  RegisterMmove,
} from "./g_save_registry";
import { gi, g_edicts, level } from "./g_main_globals";
import { Gtime_add, Gtime_from_sec, Gtime_from_ms, Gtime_seconds, GTIME_ZERO } from "./gtime";
import { frandom, irandom, crandom } from "./q_std";
import { vec3_add, vec3_sub, vec3_muls, vec3_normalized, AngleVectors_destructured, vectoangles, vectoyaw } from "./q_vec3";
import { G_Spawn, G_FreeEdict, findradius } from "./g_utils";
import { ai_move, ai_stand, ai_run, ai_walk, ai_charge, visible } from "./g_ai";
import { M_SetAnimation, M_ProjectFlashSource, monster_fire_blaster, monster_dead_think, M_AllowSpawn, flymonster_start } from "./g_monster";
import { M_ChangeYaw, M_walkmove, M_MoveToGoal } from "./m_move";
import { T_Damage } from "./g_combat";
import { PlayerNoise } from "./p_weapon";
import { BecomeExplosion1 } from "./g_misc";
import { st, ClearSpawnTemp, ED_CallSpawn } from "./g_spawn";
import { abortHeal, cleanupHealTarget } from "./m_medic";
import { FindTarget, FoundTarget, infront } from "./g_ai";
import { monster_fire_dabeam, dabeam_update } from "./g_xatrix_monster";
import { monsterFlashOffset } from "./m_flash";
import { SpawnFlags_from, SpawnFlags_and, SpawnFlags_has, SpawnFlags_or, SpawnFlags_not, SpawnFlags_value, type SpawnFlags } from "./spawnflags";

// ---------------------------------------------------------------------------
// m_xatrix_fixbot.h frame constants (generated from the enum, see file
// header)
// ---------------------------------------------------------------------------

const FRAME_charging_01 = 0;
const FRAME_charging_31 = 30;
const FRAME_landing_01 = 31;
const FRAME_landing_58 = 88;
const FRAME_takeoff_01 = 105;
const FRAME_takeoff_16 = 120;
const FRAME_ambient_01 = 121;
const FRAME_ambient_19 = 139;
const FRAME_paina_01 = 140;
const FRAME_paina_06 = 145;
const FRAME_painb_01 = 146;
const FRAME_painb_08 = 153;
const FRAME_freeze_01 = 181;
const FRAME_shoot_01 = 182;
const FRAME_shoot_06 = 187;
const FRAME_weldstart_01 = 188;
const FRAME_weldstart_10 = 197;
const FRAME_weldmiddle_01 = 198;
const FRAME_weldmiddle_07 = 204;
const FRAME_weldend_01 = 205;
const FRAME_weldend_07 = 211;

const MODEL_SCALE = 1.0;

// ---------------------------------------------------------------------------
// local mframe_t / mmove_t helpers (see m_supertank.ts/m_xatrix_gekk.ts for
// rationale)
// ---------------------------------------------------------------------------

function frame(aifunc: MframeAifuncFn | null, dist = 0, thinkfunc: MframeThinkfuncFn | null = null): MframeT {
  return { aifunc, dist, thinkfunc, lerp_frame: -1 };
}
function move(firstframe: number, lastframe: number, frames: MframeT[], endfunc: MmoveEndfuncFn | null = null): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.frame = frames;
  m.endfunc = endfunc;
  return m;
}
function modFromId(id: ModIdT): ModT {
  return { id, friendly_fire: false, no_point_loss: false };
}
function traceEdict(ent: { s: { number: number } } | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

let sound_pain1 = 0;
let sound_die = 0;
let sound_weld1 = 0;
let sound_weld2 = 0;
let sound_weld3 = 0;

// ---------------------------------------------------------------------------
// forward-referenced move tables -- see m_soldier.ts's/m_xatrix_gekk.ts's own
// convention for this exact C++ forward-declaration shape
// ---------------------------------------------------------------------------

let fixbot_move_forward: MmoveT;
let fixbot_move_stand: MmoveT;
let fixbot_move_stand2: MmoveT;
let fixbot_move_roamgoal: MmoveT;
let fixbot_move_weld_start: MmoveT;
let fixbot_move_weld: MmoveT;
let fixbot_move_weld_end: MmoveT;
let fixbot_move_takeoff: MmoveT;
let fixbot_move_landing: MmoveT;
let fixbot_move_turn: MmoveT;

// ---------------------------------------------------------------------------
// [Paril-KEX] bot_goal_check (m_xatrix_fixbot.cpp:47-56)
// ---------------------------------------------------------------------------

const bot_goal_check: ThinkFn = RegisterThink("bot_goal_check", (self: EdictT): void => {
  if (self.owner === null || !self.owner.inuse || self.owner.goalentity !== self) {
    G_FreeEdict(self);
    return;
  }

  self.nextthink = Gtime_add(level.time, Gtime_from_ms(1));
});

// ---------------------------------------------------------------------------
// fixbot_FindDeadMonster / fixbot_set_fly_parameters / fixbot_search
// (m_xatrix_fixbot.cpp:60-147)
// ---------------------------------------------------------------------------

function fixbot_FindDeadMonster(self: EdictT): EdictT | null {
  let ent: EdictT | null = null;
  let best: EdictT | null = null;

  for (;;) {
    ent = findradius(ent, self.s.origin, 1024);
    if (ent === null) break;
    if (ent === self) continue;
    if ((ent.svflags & SvflagsT.SVF_MONSTER) === 0) continue;
    if ((ent.monsterinfo.aiflags & MonsterAiFlagsT.AI_GOOD_GUY) !== 0n) continue;
    // check to make sure we haven't bailed on this guy already
    if (ent.monsterinfo.badMedic1 === self || ent.monsterinfo.badMedic2 === self) continue;
    if (ent.monsterinfo.healer !== null) {
      // FIXME - this is correcting a bug that is somewhere else
      // if the healer is a monster, and it's in medic mode .. continue .. otherwise
      //   we will override the healer, if it passes all the other tests
      const h = ent.monsterinfo.healer;
      if (h.inuse && h.health > 0 && (h.svflags & SvflagsT.SVF_MONSTER) !== 0 && (h.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC) !== 0n) continue;
    }
    if (ent.health > 0) continue;
    if (ent.nextthink !== GTIME_ZERO && ent.think !== monster_dead_think) continue;
    if (!visible(self, ent)) continue;
    if (best === null) {
      best = ent;
      continue;
    }
    if (ent.max_health <= best.max_health) continue;
    best = ent;
  }

  return best;
}

function fixbot_set_fly_parameters(self: EdictT, heal: boolean, weld: boolean): void {
  self.monsterinfo.fly_position_time = GTIME_ZERO;
  self.monsterinfo.fly_acceleration = 5.0;
  self.monsterinfo.fly_speed = 110.0;
  self.monsterinfo.fly_buzzard = false;

  if (heal) {
    self.monsterinfo.fly_min_distance = 100.0;
    self.monsterinfo.fly_max_distance = 100.0;
    self.monsterinfo.fly_thrusters = true;
  } else if (weld) {
    self.monsterinfo.fly_min_distance = 24.0;
    self.monsterinfo.fly_max_distance = 24.0;
  } else {
    // timid bot
    self.monsterinfo.fly_min_distance = 300.0;
    self.monsterinfo.fly_max_distance = 500.0;
  }
}

function fixbot_search(self: EdictT): number {
  if (self.enemy === null) {
    const ent = fixbot_FindDeadMonster(self);
    if (ent !== null) {
      self.oldenemy = self.enemy;
      self.enemy = ent;
      self.enemy.monsterinfo.healer = self;
      self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_MEDIC;
      FoundTarget(self);
      fixbot_set_fly_parameters(self, true, false);
      return 1;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// landing_goal / takeoff_goal / change_to_roam / roam_goal / use_scanner
// (m_xatrix_fixbot.cpp:149-382)
// ---------------------------------------------------------------------------

function landing_goal(self: EdictT): void {
  const ent = G_Spawn();
  ent.classname = "bot_goal";
  ent.solid = SolidT.SOLID_BBOX;
  ent.owner = self;
  ent.think = bot_goal_check;
  gi.linkentity(ent);

  ent.mins = vec3(-32, -32, -24);
  ent.maxs = vec3(32, 32, 24);

  const { up } = AngleVectors_destructured(self.s.angles);
  const end = vec3_add(self.s.origin, vec3_muls(up, -8096));

  const tr = gi.trace(self.s.origin, ent.mins, ent.maxs, end, self, MASK_MONSTERSOLID);

  ent.s.origin = vec3(tr.endpos[0], tr.endpos[1], tr.endpos[2]);

  self.goalentity = self.enemy = ent;
  M_SetAnimation(self, fixbot_move_landing, true);
}

function takeoff_goal(self: EdictT): void {
  const ent = G_Spawn();
  ent.classname = "bot_goal";
  ent.solid = SolidT.SOLID_BBOX;
  ent.owner = self;
  ent.think = bot_goal_check;
  gi.linkentity(ent);

  ent.mins = vec3(-32, -32, -24);
  ent.maxs = vec3(32, 32, 24);

  const { up } = AngleVectors_destructured(self.s.angles);
  const end = vec3_add(self.s.origin, vec3_muls(up, 128));

  const tr = gi.trace(self.s.origin, ent.mins, ent.maxs, end, self, MASK_MONSTERSOLID);

  ent.s.origin = vec3(tr.endpos[0], tr.endpos[1], tr.endpos[2]);

  self.goalentity = self.enemy = ent;
  M_SetAnimation(self, fixbot_move_takeoff, true);
}

function change_to_roam(self: EdictT): void {
  if (fixbot_search(self) !== 0) return;

  M_SetAnimation(self, fixbot_move_roamgoal, true);

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_FIXBOT_LANDING)) {
    landing_goal(self);
    M_SetAnimation(self, fixbot_move_landing, true);
    self.spawnflags = SpawnFlags_and(self.spawnflags, SpawnFlags_not(SPAWNFLAG_FIXBOT_LANDING));
    self.spawnflags = SPAWNFLAG_FIXBOT_WORKING;
  }
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_FIXBOT_TAKEOFF)) {
    takeoff_goal(self);
    M_SetAnimation(self, fixbot_move_takeoff, true);
    self.spawnflags = SpawnFlags_and(self.spawnflags, SpawnFlags_not(SPAWNFLAG_FIXBOT_TAKEOFF));
    self.spawnflags = SPAWNFLAG_FIXBOT_WORKING;
  }
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_FIXBOT_FIXIT)) {
    M_SetAnimation(self, fixbot_move_roamgoal, true);
    self.spawnflags = SpawnFlags_and(self.spawnflags, SpawnFlags_not(SPAWNFLAG_FIXBOT_FIXIT));
    self.spawnflags = SPAWNFLAG_FIXBOT_WORKING;
  }
  if (SpawnFlags_value(self.spawnflags) === 0) {
    M_SetAnimation(self, fixbot_move_stand2, true);
  }
}

function roam_goal(self: EdictT): void {
  const ent = G_Spawn();
  ent.classname = "bot_goal";
  ent.solid = SolidT.SOLID_BBOX;
  ent.owner = self;
  ent.think = bot_goal_check;
  ent.nextthink = Gtime_add(level.time, Gtime_from_ms(1));
  gi.linkentity(ent);

  let oldlen = 0;
  let whichvec = vec3(0, 0, 0);

  for (let i = 0; i < 12; i++) {
    const dang = vec3(self.s.angles[0], self.s.angles[1], self.s.angles[2]);

    if (i < 6) dang[1] += 30 * i;
    else dang[1] -= 30 * (i - 6);

    const { forward } = AngleVectors_destructured(dang);
    const end = vec3_add(self.s.origin, vec3_muls(forward, 8192));

    const tr = gi.trace(self.s.origin, null, null, end, self, MASK_PROJECTILE);

    const vec = vec3_sub(self.s.origin, tr.endpos);
    const len = Math.hypot(vec[0], vec[1], vec[2]);

    if (len > oldlen) {
      oldlen = len;
      whichvec = vec3(tr.endpos[0], tr.endpos[1], tr.endpos[2]);
    }
  }

  ent.s.origin = whichvec;
  self.goalentity = self.enemy = ent;

  M_SetAnimation(self, fixbot_move_turn, true);
}

function use_scanner(self: EdictT): void {
  let ent: EdictT | null = null;
  const radius = 1024;

  for (;;) {
    ent = findradius(ent, self.s.origin, radius);
    if (ent === null) break;

    if (ent.health >= 100 && ent.classname === "object_repair") {
      if (visible(self, ent)) {
        // remove the old one
        if (self.goalentity !== null && self.goalentity.classname === "bot_goal") {
          self.goalentity.nextthink = Gtime_add(level.time, Gtime_from_ms(100));
          self.goalentity.think = G_FreeEdict;
        }

        self.goalentity = self.enemy = ent;

        const vec = vec3_sub(self.s.origin, self.goalentity.s.origin);
        const len = Math.hypot(vec[0], vec[1], vec[2]);

        fixbot_set_fly_parameters(self, false, true);

        if (len < 32) {
          M_SetAnimation(self, fixbot_move_weld_start, true);
          return;
        }
        return;
      }
    }
  }

  if (self.goalentity === null) {
    M_SetAnimation(self, fixbot_move_stand, true);
    return;
  }

  let vec = vec3_sub(self.s.origin, self.goalentity.s.origin);
  let len = Math.hypot(vec[0], vec[1], vec[2]);

  if (len < 32) {
    if (self.goalentity.classname === "object_repair") {
      M_SetAnimation(self, fixbot_move_weld_start, true);
    } else {
      self.goalentity.nextthink = Gtime_add(level.time, Gtime_from_ms(100));
      self.goalentity.think = G_FreeEdict;
      self.goalentity = self.enemy = null;
      M_SetAnimation(self, fixbot_move_stand, true);
    }
    return;
  }

  vec = vec3_sub(self.s.origin, self.s.old_origin);
  len = Math.hypot(vec[0], vec[1], vec[2]);

  // bot is stuck get new goalentity
  if (len === 0) {
    if (self.goalentity.classname === "object_repair") {
      M_SetAnimation(self, fixbot_move_stand, true);
    } else {
      self.goalentity.nextthink = Gtime_add(level.time, Gtime_from_ms(100));
      self.goalentity.think = G_FreeEdict;
      self.goalentity = self.enemy = null;
      M_SetAnimation(self, fixbot_move_stand, true);
    }
  }
}

// ---------------------------------------------------------------------------
// blastoff / fly_vertical / fly_vertical2 (m_xatrix_fixbot.cpp:384-580)
// ---------------------------------------------------------------------------

const MASK_MONSTERSOLID: ContentsT = ContentsT.CONTENTS_MONSTER | ContentsT.CONTENTS_PLAYER | ContentsT.CONTENTS_DEADMONSTER | ContentsT.CONTENTS_SOLID | ContentsT.CONTENTS_WINDOW;

function blastoff(self: EdictT, start: Vec3, aimdir: Vec3, damage: number, kick: number, te_impact: number, hspreadIn: number, vspreadIn: number): void {
  let hspread = hspreadIn + (self.s.frame - FRAME_takeoff_01);
  let vspread = vspreadIn + (self.s.frame - FRAME_takeoff_01);

  let tr = gi.trace(self.s.origin, null, null, start, self, MASK_PROJECTILE);
  if (tr.fraction < 1.0) return;

  let dir = vectoangles(aimdir);
  let { forward, right, up } = AngleVectors_destructured(dir);

  let r = crandom() * hspread;
  let u = crandom() * vspread;
  let end = vec3_add(start, vec3_muls(forward, 8192));
  end = vec3_add(end, vec3_muls(right, r));
  end = vec3_add(end, vec3_muls(up, u));

  let water = false;
  let water_start: Vec3 = vec3(0, 0, 0);
  let content_mask: ContentsT = MASK_PROJECTILE | MASK_WATER;

  if ((gi.pointcontents(start) & MASK_WATER) !== 0) {
    water = true;
    water_start = vec3(start[0], start[1], start[2]);
    content_mask &= ~MASK_WATER;
  }

  tr = gi.trace(start, null, null, end, self, content_mask);

  // see if we hit water
  if ((tr.contents & MASK_WATER) !== 0) {
    water = true;
    water_start = vec3(tr.endpos[0], tr.endpos[1], tr.endpos[2]);

    if (start[0] !== tr.endpos[0] || start[1] !== tr.endpos[1] || start[2] !== tr.endpos[2]) {
      let color = SplashColorT.SPLASH_UNKNOWN;

      if ((tr.contents & ContentsT.CONTENTS_WATER) !== 0) {
        color = tr.surface !== null && tr.surface.name === "brwater" ? SplashColorT.SPLASH_BROWN_WATER : SplashColorT.SPLASH_BLUE_WATER;
      } else if ((tr.contents & ContentsT.CONTENTS_SLIME) !== 0) color = SplashColorT.SPLASH_SLIME;
      else if ((tr.contents & ContentsT.CONTENTS_LAVA) !== 0) color = SplashColorT.SPLASH_LAVA;

      if (color !== SplashColorT.SPLASH_UNKNOWN) {
        gi.WriteByte(ServerCommandT.svc_temp_entity);
        gi.WriteByte(KexTempEventT.TE_SPLASH);
        gi.WriteByte(8);
        gi.WritePosition(tr.endpos);
        gi.WriteDir(tr.plane.normal);
        gi.WriteByte(color);
        gi.multicast(tr.endpos, KexMulticastT.MULTICAST_PVS, false);
      }

      // change bullet's course when it enters water
      dir = vectoangles(vec3_sub(end, start));
      ({ forward, right, up } = AngleVectors_destructured(dir));
      r = crandom() * hspread * 2;
      u = crandom() * vspread * 2;
      end = vec3_add(water_start, vec3_muls(forward, 8192));
      end = vec3_add(end, vec3_muls(right, r));
      end = vec3_add(end, vec3_muls(up, u));
    }

    // re-trace ignoring water this time
    tr = gi.trace(water_start, null, null, end, self, MASK_PROJECTILE);
  }

  // send gun puff / flash
  if (!(tr.surface !== null && (tr.surface.flags & SurfflagsT.SURF_SKY) !== 0)) {
    if (tr.fraction < 1.0) {
      const hitEnt = traceEdict(tr.ent);
      if (hitEnt.takedamage) {
        T_Damage(hitEnt, self, self, aimdir, tr.endpos, tr.plane.normal, damage, kick, DamageflagsT.DAMAGE_BULLET, modFromId(ModIdT.MOD_BLASTOFF));
      } else if (tr.surface === null || (tr.surface.flags & SurfflagsT.SURF_SKY) === 0) {
        gi.WriteByte(ServerCommandT.svc_temp_entity);
        gi.WriteByte(te_impact);
        gi.WritePosition(tr.endpos);
        gi.WriteDir(tr.plane.normal);
        gi.multicast(tr.endpos, KexMulticastT.MULTICAST_PVS, false);

        if (self.client !== null) PlayerNoise(self, tr.endpos, PlayerNoiseT.PNOISE_IMPACT);
      }
    }
  }

  // if went through water, determine where the end and make a bubble trail
  if (water) {
    dir = vec3_normalized(vec3_sub(tr.endpos, water_start));
    let pos = vec3_add(tr.endpos, vec3_muls(dir, -2));
    if ((gi.pointcontents(pos) & MASK_WATER) !== 0) tr = { ...tr, endpos: pos };
    else tr = gi.trace(pos, null, null, water_start, tr.ent !== null ? traceEdict(tr.ent) : null, MASK_WATER);

    pos = vec3_muls(vec3_add(water_start, tr.endpos), 0.5);

    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(KexTempEventT.TE_BUBBLETRAIL);
    gi.WritePosition(water_start);
    gi.WritePosition(tr.endpos);
    gi.multicast(pos, KexMulticastT.MULTICAST_PVS, false);
  }
}

function fly_vertical(self: EdictT): void {
  if (self.goalentity !== null) {
    const v = vec3_sub(self.goalentity.s.origin, self.s.origin);
    self.ideal_yaw = vectoyaw(v);
  }
  M_ChangeYaw(self);

  if (self.s.frame === FRAME_landing_58 || self.s.frame === FRAME_takeoff_16) {
    if (self.goalentity !== null) {
      self.goalentity.nextthink = Gtime_add(level.time, Gtime_from_ms(100));
      self.goalentity.think = G_FreeEdict;
    }
    M_SetAnimation(self, fixbot_move_stand, true);
    self.goalentity = self.enemy = null;
  }

  // kick up some particles
  const tempvec = vec3(self.s.angles[0] + 90, self.s.angles[1], self.s.angles[2]);
  const { forward } = AngleVectors_destructured(tempvec);
  const start = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]);

  for (let i = 0; i < 10; i++) blastoff(self, start, forward, 2, 1, KexTempEventT.TE_SHOTGUN, DEFAULT_SHOTGUN_HSPREAD, DEFAULT_SHOTGUN_VSPREAD);

  // needs sound
}

function fly_vertical2(self: EdictT): void {
  if (self.goalentity === null) return;
  const v = vec3_sub(self.goalentity.s.origin, self.s.origin);
  const len = Math.hypot(v[0], v[1], v[2]);
  self.ideal_yaw = vectoyaw(v);
  M_ChangeYaw(self);

  if (len < 32) {
    self.goalentity.nextthink = Gtime_add(level.time, Gtime_from_ms(100));
    self.goalentity.think = G_FreeEdict;
    M_SetAnimation(self, fixbot_move_stand, true);
    self.goalentity = self.enemy = null;
  }

  // needs sound
}

// ---------------------------------------------------------------------------
// landing / generic ambient stand / roamgoal / turn (m_xatrix_fixbot.cpp:
// 582-799)
// ---------------------------------------------------------------------------

const fixbot_frames_landing: MframeT[] = [frame(ai_move), ...Array.from({ length: 57 }, () => frame(ai_move, 0, fly_vertical2))];
fixbot_move_landing = RegisterMmove("fixbot_move_landing", move(FRAME_landing_01, FRAME_landing_58, fixbot_frames_landing, null));

const fixbot_frames_stand: MframeT[] = [...Array.from({ length: 18 }, () => frame(ai_move)), frame(ai_move, 0, change_to_roam)];
fixbot_move_stand = RegisterMmove("fixbot_move_stand", move(FRAME_ambient_01, FRAME_ambient_19, fixbot_frames_stand, null));

const fixbot_frames_stand2: MframeT[] = [...Array.from({ length: 18 }, () => frame(ai_stand)), frame(ai_stand, 0, change_to_roam)];
fixbot_move_stand2 = RegisterMmove("fixbot_move_stand2", move(FRAME_ambient_01, FRAME_ambient_19, fixbot_frames_stand2, null));

// m_xatrix_fixbot.cpp:701-740's `#if 0`-guarded fixbot_move_pickup frame
// table -- dropped per PORTING.md's "#if 0 blocks are dropped silently."

const fixbot_frames_roamgoal: MframeT[] = [frame(ai_move, 0, roam_goal)];
fixbot_move_roamgoal = RegisterMmove("fixbot_move_roamgoal", move(FRAME_freeze_01, FRAME_freeze_01, fixbot_frames_roamgoal, null));

function ai_facing(self: EdictT, _dist: number): void {
  if (self.goalentity === null) {
    fixbot_stand(self);
    return;
  }

  if (infront(self, self.goalentity)) {
    M_SetAnimation(self, fixbot_move_forward, true);
  } else {
    const v = vec3_sub(self.goalentity.s.origin, self.s.origin);
    self.ideal_yaw = vectoyaw(v);
    M_ChangeYaw(self);
  }
}

const fixbot_frames_turn: MframeT[] = [frame(ai_facing)];
fixbot_move_turn = RegisterMmove("fixbot_move_turn", move(FRAME_freeze_01, FRAME_freeze_01, fixbot_frames_turn, null));

function go_roam(self: EdictT): void {
  M_SetAnimation(self, fixbot_move_stand, true);
}
void go_roam; // m_xatrix_fixbot.cpp:775-778: dead code, see file header.

// ---------------------------------------------------------------------------
// takeoff / pain / forward / walk / run (m_xatrix_fixbot.cpp:780-903)
// ---------------------------------------------------------------------------

const fixbot_frames_takeoff: MframeT[] = Array.from({ length: 16 }, () => frame(ai_move, 0.01, fly_vertical));
fixbot_move_takeoff = RegisterMmove("fixbot_move_takeoff", move(FRAME_takeoff_01, FRAME_takeoff_16, fixbot_frames_takeoff, null));

const fixbot_frames_paina: MframeT[] = Array.from({ length: 6 }, () => frame(ai_move));
const fixbot_move_paina = RegisterMmove("fixbot_move_paina", move(FRAME_paina_01, FRAME_paina_06, fixbot_frames_paina, (self: EdictT): void => fixbot_run(self)));

const fixbot_frames_painb: MframeT[] = Array.from({ length: 8 }, () => frame(ai_move));
const fixbot_move_painb = RegisterMmove("fixbot_move_painb", move(FRAME_painb_01, FRAME_painb_08, fixbot_frames_painb, (self: EdictT): void => fixbot_run(self)));

const fixbot_frames_pain3: MframeT[] = [frame(ai_move, -1)];
const fixbot_move_pain3 = RegisterMmove("fixbot_move_pain3", move(FRAME_freeze_01, FRAME_freeze_01, fixbot_frames_pain3, (self: EdictT): void => fixbot_run(self)));

// m_xatrix_fixbot.cpp:838-848's `#if 0`-guarded fixbot_move_land frame table
// -- dropped per PORTING.md's "#if 0 blocks are dropped silently."

function ai_movetogoal(self: EdictT, dist: number): void {
  M_MoveToGoal(self, dist);
}

const fixbot_frames_forward: MframeT[] = [frame(ai_movetogoal, 5, use_scanner)];
fixbot_move_forward = RegisterMmove("fixbot_move_forward", move(FRAME_freeze_01, FRAME_freeze_01, fixbot_frames_forward, null));

const fixbot_frames_walk: MframeT[] = [frame(ai_walk, 5)];
const fixbot_move_walk = RegisterMmove("fixbot_move_walk", move(FRAME_freeze_01, FRAME_freeze_01, fixbot_frames_walk, null));

const fixbot_frames_run: MframeT[] = [frame(ai_run, 10)];
const fixbot_move_run = RegisterMmove("fixbot_move_run", move(FRAME_freeze_01, FRAME_freeze_01, fixbot_frames_run, null));

// m_xatrix_fixbot.cpp:880-897's `#if 0`-guarded fixbot_move_death1/
// fixbot_move_backward frame tables -- dropped per PORTING.md's "#if 0
// blocks are dropped silently."

const fixbot_frames_start_attack: MframeT[] = [frame(ai_charge)];
const fixbot_move_start_attack = RegisterMmove("fixbot_move_start_attack", move(FRAME_freeze_01, FRAME_freeze_01, fixbot_frames_start_attack, (self: EdictT): void => fixbot_attack(self)));

// m_xatrix_fixbot.cpp:905-920's `#if 0`-guarded fixbot_move_attack1 frame
// table -- dropped per PORTING.md's "#if 0 blocks are dropped silently."

// ---------------------------------------------------------------------------
// fixbot_fire_laser / weldstate / fixbot_fire_welder / fixbot_fire_blaster
// (m_xatrix_fixbot.cpp:922-1262)
// ---------------------------------------------------------------------------

/** `PRETHINK(fixbot_laser_update)` (m_xatrix_fixbot.cpp:924-946). */
const fixbot_laser_update: PrethinkFn = RegisterPrethink("fixbot_laser_update", (laser: EdictT): void => {
  const self = laser.owner;
  if (self === null) return;

  const { forward: dirIn } = AngleVectors_destructured(self.s.angles);
  let dir = dirIn;
  const start = vec3_add(self.s.origin, vec3_muls(dir, 16));

  if (self.enemy !== null && self.health > 0) {
    let point = vec3_muls(vec3_add(self.enemy.absmin, self.enemy.absmax), 0.5);
    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC) !== 0n) point[0] += Math.sin(Gtime_seconds(level.time)) * 8;
    dir = vec3_normalized(vec3_sub(point, self.s.origin));
  }

  laser.s.origin = start;
  laser.movedir = dir;
  gi.linkentity(laser);
  dabeam_update(laser, true);
});

function fixbot_fire_laser(self: EdictT): void {
  // critter dun got blown up while bein' fixed
  if (self.enemy === null || !self.enemy.inuse || self.enemy.health <= self.enemy.gib_health) {
    M_SetAnimation(self, fixbot_move_stand, true);
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MEDIC;
    return;
  }

  monster_fire_dabeam(self, -1, false, fixbot_laser_update);

  if (self.enemy.health > self.enemy.mass / 10) {
    self.enemy.spawnflags = SpawnFlags_from(0);
    self.enemy.monsterinfo.aiflags &= MonsterAiFlagsT.AI_STINKY | AI_SPAWNED_MASK;
    self.enemy.target = null;
    self.enemy.targetname = null;
    self.enemy.combattarget = null;
    self.enemy.deathtarget = null;
    self.enemy.healthtarget = null;
    self.enemy.itemtarget = null;
    self.enemy.monsterinfo.healer = self;

    const maxs = vec3(self.enemy.maxs[0], self.enemy.maxs[1], self.enemy.maxs[2] + 48); // compensate for change when they die

    const tr = gi.trace(self.enemy.s.origin, self.enemy.mins, maxs, self.enemy.s.origin, self.enemy, MASK_MONSTERSOLID);
    if (tr.startsolid || tr.allsolid) {
      abortHeal(self, false, true, false);
      return;
    } else if (tr.ent !== null && traceEdict(tr.ent) !== g_edicts[0]) {
      abortHeal(self, false, true, false);
      return;
    } else {
      self.enemy.monsterinfo.aiflags |= MonsterAiFlagsT.AI_IGNORE_SHOTS | MonsterAiFlagsT.AI_DO_NOT_COUNT;

      // backup & restore health stuff, because of multipliers
      const old_max_health = self.enemy.max_health;
      const old_power_armor_type = self.enemy.monsterinfo.initial_power_armor_type;
      const old_power_armor_power = self.enemy.monsterinfo.max_power_armor_power;
      const old_base_health = self.enemy.monsterinfo.base_health;
      const old_health_scaling = self.enemy.monsterinfo.health_scaling;
      const reinforcements = self.enemy.monsterinfo.reinforcements;
      const monster_slots = self.enemy.monsterinfo.monster_slots;
      const monster_used = self.enemy.monsterinfo.monster_used;
      const old_gib_health = self.enemy.gib_health;
      const deadEnemy = self.enemy;

      ClearSpawnTemp();
      st.keys_specified.add("reinforcements");
      st.reinforcements = "";

      ED_CallSpawn(deadEnemy);

      deadEnemy.monsterinfo.reinforcements = reinforcements;
      deadEnemy.monsterinfo.monster_slots = monster_slots;
      deadEnemy.monsterinfo.monster_used = monster_used;

      deadEnemy.gib_health = Math.trunc(old_gib_health / 2);
      deadEnemy.health = deadEnemy.max_health = old_max_health;
      deadEnemy.monsterinfo.power_armor_power = deadEnemy.monsterinfo.max_power_armor_power = old_power_armor_power;
      deadEnemy.monsterinfo.power_armor_type = deadEnemy.monsterinfo.initial_power_armor_type = old_power_armor_type;
      deadEnemy.monsterinfo.base_health = old_base_health;
      deadEnemy.monsterinfo.health_scaling = old_health_scaling;

      deadEnemy.monsterinfo.setskin?.(deadEnemy);

      if (deadEnemy.think !== null) {
        deadEnemy.nextthink = level.time;
        deadEnemy.think(deadEnemy);
      }
      deadEnemy.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_RESURRECTING;
      deadEnemy.monsterinfo.aiflags |= MonsterAiFlagsT.AI_IGNORE_SHOTS | MonsterAiFlagsT.AI_DO_NOT_COUNT;
      // turn off flies
      deadEnemy.s.effects &= ~EffectsT.EF_FLIES;
      deadEnemy.monsterinfo.healer = null;

      // clean up target, if we have one and it's legit
      if (deadEnemy.inuse) {
        cleanupHealTarget(deadEnemy);

        if (self.oldenemy !== null && self.oldenemy.inuse && self.oldenemy.health > 0) {
          deadEnemy.enemy = self.oldenemy;
          FoundTarget(deadEnemy);
        } else {
          deadEnemy.enemy = null;
          if (!FindTarget(deadEnemy)) {
            // no valid enemy, so stop acting
            deadEnemy.monsterinfo.pausetime = HOLD_FOREVER;
            deadEnemy.monsterinfo.stand?.(deadEnemy);
          }
          self.enemy = null;
          self.oldenemy = null;
          if (!FindTarget(self)) {
            // no valid enemy, so stop acting
            self.monsterinfo.pausetime = HOLD_FOREVER;
            self.monsterinfo.stand?.(self);
            return;
          }
        }
      }
    }

    M_SetAnimation(self, fixbot_move_stand, true);
  } else {
    self.enemy.monsterinfo.aiflags |= MonsterAiFlagsT.AI_RESURRECTING;
  }
}

const fixbot_frames_laserattack: MframeT[] = Array.from({ length: 6 }, () => frame(ai_charge, 0, fixbot_fire_laser));
const fixbot_move_laserattack = RegisterMmove("fixbot_move_laserattack", move(FRAME_shoot_01, FRAME_shoot_06, fixbot_frames_laserattack, null));

const fixbot_frames_attack2: MframeT[] = [
  ...Array.from({ length: 10 }, () => frame(ai_charge)),
  ...Array.from({ length: 10 }, () => frame(ai_charge, -10)),
  frame(ai_charge, 0, fixbot_fire_blaster),
  ...Array.from({ length: 9 }, () => frame(ai_charge)),
  frame(ai_charge),
];
const fixbot_move_attack2 = RegisterMmove("fixbot_move_attack2", move(FRAME_charging_01, FRAME_charging_31, fixbot_frames_attack2, (self: EdictT): void => fixbot_run(self)));

function weldstate(self: EdictT): void {
  if (self.s.frame === FRAME_weldstart_10) {
    M_SetAnimation(self, fixbot_move_weld, true);
  } else if (self.goalentity !== null && self.s.frame === FRAME_weldmiddle_07) {
    if (self.goalentity.health <= 0) {
      if (self.enemy !== null) self.enemy.owner = null;
      M_SetAnimation(self, fixbot_move_weld_end, true);
    } else {
      self.goalentity.health -= 10;
    }
  } else {
    self.goalentity = self.enemy = null;
    M_SetAnimation(self, fixbot_move_stand, true);
  }
}

function ai_move2(self: EdictT, dist: number): void {
  if (self.goalentity === null) {
    fixbot_stand(self);
    return;
  }

  M_walkmove(self, self.s.angles[1], dist);

  const v = vec3_sub(self.goalentity.s.origin, self.s.origin);
  self.ideal_yaw = vectoyaw(v);
  M_ChangeYaw(self);
}

const fixbot_frames_weld_start: MframeT[] = [...Array.from({ length: 9 }, () => frame(ai_move2, 0)), frame(ai_move2, 0, weldstate)];
fixbot_move_weld_start = RegisterMmove("fixbot_move_weld_start", move(FRAME_weldstart_01, FRAME_weldstart_10, fixbot_frames_weld_start, null));

const fixbot_frames_weld: MframeT[] = [...Array.from({ length: 6 }, () => frame(ai_move2, 0, fixbot_fire_welder)), frame(ai_move2, 0, weldstate)];
fixbot_move_weld = RegisterMmove("fixbot_move_weld", move(FRAME_weldmiddle_01, FRAME_weldmiddle_07, fixbot_frames_weld, null));

const fixbot_frames_weld_end: MframeT[] = [...Array.from({ length: 6 }, () => frame(ai_move2, -2)), frame(ai_move2, -2, weldstate)];
fixbot_move_weld_end = RegisterMmove("fixbot_move_weld_end", move(FRAME_weldend_01, FRAME_weldend_07, fixbot_frames_weld_end, null));

function fixbot_fire_welder(self: EdictT): void {
  if (self.enemy === null) return;

  const vec = vec3(24.0, -0.8, -10.0);

  const { forward, right } = AngleVectors_destructured(self.s.angles);
  const start = M_ProjectFlashSource(self, vec, forward, right);

  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_WELDING_SPARKS);
  gi.WriteByte(10);
  gi.WritePosition(start);
  gi.WriteDir(vec3(0, 0, 0));
  gi.WriteByte(irandom(0xe0, 0xe8));
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PVS, false);

  if (frandom() > 0.8) {
    const r = frandom();
    if (r < 0.33) gi.sound(self, SoundchanT.CHAN_VOICE, sound_weld1, 1, ATTN_IDLE, 0);
    else if (r < 0.66) gi.sound(self, SoundchanT.CHAN_VOICE, sound_weld2, 1, ATTN_IDLE, 0);
    else gi.sound(self, SoundchanT.CHAN_VOICE, sound_weld3, 1, ATTN_IDLE, 0);
  }
}

function fixbot_fire_blaster(self: EdictT): void {
  if (self.enemy === null) return;

  if (!visible(self, self.enemy)) {
    M_SetAnimation(self, fixbot_move_run, true);
  }

  const { forward, right } = AngleVectors_destructured(self.s.angles);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_HOVER_BLASTER_1], forward, right);

  const end = vec3(self.enemy.s.origin[0], self.enemy.s.origin[1], self.enemy.s.origin[2] + self.enemy.viewheight);
  const dir = vec3_normalized(vec3_sub(end, start));

  monster_fire_blaster(self, start, dir, 15, 1000, MonsterMuzzleflashIdT.MZ2_HOVER_BLASTER_1, EffectsT.EF_BLASTER);
}

// ---------------------------------------------------------------------------
// stand / run / walk / attack / pain / die (m_xatrix_fixbot.cpp:1264-1358)
// ---------------------------------------------------------------------------

function fixbot_stand(self: EdictT): void {
  M_SetAnimation(self, fixbot_move_stand, true);
}
RegisterMonsterinfoStand("fixbot_stand", fixbot_stand);

function fixbot_run(self: EdictT): void {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) M_SetAnimation(self, fixbot_move_stand, true);
  else M_SetAnimation(self, fixbot_move_run, true);
}
RegisterMonsterinfoRun("fixbot_run", fixbot_run);

const fixbot_walk = RegisterMonsterinfoWalk("fixbot_walk", (self: EdictT): void => {
  if (self.goalentity !== null && self.goalentity.classname === "object_repair") {
    const vec = vec3_sub(self.s.origin, self.goalentity.s.origin);
    const len = Math.hypot(vec[0], vec[1], vec[2]);
    if (len < 32) {
      M_SetAnimation(self, fixbot_move_weld_start, true);
      return;
    }
  }
  M_SetAnimation(self, fixbot_move_walk, true);
});

function fixbot_start_attack(self: EdictT): void {
  M_SetAnimation(self, fixbot_move_start_attack, true);
}
void fixbot_start_attack; // m_xatrix_fixbot.cpp:1295-1298: dead code, see file header.

function fixbot_attack(self: EdictT): void {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC) !== 0n) {
    if (self.enemy === null || !visible(self, self.enemy)) return;
    const vec = vec3_sub(self.s.origin, self.enemy.s.origin);
    const len = Math.hypot(vec[0], vec[1], vec[2]);
    if (len > 128) return;
    M_SetAnimation(self, fixbot_move_laserattack, true);
  } else {
    fixbot_set_fly_parameters(self, false, false);
    M_SetAnimation(self, fixbot_move_attack2, true);
  }
}
RegisterMonsterinfoAttack("fixbot_attack", fixbot_attack);

const fixbot_pain = RegisterPain("fixbot_pain", (self: EdictT, _other: EdictT, _kick: number, damage: number, _mod: ModT): void => {
  if (level.time < self.pain_debounce_time) return;

  fixbot_set_fly_parameters(self, false, false);
  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));
  gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);

  if (damage <= 10) M_SetAnimation(self, fixbot_move_pain3, true);
  else if (damage <= 25) M_SetAnimation(self, fixbot_move_painb, true);
  else M_SetAnimation(self, fixbot_move_paina, true);

  abortHeal(self, false, false, false);
});

function fixbot_dead(self: EdictT): void {
  self.mins = vec3(-16, -16, -24);
  self.maxs = vec3(16, 16, -8);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SvflagsT.SVF_DEADMONSTER;
  self.nextthink = GTIME_ZERO;
  gi.linkentity(self);
}
void fixbot_dead; // m_xatrix_fixbot.cpp:1342-1350: declared and defined, but ALSO never referenced from anywhere else in this file (fixbot_die calls BecomeExplosion1 directly, not fixbot_dead) -- pre-existing dead code, preserved verbatim.

const fixbot_die = RegisterDie("fixbot_die", (self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3, _mod: ModT): void => {
  gi.sound(self, SoundchanT.CHAN_VOICE, sound_die, 1, ATTN_NORM, 0);
  BecomeExplosion1(self);
  // shards
});

/**
 * QUAKED monster_fixbot (1 .5 0) (-32 -32 -24) (32 32 24) Ambush Trigger_Spawn
 * Fixit Takeoff Landing
 * `void SP_monster_fixbot(edict_t *self)` (m_xatrix_fixbot.cpp:1362-1403).
 */
export function SP_monster_fixbot(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  sound_pain1 = gi.soundindex("flyer/flypain1.wav");
  sound_die = gi.soundindex("flyer/flydeth1.wav");

  sound_weld1 = gi.soundindex("misc/welder1.wav");
  sound_weld2 = gi.soundindex("misc/welder2.wav");
  sound_weld3 = gi.soundindex("misc/welder3.wav");

  self.s.modelindex = gi.modelindex("models/monsters/fixbot/tris.md2");

  self.mins = vec3(-32, -32, -24);
  self.maxs = vec3(32, 32, 24);

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;

  self.health = Math.trunc(150 * st.health_multiplier);
  self.mass = 150;

  self.pain = fixbot_pain;
  self.die = fixbot_die;

  self.monsterinfo.stand = fixbot_stand;
  self.monsterinfo.walk = fixbot_walk;
  self.monsterinfo.run = fixbot_run;
  self.monsterinfo.attack = fixbot_attack;

  gi.linkentity(self);

  M_SetAnimation(self, fixbot_move_stand, true);
  self.monsterinfo.scale = MODEL_SCALE;
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_ALTERNATE_FLY;
  fixbot_set_fly_parameters(self, false, false);

  flymonster_start(self);
}
