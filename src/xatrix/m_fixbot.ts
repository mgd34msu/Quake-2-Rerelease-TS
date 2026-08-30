/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from xatrix/m_fixbot.c (GNU GPL v2 or later).

Pack-only monster (no baseq2 counterpart) -- fresh port, following
../game and ../ctf's conventions.

Deviations from the C, documented at each site below:
  - `float crand(void)` (defined at file scope, C lines 50-53) is never
    called anywhere in m_fixbot.c -- dead code in the original. Ported
    verbatim as an unused local function rather than dropped.
  - `go_roam` (C lines 746-749) sets currentmove but is never called from
    anywhere in the file -- also dead code, ported verbatim.
  - `fixbot_move_land`/`fixbot_frames_land` (C lines 820-824) and
    `fixbot_start_attack`/`fixbot_move_start_attack`/
    `fixbot_frames_start_attack` (C lines 882-886, 1219-1222) are defined
    but never wired to a monsterinfo callback or reached from any move
    table's endfunc either -- dead code in the original, preserved.
  - `use_scanner`'s C locals `oldlen` (init'd, never read) and `tempent`
    (init'd, never read) are omitted; the original never uses them either,
    so this has no behavioral effect.
  - Several `self->goalentity`/`self->enemy` dereferences in `use_scanner`,
    `weldstate`, `ai_move2`, `fly_vertical`, `fly_vertical2`, `ai_facing`,
    and `fixbot_fire_laser`/`check_telefrag` assume a non-null value with no
    C-side null check (by construction, these run only after
    change_to_roam/landing_goal/takeoff_goal/roam_goal/fixbot_search have
    set goalentity/enemy). TypeScript's strict null checking requires an
    explicit guard at each such dereference point; each is marked
    "C assumes X is set here" and returns early rather than deref'ing null,
    matching PORTING.md's rule that narrowing happens at the actual
    dereference point, not eagerly at function entry.
*/
/*
	fixbot.c
*/

import {
  AngleVectors,
  crandom,
  random,
  type Vec3,
  vec3,
  vec3_origin,
  VectorAdd,
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
  ATTN_IDLE,
  ATTN_NORM,
  ATTN_STATIC,
  CHAN_AUTO,
  CHAN_VOICE,
  CONTENTS_LAVA,
  CONTENTS_SLIME,
  CONTENTS_WATER,
  EF_BLASTER,
  MASK_MONSTERSOLID,
  MASK_SHOT,
  MASK_WATER,
  MulticastT,
  MZ2_HOVER_BLASTER_1,
  PITCH,
  SPLASH_BLUE_WATER,
  SPLASH_BROWN_WATER,
  SPLASH_LAVA,
  SPLASH_SLIME,
  SPLASH_UNKNOWN,
  SURF_SKY,
  TempEventT,
  YAW,
} from "../shared/q_shared";
import {
  AI_GOOD_GUY,
  AI_MEDIC,
  AI_RESURRECTING,
  AI_STAND_GROUND,
  DAMAGE_BULLET,
  type EdictT,
  g_edicts,
  gameCvars,
  gi,
  level,
  MframeT,
  MmoveT,
  MOD_BLASTOFF,
  MovetypeT,
  PNOISE_IMPACT,
  svc_temp_entity,
} from "./g_local";
import { type Edict, SolidT, SVF_DEADMONSTER, SVF_MONSTER } from "./game";
import { ai_charge, ai_move, ai_stand, ai_run, ai_walk, FoundTarget, infront, visible } from "./g_ai";
import { T_Damage } from "./g_combat";
import { BecomeExplosion1 } from "./g_misc";
import { flymonster_start, monster_dabeam, monster_fire_blaster } from "./g_monster";
import { PlayerNoise } from "./p_weapon";
import { ED_CallSpawn } from "./g_spawn";
import { findradius, G_FreeEdict, G_ProjectSource, G_Spawn, vectoangles, vectoyaw } from "./g_utils";
import { M_ChangeYaw, M_MoveToGoal, M_walkmove } from "./m_move";
import { monsterFlashOffset } from "./m_flash";
import * as FRAME from "./m_fixbot_frames";

const MZ2_fixbot_BLASTER_1 = MZ2_HOVER_BLASTER_1;

function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

// See g_weapon.ts/g_monster.ts's own traceEdict: sv_world.c defaults an
// unset trace.ent to the world edict, never NULL.
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

function mm(firstframe: number, lastframe: number, frame: MframeT[], endfunc: ((self: EdictT) => void) | null = null): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.frame = frame;
  m.endfunc = endfunc;
  return m;
}

let sound_pain1 = 0;
let sound_die = 0;
let sound_weld1 = 0;
let sound_weld2 = 0;
let sound_weld3 = 0;

// Dead code: never called anywhere in m_fixbot.c. Ported verbatim.
function crand(): number {
  return (Math.floor(Math.random() * 32768) & 32767) * (2.0 / 32767) - 1;
}

function fixbot_FindDeadMonster(self: EdictT): EdictT | null {
  let ent: EdictT | null = null;
  let best: EdictT | null = null;

  while ((ent = findradius(ent, self.s.origin, 1024)) !== null) {
    if (ent === self) continue;
    if (!(ent.svflags & SVF_MONSTER)) continue;
    if (ent.monsterinfo.aiflags & AI_GOOD_GUY) continue;
    if (ent.owner) continue;
    if (ent.health > 0) continue;
    if (ent.nextthink) continue;
    if (!visible(self, ent)) continue;
    if (!best) {
      best = ent;
      continue;
    }
    if (ent.max_health <= best.max_health) continue;
    best = ent;
  }

  return best;
}

function fixbot_search(self: EdictT): boolean {
  if (!self.goalentity) {
    const ent = fixbot_FindDeadMonster(self);
    if (ent) {
      self.oldenemy = self.enemy;
      self.enemy = ent;
      ent.owner = self;
      self.monsterinfo.aiflags |= AI_MEDIC;
      FoundTarget(self);
      return true;
    }
  }
  return false;
}

function landing_goal(self: EdictT): void {
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  const end = vec3();

  const ent = G_Spawn();
  ent.classname = "bot_goal";
  ent.solid = SolidT.SOLID_BBOX;
  ent.owner = self;
  gi.linkentity(ent);

  VectorSet(ent.mins, -32, -32, -24);
  VectorSet(ent.maxs, 32, 32, 24);

  AngleVectors(self.s.angles, forward, right, up);
  VectorMA(self.s.origin, 32, forward, end);
  VectorMA(self.s.origin, -8096, up, end);

  const tr = gi.trace(self.s.origin, ent.mins, ent.maxs, end, self, MASK_MONSTERSOLID);

  VectorCopy(tr.endpos, ent.s.origin);

  self.goalentity = ent;
  self.enemy = ent;
  self.monsterinfo.currentmove = fixbot_move_landing;
}

function takeoff_goal(self: EdictT): void {
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  const end = vec3();

  const ent = G_Spawn();
  ent.classname = "bot_goal";
  ent.solid = SolidT.SOLID_BBOX;
  ent.owner = self;
  gi.linkentity(ent);

  VectorSet(ent.mins, -32, -32, -24);
  VectorSet(ent.maxs, 32, 32, 24);

  AngleVectors(self.s.angles, forward, right, up);
  VectorMA(self.s.origin, 32, forward, end);
  VectorMA(self.s.origin, 128, up, end);

  const tr = gi.trace(self.s.origin, ent.mins, ent.maxs, end, self, MASK_MONSTERSOLID);

  VectorCopy(tr.endpos, ent.s.origin);

  self.goalentity = ent;
  self.enemy = ent;
  self.monsterinfo.currentmove = fixbot_move_takeoff;
}

function change_to_roam(self: EdictT): void {
  if (fixbot_search(self)) return;

  self.monsterinfo.currentmove = fixbot_move_roamgoal;

  if (self.spawnflags & 16) {
    landing_goal(self);
    self.monsterinfo.currentmove = fixbot_move_landing;
    self.spawnflags &= ~16;
    self.spawnflags = 32;
  }
  if (self.spawnflags & 8) {
    takeoff_goal(self);
    self.monsterinfo.currentmove = fixbot_move_takeoff;
    self.spawnflags &= ~8;
    self.spawnflags = 32;
  }
  if (self.spawnflags & 4) {
    self.monsterinfo.currentmove = fixbot_move_roamgoal;
    self.spawnflags &= ~4;
    self.spawnflags = 32;
  }
  if (!self.spawnflags) {
    self.monsterinfo.currentmove = fixbot_move_stand2;
  }
}

function roam_goal(self: EdictT): void {
  const dang = vec3();
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  const end = vec3();
  const vec = vec3();
  const whichvec = vec3();

  const ent = G_Spawn();
  ent.classname = "bot_goal";
  ent.solid = SolidT.SOLID_BBOX;
  ent.owner = self;
  gi.linkentity(ent);

  let oldlen = 0;

  for (let i = 0; i < 12; i++) {
    VectorCopy(self.s.angles, dang);

    if (i < 6) dang[YAW] += 30 * i;
    else dang[YAW] -= 30 * (i - 6);

    AngleVectors(dang, forward, right, up);
    VectorMA(self.s.origin, 8192, forward, end);

    const tr = gi.trace(self.s.origin, null, null, end, self, MASK_SHOT);

    VectorSubtract(self.s.origin, tr.endpos, vec);
    const len = VectorNormalize(vec);

    if (len > oldlen) {
      oldlen = len;
      VectorCopy(tr.endpos, whichvec);
    }
  }

  VectorCopy(whichvec, ent.s.origin);
  self.goalentity = ent;
  self.enemy = ent;

  self.monsterinfo.currentmove = fixbot_move_turn;
}

function use_scanner(self: EdictT): void {
  const radius = 1024;
  const vec = vec3();

  let ent: EdictT | null = null;
  while ((ent = findradius(ent, self.s.origin, radius)) !== null) {
    if (ent.health >= 100 && ent.classname === "object_repair" && visible(self, ent)) {
      // remove the old one
      if (self.goalentity !== null && self.goalentity.classname === "bot_goal") {
        self.goalentity.nextthink = level.time + 0.1;
        self.goalentity.think = G_FreeEdict;
      }

      self.goalentity = ent;
      self.enemy = ent;

      VectorSubtract(self.s.origin, self.goalentity.s.origin, vec);
      const len = VectorNormalize(vec);

      if (len < 32) {
        self.monsterinfo.currentmove = fixbot_move_weld_start;
        return;
      }
      return;
    }
  }

  if (self.goalentity === null) return; // C assumes self->goalentity is set here

  VectorSubtract(self.s.origin, self.goalentity.s.origin, vec);
  let len = VectorLength(vec);

  if (len < 32) {
    if (self.goalentity.classname === "object_repair") {
      self.monsterinfo.currentmove = fixbot_move_weld_start;
    } else {
      self.goalentity.nextthink = level.time + 0.1;
      self.goalentity.think = G_FreeEdict;
      self.goalentity = null;
      self.enemy = null;
      self.monsterinfo.currentmove = fixbot_move_stand;
    }
    return;
  }

  VectorSubtract(self.s.origin, self.s.old_origin, vec);
  len = VectorLength(vec);

  // bot is stuck get new goalentity
  if (len === 0) {
    if (self.goalentity.classname === "object_repair") {
      self.monsterinfo.currentmove = fixbot_move_stand;
    } else {
      self.goalentity.nextthink = level.time + 0.1;
      self.goalentity.think = G_FreeEdict;
      self.goalentity = null;
      self.enemy = null;
      self.monsterinfo.currentmove = fixbot_move_stand;
    }
  }
}

const DEFAULT_SHOTGUN_HSPREAD = 1000;
const DEFAULT_SHOTGUN_VSPREAD = 500;

/*
	when the bot has found a landing pad
	it will proceed to its goalentity
	just above the landing pad and
	decend translated along the z the current
	frames are at 10fps
*/
function blastoff(
  self: EdictT,
  start: Vec3,
  aimdir: Vec3,
  damage: number,
  kick: number,
  te_impact: number,
  hspreadIn: number,
  vspreadIn: number,
): void {
  const water_start = vec3();
  let water = false;
  let content_mask = MASK_SHOT | MASK_WATER;

  const hspread = hspreadIn + (self.s.frame - FRAME.FRAME_takeoff_01);
  const vspread = vspreadIn + (self.s.frame - FRAME.FRAME_takeoff_01);

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
  if (!(tr.surface !== null && tr.surface.flags & SURF_SKY)) {
    if (tr.fraction < 1.0) {
      const hitEnt = traceEdict(tr.ent);
      if (hitEnt.takedamage) {
        T_Damage(hitEnt, self, self, aimdir, tr.endpos, tr.plane.normal, damage, kick, DAMAGE_BULLET, MOD_BLASTOFF);
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
      tr = gi.trace(pos, null, null, water_start, traceEdict(tr.ent), MASK_WATER);
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

function fly_vertical(self: EdictT): void {
  if (self.goalentity === null) return; // C assumes self->goalentity is set here

  const v = vec3();
  VectorSubtract(self.goalentity.s.origin, self.s.origin, v);
  self.ideal_yaw = vectoyaw(v);
  M_ChangeYaw(self);

  if (self.s.frame === FRAME.FRAME_landing_58 || self.s.frame === FRAME.FRAME_takeoff_16) {
    self.goalentity.nextthink = level.time + 0.1;
    self.goalentity.think = G_FreeEdict;
    self.monsterinfo.currentmove = fixbot_move_stand;
    self.goalentity = null;
    self.enemy = null;
  }

  // kick up some particles
  const tempvec = vec3();
  VectorCopy(self.s.angles, tempvec);
  tempvec[PITCH] += 90;

  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(tempvec, forward, right, up);
  const start = vec3();
  VectorCopy(self.s.origin, start);

  for (let i = 0; i < 10; i++) {
    blastoff(self, start, forward, 2, 1, TempEventT.TE_SHOTGUN, DEFAULT_SHOTGUN_HSPREAD, DEFAULT_SHOTGUN_VSPREAD);
  }

  // needs sound
}

function fly_vertical2(self: EdictT): void {
  if (self.goalentity === null) return; // C assumes self->goalentity is set here

  const v = vec3();
  VectorSubtract(self.goalentity.s.origin, self.s.origin, v);
  const len = VectorLength(v);
  self.ideal_yaw = vectoyaw(v);
  M_ChangeYaw(self);

  if (len < 32) {
    self.goalentity.nextthink = level.time + 0.1;
    self.goalentity.think = G_FreeEdict;
    self.monsterinfo.currentmove = fixbot_move_stand;
    self.goalentity = null;
    self.enemy = null;
  }

  // needs sound
}

const fixbot_frames_landing: MframeT[] = [
  mf(ai_move, 0, null),
  ...Array.from({ length: 57 }, () => mf(ai_move, 0, fly_vertical2)),
];
const fixbot_move_landing = mm(FRAME.FRAME_landing_01, FRAME.FRAME_landing_58, fixbot_frames_landing);

/*
	generic ambient stand
*/
const fixbot_frames_stand: MframeT[] = [
  ...Array.from({ length: 18 }, () => mf(ai_move, 0, null)),
  mf(ai_move, 0, change_to_roam),
];
const fixbot_move_stand = mm(FRAME.FRAME_ambient_01, FRAME.FRAME_ambient_19, fixbot_frames_stand);

const fixbot_frames_stand2: MframeT[] = Array.from({ length: 19 }, () => mf(ai_stand, 0, null));
const fixbot_move_stand2 = mm(FRAME.FRAME_ambient_01, FRAME.FRAME_ambient_19, fixbot_frames_stand2);

/*
	will need the pickup offset for the front pincers
	object will need to stop forward of the object
	and take the object with it ( this may require a variant of liftoff and landing )
*/
const fixbot_frames_pickup: MframeT[] = Array.from({ length: 27 }, () => mf(ai_move, 0, null));
const fixbot_move_pickup = mm(FRAME.FRAME_pickup_01, FRAME.FRAME_pickup_27, fixbot_frames_pickup);

/*
	generic frame to move bot
*/
const fixbot_frames_roamgoal: MframeT[] = [mf(ai_move, 0, roam_goal)];
const fixbot_move_roamgoal = mm(FRAME.FRAME_freeze_01, FRAME.FRAME_freeze_01, fixbot_frames_roamgoal);

function ai_facing(self: EdictT, _dist: number): void {
  if (self.goalentity === null) return; // C assumes self->goalentity is set here

  if (infront(self, self.goalentity)) {
    self.monsterinfo.currentmove = fixbot_move_forward;
  } else {
    const v = vec3();
    VectorSubtract(self.goalentity.s.origin, self.s.origin, v);
    self.ideal_yaw = vectoyaw(v);
    M_ChangeYaw(self);
  }
}

const fixbot_frames_turn: MframeT[] = [mf(ai_facing, 0, null)];
const fixbot_move_turn = mm(FRAME.FRAME_freeze_01, FRAME.FRAME_freeze_01, fixbot_frames_turn);

// Dead code: never called anywhere in m_fixbot.c. Ported verbatim.
function go_roam(self: EdictT): void {
  self.monsterinfo.currentmove = fixbot_move_stand;
}

/*
	takeoff
*/
const fixbot_frames_takeoff: MframeT[] = Array.from({ length: 16 }, () => mf(ai_move, 0.01, fly_vertical));
const fixbot_move_takeoff = mm(FRAME.FRAME_takeoff_01, FRAME.FRAME_takeoff_16, fixbot_frames_takeoff);

/* findout what this is */
const fixbot_frames_paina: MframeT[] = Array.from({ length: 6 }, () => mf(ai_move, 0, null));
const fixbot_move_paina = mm(FRAME.FRAME_paina_01, FRAME.FRAME_paina_06, fixbot_frames_paina, fixbot_run);

/* findout what this is */
const fixbot_frames_painb: MframeT[] = Array.from({ length: 8 }, () => mf(ai_move, 0, null));
const fixbot_move_painb = mm(FRAME.FRAME_painb_01, FRAME.FRAME_painb_08, fixbot_frames_painb, fixbot_run);

/*
	backup from pain
	call a generic painsound
	some spark effects
*/
const fixbot_frames_pain3: MframeT[] = [mf(ai_move, -1, null)];
const fixbot_move_pain3 = mm(FRAME.FRAME_freeze_01, FRAME.FRAME_freeze_01, fixbot_frames_pain3, fixbot_run);

/*
	bot has compleated landing
	and is now on the grownd
	( may need second land if the bot is releasing jib into jib vat )
*/
// Dead code: fixbot_move_land/fixbot_frames_land are never wired to any
// monsterinfo callback or move-table endfunc. Ported verbatim.
const fixbot_frames_land: MframeT[] = [mf(ai_move, 0, null)];
const fixbot_move_land = mm(FRAME.FRAME_freeze_01, FRAME.FRAME_freeze_01, fixbot_frames_land);

function ai_movetogoal(self: EdictT, dist: number): void {
  M_MoveToGoal(self, dist);
}

const fixbot_frames_forward: MframeT[] = [mf(ai_movetogoal, 5, use_scanner)];
const fixbot_move_forward = mm(FRAME.FRAME_freeze_01, FRAME.FRAME_freeze_01, fixbot_frames_forward);

const fixbot_frames_walk: MframeT[] = [mf(ai_walk, 5, null)];
const fixbot_move_walk = mm(FRAME.FRAME_freeze_01, FRAME.FRAME_freeze_01, fixbot_frames_walk);

const fixbot_frames_run: MframeT[] = [mf(ai_run, 10, null)];
const fixbot_move_run = mm(FRAME.FRAME_freeze_01, FRAME.FRAME_freeze_01, fixbot_frames_run);

/*
	raf
	note to self
	they could have a timer that will cause
	the bot to explode on countdown
*/
const fixbot_frames_death1: MframeT[] = [mf(ai_move, 0, null)];
const fixbot_move_death1 = mm(FRAME.FRAME_freeze_01, FRAME.FRAME_freeze_01, fixbot_frames_death1, fixbot_dead);

const fixbot_frames_backward: MframeT[] = [mf(ai_move, 0, null)];
const fixbot_move_backward = mm(FRAME.FRAME_freeze_01, FRAME.FRAME_freeze_01, fixbot_frames_backward);

// Dead code: fixbot_start_attack/fixbot_move_start_attack are never called
// from anywhere in m_fixbot.c. Ported verbatim.
const fixbot_frames_start_attack: MframeT[] = [mf(ai_charge, 0, null)];
const fixbot_move_start_attack = mm(FRAME.FRAME_freeze_01, FRAME.FRAME_freeze_01, fixbot_frames_start_attack, fixbot_attack);

/*
	TBD:
	need to get laser attack anim
	attack with the laser blast
*/
const fixbot_frames_attack1: MframeT[] = [
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, -10, fixbot_fire_blaster),
];
const fixbot_move_attack1 = mm(FRAME.FRAME_shoot_01, FRAME.FRAME_shoot_06, fixbot_frames_attack1);

function check_telefrag(self: EdictT): boolean {
  if (self.enemy === null) return true; // C assumes self->enemy is set here

  const start = vec3(0, 0, 0);
  const forward = vec3();
  const right = vec3();
  const up = vec3();

  AngleVectors(self.enemy.s.angles, forward, right, up);
  VectorMA(start, 48, up, start);
  const tr = gi.trace(self.enemy.s.origin, self.enemy.mins, self.enemy.maxs, start, self, MASK_MONSTERSOLID);
  const hit = traceEdict(tr.ent);
  if (hit.takedamage) {
    hit.health = -1000;
    return false;
  }

  return true;
}

function fixbot_fire_laser(self: EdictT): void {
  if (self.enemy === null) return; // C assumes self->enemy is set here

  // critter dun got blown up while bein' fixed
  if (self.enemy.health <= self.enemy.gib_health) {
    self.monsterinfo.currentmove = fixbot_move_stand;
    self.monsterinfo.aiflags &= ~AI_MEDIC;
    return;
  }

  gi.sound(self, CHAN_AUTO, gi.soundindex("misc/lasfly.wav"), 1, ATTN_STATIC, 0);

  const start = vec3();
  const end = vec3();
  const dir = vec3();
  const angles = vec3();
  VectorCopy(self.s.origin, start);
  VectorCopy(self.enemy.s.origin, end);
  VectorSubtract(end, start, dir);
  vectoangles(dir, angles);

  const ent = G_Spawn();
  VectorCopy(self.s.origin, ent.s.origin);
  const tempang = vec3();
  VectorCopy(angles, tempang);
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(tempang, forward, right, up);
  VectorCopy(tempang, ent.s.angles);
  VectorCopy(ent.s.origin, start);

  VectorMA(start, 16, forward, start);

  VectorCopy(start, ent.s.origin);
  ent.enemy = self.enemy;
  ent.owner = self;
  ent.dmg = -1;
  monster_dabeam(ent);

  if (self.enemy.health > self.enemy.mass / 10) {
    // sorry guys but had to fix the problem this way
    // if it doesn't do this then two creatures can share the same space
    // and its real bad.
    if (check_telefrag(self)) {
      self.enemy.spawnflags = 0;
      self.enemy.monsterinfo.aiflags = 0;
      self.enemy.target = null;
      self.enemy.targetname = null;
      self.enemy.combattarget = null;
      self.enemy.deathtarget = null;
      self.enemy.owner = self;
      ED_CallSpawn(self.enemy);
      self.enemy.owner = null;
      self.s.origin[2] += 1;

      self.enemy.monsterinfo.aiflags &= ~AI_RESURRECTING;

      self.monsterinfo.currentmove = fixbot_move_stand;
      self.monsterinfo.aiflags &= ~AI_MEDIC;
    }
  } else {
    self.enemy.monsterinfo.aiflags |= AI_RESURRECTING;
  }
}

const fixbot_frames_laserattack: MframeT[] = Array.from({ length: 6 }, () => mf(ai_charge, 0, fixbot_fire_laser));
const fixbot_move_laserattack = mm(FRAME.FRAME_shoot_01, FRAME.FRAME_shoot_06, fixbot_frames_laserattack);

/*
	need to get forward translation data
	for the charge attack
*/
const fixbot_frames_attack2: MframeT[] = [
  ...Array.from({ length: 10 }, () => mf(ai_charge, 0, null)),
  ...Array.from({ length: 10 }, () => mf(ai_charge, -10, null)),
  mf(ai_charge, 0, fixbot_fire_blaster),
  ...Array.from({ length: 9 }, () => mf(ai_charge, 0, null)),
  mf(ai_charge, 0, null),
];
const fixbot_move_attack2 = mm(FRAME.FRAME_charging_01, FRAME.FRAME_charging_31, fixbot_frames_attack2, fixbot_run);

function weldstate(self: EdictT): void {
  if (self.s.frame === FRAME.FRAME_weldstart_10) {
    self.monsterinfo.currentmove = fixbot_move_weld;
  } else if (self.s.frame === FRAME.FRAME_weldmiddle_07) {
    if (self.goalentity === null) return; // C assumes self->goalentity is set here
    if (self.goalentity.health < 0) {
      if (self.enemy !== null) self.enemy.owner = null;
      self.monsterinfo.currentmove = fixbot_move_weld_end;
    } else {
      self.goalentity.health -= 10;
    }
  } else {
    self.goalentity = null;
    self.enemy = null;
    self.monsterinfo.currentmove = fixbot_move_stand;
  }
}

function ai_move2(self: EdictT, dist: number): void {
  if (dist) M_walkmove(self, self.s.angles[YAW], dist);

  if (self.goalentity === null) return; // C assumes self->goalentity is set here
  const v = vec3();
  VectorSubtract(self.goalentity.s.origin, self.s.origin, v);
  self.ideal_yaw = vectoyaw(v);
  M_ChangeYaw(self);
}

const fixbot_frames_weld_start: MframeT[] = [
  ...Array.from({ length: 9 }, () => mf(ai_move2, 0, null)),
  mf(ai_move2, 0, weldstate),
];
const fixbot_move_weld_start = mm(FRAME.FRAME_weldstart_01, FRAME.FRAME_weldstart_10, fixbot_frames_weld_start);

const fixbot_frames_weld: MframeT[] = [
  ...Array.from({ length: 6 }, () => mf(ai_move2, 0, fixbot_fire_welder)),
  mf(ai_move2, 0, weldstate),
];
const fixbot_move_weld = mm(FRAME.FRAME_weldmiddle_01, FRAME.FRAME_weldmiddle_07, fixbot_frames_weld);

const fixbot_frames_weld_end: MframeT[] = [
  ...Array.from({ length: 6 }, () => mf(ai_move2, -2, null)),
  mf(ai_move2, -2, weldstate),
];
const fixbot_move_weld_end = mm(FRAME.FRAME_weldend_01, FRAME.FRAME_weldend_07, fixbot_frames_weld_end);

function fixbot_fire_welder(self: EdictT): void {
  if (self.enemy === null) return;

  const vec = vec3(24.0, -0.8, -10.0);

  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(self.s.angles, forward, right, up);
  const start = vec3();
  G_ProjectSource(self.s.origin, vec, forward, right, start);

  const end = vec3();
  VectorCopy(self.enemy.s.origin, end);

  const dir = vec3();
  VectorSubtract(end, start, dir);

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_WELDING_SPARKS);
  gi.WriteByte(10);
  gi.WritePosition(start);
  gi.WriteDir(vec3_origin);
  gi.WriteByte(0xe0 + Math.floor(Math.random() * 8));
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);

  if (random() > 0.8) {
    const r = random();

    if (r < 0.33) gi.sound(self, CHAN_VOICE, sound_weld1, 1, ATTN_IDLE, 0);
    else if (r < 0.66) gi.sound(self, CHAN_VOICE, sound_weld2, 1, ATTN_IDLE, 0);
    else gi.sound(self, CHAN_VOICE, sound_weld3, 1, ATTN_IDLE, 0);
  }
}

function fixbot_fire_blaster(self: EdictT): void {
  if (self.enemy === null) return; // C assumes self->enemy is set here

  if (!visible(self, self.enemy)) {
    self.monsterinfo.currentmove = fixbot_move_run;
  }

  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(self.s.angles, forward, right, up);
  const start = vec3();
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_fixbot_BLASTER_1], forward, right, start);

  const end = vec3();
  VectorCopy(self.enemy.s.origin, end);
  end[2] += self.enemy.viewheight;
  const dir = vec3();
  VectorSubtract(end, start, dir);

  monster_fire_blaster(self, start, dir, 15, 1000, MZ2_fixbot_BLASTER_1, EF_BLASTER);
}

function fixbot_stand(self: EdictT): void {
  self.monsterinfo.currentmove = fixbot_move_stand;
}

function fixbot_run(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = fixbot_move_stand;
  else self.monsterinfo.currentmove = fixbot_move_run;
}

function fixbot_walk(self: EdictT): void {
  if (self.goalentity !== null && self.goalentity.classname === "object_repair") {
    const vec = vec3();
    VectorSubtract(self.s.origin, self.goalentity.s.origin, vec);
    const len = VectorLength(vec);
    if (len < 32) {
      self.monsterinfo.currentmove = fixbot_move_weld_start;
      return;
    }
  }
  self.monsterinfo.currentmove = fixbot_move_walk;
}

function fixbot_start_attack(self: EdictT): void {
  self.monsterinfo.currentmove = fixbot_move_start_attack;
}

function fixbot_attack(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_MEDIC) {
    if (self.goalentity === null || !visible(self, self.goalentity)) return;
    if (self.enemy === null) return; // C assumes self->enemy is set here
    const vec = vec3();
    VectorSubtract(self.s.origin, self.enemy.s.origin, vec);
    const len = VectorLength(vec);
    if (len > 128) return;
    self.monsterinfo.currentmove = fixbot_move_laserattack;
  } else {
    self.monsterinfo.currentmove = fixbot_move_attack2;
  }
}

function fixbot_pain(self: EdictT, _other: EdictT, _kick: number, damage: number): void {
  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 3;
  gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);

  if (damage <= 10) self.monsterinfo.currentmove = fixbot_move_pain3;
  else if (damage <= 25) self.monsterinfo.currentmove = fixbot_move_painb;
  else self.monsterinfo.currentmove = fixbot_move_paina;
}

function fixbot_dead(self: EdictT): void {
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, -8);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

function fixbot_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3): void {
  gi.sound(self, CHAN_VOICE, sound_die, 1, ATTN_NORM, 0);
  BecomeExplosion1(self);

  // shards
}

/*QUAKED monster_fixbot (1 .5 0) (-32 -32 -24) (32 32 24) Ambush Trigger_Spawn Fixit Takeoff Landing
*/
export function SP_monster_fixbot(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  sound_pain1 = gi.soundindex("flyer/flypain1.wav");
  sound_die = gi.soundindex("flyer/flydeth1.wav");

  sound_weld1 = gi.soundindex("misc/welder1.wav");
  sound_weld2 = gi.soundindex("misc/welder2.wav");
  sound_weld3 = gi.soundindex("misc/welder3.wav");

  self.s.modelindex = gi.modelindex("models/monsters/fixbot/tris.md2");

  VectorSet(self.mins, -32, -32, -24);
  VectorSet(self.maxs, 32, 32, 24);

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;

  self.health = 150;
  self.mass = 150;

  self.pain = fixbot_pain;
  self.die = fixbot_die;

  self.monsterinfo.stand = fixbot_stand;
  self.monsterinfo.walk = fixbot_walk;
  self.monsterinfo.run = fixbot_run;
  self.monsterinfo.attack = fixbot_attack;

  gi.linkentity(self);

  self.monsterinfo.currentmove = fixbot_move_stand;
  self.monsterinfo.scale = FRAME.MODEL_SCALE;

  flymonster_start(self);
}

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- so a save containing an entity that
// references one of these callbacks or move tables restores a real
// think/touch/use/pain/die/blocked function or monsterinfo.currentmove
// object instead of null (see g_save.ts's registerSaveFunction/
// registerSaveMmove name registry).
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("m_fixbot:change_to_roam", change_to_roam);
registerSaveFunction("m_fixbot:landing_goal", landing_goal);
registerSaveFunction("m_fixbot:takeoff_goal", takeoff_goal);
registerSaveFunction("m_fixbot:roam_goal", roam_goal);
registerSaveFunction("m_fixbot:use_scanner", use_scanner);
registerSaveFunction("m_fixbot:fly_vertical", fly_vertical);
registerSaveFunction("m_fixbot:fly_vertical2", fly_vertical2);
registerSaveFunction("m_fixbot:go_roam", go_roam);
registerSaveFunction("m_fixbot:fixbot_fire_laser", fixbot_fire_laser);
registerSaveFunction("m_fixbot:weldstate", weldstate);
registerSaveFunction("m_fixbot:fixbot_fire_welder", fixbot_fire_welder);
registerSaveFunction("m_fixbot:fixbot_fire_blaster", fixbot_fire_blaster);
registerSaveFunction("m_fixbot:fixbot_stand", fixbot_stand);
registerSaveFunction("m_fixbot:fixbot_run", fixbot_run);
registerSaveFunction("m_fixbot:fixbot_walk", fixbot_walk);
registerSaveFunction("m_fixbot:fixbot_start_attack", fixbot_start_attack);
registerSaveFunction("m_fixbot:fixbot_attack", fixbot_attack);
registerSaveFunction("m_fixbot:fixbot_pain", fixbot_pain);
registerSaveFunction("m_fixbot:fixbot_dead", fixbot_dead);
registerSaveFunction("m_fixbot:fixbot_die", fixbot_die);
registerSaveMmove("m_fixbot:fixbot_move_landing", fixbot_move_landing);
registerSaveMmove("m_fixbot:fixbot_move_stand", fixbot_move_stand);
registerSaveMmove("m_fixbot:fixbot_move_stand2", fixbot_move_stand2);
registerSaveMmove("m_fixbot:fixbot_move_pickup", fixbot_move_pickup);
registerSaveMmove("m_fixbot:fixbot_move_roamgoal", fixbot_move_roamgoal);
registerSaveMmove("m_fixbot:fixbot_move_turn", fixbot_move_turn);
registerSaveMmove("m_fixbot:fixbot_move_takeoff", fixbot_move_takeoff);
registerSaveMmove("m_fixbot:fixbot_move_paina", fixbot_move_paina);
registerSaveMmove("m_fixbot:fixbot_move_painb", fixbot_move_painb);
registerSaveMmove("m_fixbot:fixbot_move_pain3", fixbot_move_pain3);
registerSaveMmove("m_fixbot:fixbot_move_land", fixbot_move_land);
registerSaveMmove("m_fixbot:fixbot_move_forward", fixbot_move_forward);
registerSaveMmove("m_fixbot:fixbot_move_walk", fixbot_move_walk);
registerSaveMmove("m_fixbot:fixbot_move_run", fixbot_move_run);
registerSaveMmove("m_fixbot:fixbot_move_death1", fixbot_move_death1);
registerSaveMmove("m_fixbot:fixbot_move_backward", fixbot_move_backward);
registerSaveMmove("m_fixbot:fixbot_move_start_attack", fixbot_move_start_attack);
registerSaveMmove("m_fixbot:fixbot_move_attack1", fixbot_move_attack1);
registerSaveMmove("m_fixbot:fixbot_move_laserattack", fixbot_move_laserattack);
registerSaveMmove("m_fixbot:fixbot_move_attack2", fixbot_move_attack2);
registerSaveMmove("m_fixbot:fixbot_move_weld_start", fixbot_move_weld_start);
registerSaveMmove("m_fixbot:fixbot_move_weld", fixbot_move_weld);
registerSaveMmove("m_fixbot:fixbot_move_weld_end", fixbot_move_weld_end);
