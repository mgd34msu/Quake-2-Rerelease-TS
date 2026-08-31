// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_actor.cpp / m_actor.h -- ACTOR (2023 Quake II re-release / "KEX" engine)
// AND target_actor. Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/m_actor.cpp (565 lines, C++17)
// and m_actor.h (492 lines, 481-entry frame enum (transcription corrected: an earlier draft recorded header line numbers, +9 off, for every constant from FRAME_flip01 on) plus MODEL_SCALE).
// Behavioral code, ported bug-for-bug per PORTING.md.
//
// This is a full KEX rewrite of the legacy vanilla-Q2 `misc_actor`/
// `target_actor` this directory's own src/game/m_actor.ts already ports (the
// two files are NOT meant to be diffed line-for-line). Notable KEX changes:
// `actor_stand` now randomizes its startup frame via `irandom(firstframe,
// lastframe+1)` against `monsterinfo.active_move` instead of directly
// indexing `monsterinfo.currentmove` (both legacy port and this one use
// `Math.random()`-based ranges, but the KEX source reads the CURRENTLY
// ACTIVE move rather than re-deriving bounds from a hardcoded reference);
// `actor_frames_walk`/`actor_frames_run` DROP the legacy port's C-bug extra
// dead rows entirely (KEX's own arrays are exactly 8 and 6 entries -- no
// mismatched-length quirk to preserve here, unlike the legacy port's own
// documented bug); a `actor_setskin` MONSTERINFO_SETSKIN callback is new;
// pain's chat taunt uses `random_element(messages)` instead of a raw
// `rand()%3` index; `actor_fire`'s hold-frame debounce field is
// `monsterinfo.fire_wait` (KEX) rather than legacy's `monsterinfo.pausetime`;
// `actor_attack` sets `fire_wait = level.time + random_time(1_sec, 2.6_sec)`
// (a KEX addition, absent from the legacy port entirely, which never sets a
// debounce for its attack move); `M_AllowSpawn` gates `SP_misc_actor`
// (absent from the legacy port); health only defaults to 100 if unset
// (`if (!self->health) self->health = 100;`) instead of legacy's unconditional
// assignment context (same as legacy, actually -- see DEVIATIONS below for
// the one place this differs).
//
// ============================================================================
// PLACEMENT-MISMATCH FUNCTIONS PORTED LOCALLY -- see m_gladiator.ts header
// ============================================================================
// - `edictFmt` (g_local.h:3534-3549's `fmt::formatter<edict_t>`, "{classname}
//   @ {midpoint or origin}") -- reimplemented locally, exactly g_misc.ts's/
//   g_turret.ts's own copies, since `gi.Com_Print` takes a plain string.
//
// ============================================================================
// OTHER NOTED DEVIATIONS / QUIRKS (bug-for-bug, not "fixed")
// ============================================================================
// - `gi.Com_PrintFmt("{}: bad target {}\n", *self, self->target)` /
//   `gi.Com_PrintFmt("{}: no targetname\n", *self)` / `"{}: no target\n"`
//   port as `gi.Com_Print(...)` template literals using the local `edictFmt`
//   helper, matching every other landed file's convention for
//   `fmt::formatter<edict_t>`-based prints (this port line has no G_Fmt/
//   fmtlib -- see g_misc.ts's own header note).
// - `gi.LocClient_Print(other, PRINT_CHAT, "{}: {}!\n", name,
//   random_element(messages))` (actor_pain's taunt line) ports as a
//   `gi.Client_Print(ent, PrintTypeT.PRINT_CHAT, ...)` template literal:
//   `name` and every `messages[]` entry are fixed literal strings (`"Watch
//   it"`, `"#$@*&"`, ...), none `$`-prefixed, so `Loc_Localize` on either
//   would be a no-op passthrough -- the template literal produces the exact
//   same bytes.
// - The `target_actor_touch` broadcast loop's `gi.LocClient_Print(ent,
//   PRINT_CHAT, "{}: {}\n", ..., self->message)` is NOT the same case:
//   `self.message` is the generic map-entity `message` spawn field (settable
//   per-map, like every other edict), so it can be a `$key` in principle.
//   This now goes through `gi.Loc_Print` for real (same defect class as
//   g_func.ts's door_touch / g_utils.ts's G_PrintActivationMessage / this
//   port's other stale "no localization backend" notes -- see those files).
// - `self.monsterinfo.stand`/`self.monsterinfo.walk` are nullable
//   (`MonsterinfoStandFn | null`) in this port's `EdictT`, unlike C++'s bare
//   function pointer called without a null check. Every call site here uses
//   an explicit `if (x === null) throw new Error(...)` guard immediately
//   before calling, matching g_ai.ts's `HuntTarget` precedent -- not a
//   behavior change (a null function pointer call would crash in C++ too),
//   just TypeScript's strict-null-checks needing an explicit witness.
// - `actor_names[(self - g_edicts) % q_countof(actor_names)]` ports as
//   `actor_names[self.s.number % actor_names.length]`, matching the legacy
//   port's own `self.s.number % MAX_ACTOR_NAMES` idiom (`self - g_edicts`
//   is pointer arithmetic yielding the entity's index, i.e. `s.number`).

import { vec3, type Vec3 } from "../shared/math";
import { CHAN_VOICE, ATTN_NORM, YAW } from "../shared/q_shared";
import { PrintTypeT, SolidT, SvflagsT } from "../kexapi/game";
import {
  type EdictT,
  type MframeAifuncFn,
  type MframeThinkfuncFn,
  type MmoveEndfuncFn,
  type ModT,
  MframeT,
  MmoveT,
  MonsterAiFlagsT,
  MovetypeT,
  GibTypeT,
  DEFAULT_BULLET_HSPREAD,
  DEFAULT_BULLET_VSPREAD,
  random_time,
  HOLD_FOREVER,
} from "./g_local";
import { gi, g_edicts, game, level } from "./g_main_globals";
import { Gtime_add, Gtime_from_sec, GTIME_ZERO } from "./gtime";
import { type SpawnFlags, SpawnFlags_from, SpawnFlags_has, SpawnFlags_or } from "./spawnflags";
import { frandom, brandom, irandom, random_element } from "./q_std";
import { vec3_sub, vec3_add, vec3_muls, vec3_normalized, AngleVectors_destructured, vectoyaw } from "./q_vec3";
import { G_FreeEdict, G_PickTarget, G_SetMovedir, G_UseTargets } from "./g_utils";
import { st } from "./g_spawn";
import { ai_stand, ai_walk, ai_run, ai_move, ai_turn, ai_charge } from "./g_ai";
import { M_SetAnimation, M_AllowSpawn, M_ProjectFlashSource, monster_fire_bullet, walkmonster_start } from "./g_monster";
import { ThrowGibs, type GibDefT } from "./g_misc";
import { monsterFlashOffset } from "./m_flash";
import { MonsterMuzzleflashIdT } from "../kexapi/game";
import {
  RegisterDie,
  RegisterPain,
  RegisterUse,
  RegisterTouch,
  RegisterMonsterinfoStand,
  RegisterMonsterinfoWalk,
  RegisterMonsterinfoRun,
  RegisterMonsterinfoAttack,
  RegisterMonsterinfoSetskin,
  RegisterMmove,
} from "./g_save_registry";

// ---------------------------------------------------------------------------
// m_actor.h frame constants (generated from the enum, see file header --
// only the subset this file's move tables/QUAKED entries reference is
// transcribed; the model has many more frames used only by data the KEX
// source never wires up here, e.g. bl_*/cr_*/crbl_* "blind"/"crawl" sets)
// ---------------------------------------------------------------------------

export const FRAME_attak01 = 0;
export const FRAME_attak04 = 3;
export const FRAME_death101 = 4;
export const FRAME_death107 = 10;
export const FRAME_death201 = 11;
export const FRAME_death213 = 23;
export const FRAME_flip01 = 39;
export const FRAME_flip14 = 52;
export const FRAME_pain101 = 74;
export const FRAME_pain103 = 76;
export const FRAME_pain201 = 77;
export const FRAME_pain203 = 79;
export const FRAME_pain301 = 80;
export const FRAME_pain303 = 82;
export const FRAME_run02 = 93;
export const FRAME_run07 = 98;
export const FRAME_stand101 = 128;
export const FRAME_stand140 = 167;
export const FRAME_taunt01 = 234;
export const FRAME_taunt17 = 250;
export const FRAME_walk01 = 251;
export const FRAME_walk08 = 258;

export const MODEL_SCALE = 1.0;

const actor_names: readonly string[] = ["Hellrot", "Tokay", "Killme", "Disruptor", "Adrianator", "Rambear", "Titus", "Bitterman"];

const messages: readonly string[] = ["Watch it", "#$@*&", "Idiot", "Check your targets"];

// ---------------------------------------------------------------------------
// PLACEMENT-MISMATCH FUNCTIONS PORTED LOCALLY -- see file header
// ---------------------------------------------------------------------------

function edictFmt(ent: EdictT): string {
  return `${ent.classname ?? "?"} @ (${ent.s.origin[0]} ${ent.s.origin[1]} ${ent.s.origin[2]})`;
}

// ---------------------------------------------------------------------------
// local mframe_t / mmove_t helpers (see m_flipper.ts for rationale)
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

// ---------------------------------------------------------------------------
// stand (m_actor.cpp:20-74)
// ---------------------------------------------------------------------------

const actor_frames_stand: MframeT[] = Array.from({ length: 40 }, () => frame(ai_stand));
const actor_move_stand = RegisterMmove("actor_move_stand", move(FRAME_stand101, FRAME_stand140, actor_frames_stand));

const actor_stand = RegisterMonsterinfoStand("actor_stand", (self: EdictT): void => {
  M_SetAnimation(self, actor_move_stand, true);

  // randomize on startup
  if (level.time < Gtime_from_sec(1)) {
    const activeMove = self.monsterinfo.active_move;
    if (activeMove === null) throw new Error(`actor_stand: monsterinfo.active_move is null for ${edictFmt(self)}`);
    self.s.frame = irandom(activeMove.firstframe, activeMove.lastframe + 1);
  }
});

// ---------------------------------------------------------------------------
// walk (m_actor.cpp:76-91)
// ---------------------------------------------------------------------------

const actor_frames_walk: MframeT[] = [
  frame(ai_walk),
  frame(ai_walk, 6),
  frame(ai_walk, 10),
  frame(ai_walk, 3),
  frame(ai_walk, 2),
  frame(ai_walk, 7),
  frame(ai_walk, 10),
  frame(ai_walk, 1),
];
const actor_move_walk = RegisterMmove("actor_move_walk", move(FRAME_walk01, FRAME_walk08, actor_frames_walk));

const actor_walk = RegisterMonsterinfoWalk("actor_walk", (self: EdictT): void => {
  M_SetAnimation(self, actor_move_walk, true);
});

// ---------------------------------------------------------------------------
// run (m_actor.cpp:93-121)
// ---------------------------------------------------------------------------

const actor_frames_run: MframeT[] = [frame(ai_run, 4), frame(ai_run, 15), frame(ai_run, 15), frame(ai_run, 8), frame(ai_run, 20), frame(ai_run, 15)];
const actor_move_run = RegisterMmove("actor_move_run", move(FRAME_run02, FRAME_run07, actor_frames_run));

const actor_run = RegisterMonsterinfoRun("actor_run", (self: EdictT): void => {
  if (level.time < self.pain_debounce_time && self.enemy === null) {
    if (self.movetarget !== null) actor_walk(self);
    else actor_stand(self);
    return;
  }

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) {
    actor_stand(self);
    return;
  }

  M_SetAnimation(self, actor_move_run, true);
});

// ---------------------------------------------------------------------------
// pain (m_actor.cpp:123-231)
// ---------------------------------------------------------------------------

const actor_frames_pain1: MframeT[] = [frame(ai_move, -5), frame(ai_move, 4), frame(ai_move, 1)];
const actor_move_pain1 = RegisterMmove("actor_move_pain1", move(FRAME_pain101, FRAME_pain103, actor_frames_pain1, actor_run));

const actor_frames_pain2: MframeT[] = [frame(ai_move, -4), frame(ai_move, 4), frame(ai_move)];
const actor_move_pain2 = RegisterMmove("actor_move_pain2", move(FRAME_pain201, FRAME_pain203, actor_frames_pain2, actor_run));

const actor_frames_pain3: MframeT[] = [frame(ai_move, -1), frame(ai_move, 1), frame(ai_move, 0)];
const actor_move_pain3 = RegisterMmove("actor_move_pain3", move(FRAME_pain301, FRAME_pain303, actor_frames_pain3, actor_run));

const actor_frames_flipoff: MframeT[] = Array.from({ length: 14 }, () => frame(ai_turn));
const actor_move_flipoff = RegisterMmove("actor_move_flipoff", move(FRAME_flip01, FRAME_flip14, actor_frames_flipoff, actor_run));

const actor_frames_taunt: MframeT[] = Array.from({ length: 17 }, () => frame(ai_turn));
const actor_move_taunt = RegisterMmove("actor_move_taunt", move(FRAME_taunt01, FRAME_taunt17, actor_frames_taunt, actor_run));

const actor_pain = RegisterPain("actor_pain", (self: EdictT, other: EdictT, _kick: number, _damage: number, _mod: ModT): void => {
  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));

  if (other.client !== null && frandom() < 0.4) {
    const v = vec3_sub(other.s.origin, self.s.origin);
    self.ideal_yaw = vectoyaw(v);
    if (frandom() < 0.5) M_SetAnimation(self, actor_move_flipoff, true);
    else M_SetAnimation(self, actor_move_taunt, true);
    const name = actor_names[self.s.number % actor_names.length];
    gi.Client_Print(other, PrintTypeT.PRINT_CHAT, `${name}: ${random_element(messages)}!\n`);
    return;
  }

  const n = irandom(3);
  if (n === 0) M_SetAnimation(self, actor_move_pain1, true);
  else if (n === 1) M_SetAnimation(self, actor_move_pain2, true);
  else M_SetAnimation(self, actor_move_pain3, true);
});

// ---------------------------------------------------------------------------
// setskin (m_actor.cpp:225-231)
// ---------------------------------------------------------------------------

const actor_setskin = RegisterMonsterinfoSetskin("actor_setskin", (self: EdictT): void => {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;
  else self.s.skinnum = 0;
});

// ---------------------------------------------------------------------------
// machinegun attack (m_actor.cpp:233-260, 329-351)
// ---------------------------------------------------------------------------

function actorMachineGun(self: EdictT): void {
  const { forward: fwd, right } = AngleVectors_destructured(self.s.angles);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_ACTOR_MACHINEGUN_1], fwd, right);

  let forward: Vec3;
  if (self.enemy !== null) {
    let target: Vec3;
    if (self.enemy.health > 0) {
      target = vec3_add(self.enemy.s.origin, vec3_muls(self.enemy.velocity, -0.2));
      target[2] += self.enemy.viewheight;
    } else {
      target = vec3(self.enemy.absmin[0], self.enemy.absmin[1], self.enemy.absmin[2]);
      target[2] += self.enemy.size[2] / 2 + 1;
    }
    forward = vec3_normalized(vec3_sub(target, start));
  } else {
    forward = AngleVectors_destructured(self.s.angles).forward;
  }
  monster_fire_bullet(self, start, forward, 3, 4, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, MonsterMuzzleflashIdT.MZ2_ACTOR_MACHINEGUN_1);
}

function actor_fire(self: EdictT): void {
  actorMachineGun(self);

  if (level.time >= self.monsterinfo.fire_wait) self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_HOLD_FRAME;
  else self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_HOLD_FRAME;
}

const actor_frames_attack: MframeT[] = [frame(ai_charge, -2, actor_fire), frame(ai_charge, -2), frame(ai_charge, 3), frame(ai_charge, 2)];
const actor_move_attack = RegisterMmove("actor_move_attack", move(FRAME_attak01, FRAME_attak04, actor_frames_attack, actor_run));

const actor_attack = RegisterMonsterinfoAttack("actor_attack", (self: EdictT): void => {
  M_SetAnimation(self, actor_move_attack, true);
  self.monsterinfo.fire_wait = Gtime_add(level.time, random_time(Gtime_from_sec(1), Gtime_from_sec(2.6)));
});

// ---------------------------------------------------------------------------
// death (m_actor.cpp:262-327)
// ---------------------------------------------------------------------------

function actor_dead(self: EdictT): void {
  self.mins = vec3(-16, -16, -24);
  self.maxs = vec3(16, 16, -8);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SvflagsT.SVF_DEADMONSTER;
  self.nextthink = GTIME_ZERO;
  gi.linkentity(self);
}

const actor_frames_death1: MframeT[] = [
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, -13),
  frame(ai_move, 14),
  frame(ai_move, 3),
  frame(ai_move, -2),
  frame(ai_move, 1),
];
const actor_move_death1 = RegisterMmove("actor_move_death1", move(FRAME_death101, FRAME_death107, actor_frames_death1, actor_dead));

const actor_frames_death2: MframeT[] = [
  frame(ai_move),
  frame(ai_move, 7),
  frame(ai_move, -6),
  frame(ai_move, -5),
  frame(ai_move, 1),
  frame(ai_move),
  frame(ai_move, -1),
  frame(ai_move, -2),
  frame(ai_move, -1),
  frame(ai_move, -9),
  frame(ai_move, -13),
  frame(ai_move, -13),
  frame(ai_move),
];
const actor_move_death2 = RegisterMmove("actor_move_death2", move(FRAME_death201, FRAME_death213, actor_frames_death2, actor_dead));

const actor_die = RegisterDie(
  "actor_die",
  (self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3, _mod: ModT): void => {
    // check for gib
    if (self.health <= -80) {
      const gibs: GibDefT[] = [
        { gibname: "models/objects/gibs/bone/tris.md2", count: 2 },
        { gibname: "models/objects/gibs/sm_meat/tris.md2", count: 4 },
        { gibname: "models/objects/gibs/head2/tris.md2", type: GibTypeT.GIB_HEAD },
      ];
      ThrowGibs(self, damage, gibs);
      self.deadflag = true;
      return;
    }

    if (self.deadflag) return;

    // regular death
    self.deadflag = true;
    self.takedamage = true;

    if (brandom()) M_SetAnimation(self, actor_move_death1, true);
    else M_SetAnimation(self, actor_move_death2, true);
  },
);

// ---------------------------------------------------------------------------
// use / misc_actor (m_actor.cpp:353-429)
// ---------------------------------------------------------------------------

const actor_use = RegisterUse("actor_use", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  const target = G_PickTarget(self.target);
  self.goalentity = target;
  self.movetarget = target;
  if (self.movetarget === null || self.movetarget.classname !== "target_actor") {
    gi.Com_Print(`${edictFmt(self)}: bad target ${self.target ?? "?"}\n`);
    self.target = null;
    self.monsterinfo.pausetime = HOLD_FOREVER;
    if (self.monsterinfo.stand === null) throw new Error(`actor_use: monsterinfo.stand is null for ${edictFmt(self)}`);
    self.monsterinfo.stand(self);
    return;
  }

  const v = vec3_sub(self.movetarget.s.origin, self.s.origin);
  self.ideal_yaw = vectoyaw(v);
  self.s.angles[YAW] = self.ideal_yaw;
  if (self.monsterinfo.walk === null) throw new Error(`actor_use: monsterinfo.walk is null for ${edictFmt(self)}`);
  self.monsterinfo.walk(self);
  self.target = null;
});

/**
 * QUAKED misc_actor (1 .5 0) (-16 -16 -24) (16 16 32)
 */
export function SP_misc_actor(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  if (!self.targetname) {
    gi.Com_Print(`${edictFmt(self)}: no targetname\n`);
    G_FreeEdict(self);
    return;
  }

  if (!self.target) {
    gi.Com_Print(`${edictFmt(self)}: no target\n`);
    G_FreeEdict(self);
    return;
  }

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("players/male/tris.md2");
  self.mins = vec3(-16, -16, -24);
  self.maxs = vec3(16, 16, 32);

  if (!self.health) self.health = 100;
  self.mass = 200;

  self.pain = actor_pain;
  self.die = actor_die;

  self.monsterinfo.stand = actor_stand;
  self.monsterinfo.walk = actor_walk;
  self.monsterinfo.run = actor_run;
  self.monsterinfo.attack = actor_attack;
  self.monsterinfo.melee = null;
  self.monsterinfo.sight = null;
  self.monsterinfo.setskin = actor_setskin;

  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_GOOD_GUY;

  gi.linkentity(self);

  M_SetAnimation(self, actor_move_stand, true);
  self.monsterinfo.scale = MODEL_SCALE;

  walkmonster_start(self);

  // actors always start in a dormant state, they *must* be used to get going
  self.use = actor_use;
}

// ---------------------------------------------------------------------------
// target_actor (m_actor.cpp:431-564)
// ---------------------------------------------------------------------------

const SPAWNFLAG_TARGET_ACTOR_JUMP: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAG_TARGET_ACTOR_SHOOT: SpawnFlags = SpawnFlags_from(2);
const SPAWNFLAG_TARGET_ACTOR_ATTACK: SpawnFlags = SpawnFlags_from(4);
const SPAWNFLAG_TARGET_ACTOR_HOLD: SpawnFlags = SpawnFlags_from(16);
const SPAWNFLAG_TARGET_ACTOR_BRUTAL: SpawnFlags = SpawnFlags_from(32);

const target_actor_touch = RegisterTouch(
  "target_actor_touch",
  (self: EdictT, other: EdictT, _tr, _otherTouchingSelf): void => {
    if (other.movetarget !== self) return;

    if (other.enemy !== null) return;

    other.goalentity = null;
    other.movetarget = null;

    if (self.message !== null) {
      for (let n = 1; n <= game.maxclients; n++) {
        const ent = g_edicts[n];
        if (ent === undefined || !ent.inuse) continue;
        gi.Loc_Print(ent, PrintTypeT.PRINT_CHAT, "{}: {}\n", [actor_names[other.s.number % actor_names.length], self.message ?? ""], 2);
      }
    }

    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TARGET_ACTOR_JUMP)) {
      // jump
      other.velocity[0] = self.movedir[0] * self.speed;
      other.velocity[1] = self.movedir[1] * self.speed;

      if (other.groundentity !== null) {
        other.groundentity = null;
        other.velocity[2] = self.movedir[2];
        gi.sound(other, CHAN_VOICE, gi.soundindex("player/male/jump1.wav"), 1, ATTN_NORM, 0);
      }
    }

    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TARGET_ACTOR_SHOOT)) {
      // shoot
    } else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TARGET_ACTOR_ATTACK)) {
      // attack
      other.enemy = G_PickTarget(self.pathtarget);
      if (other.enemy !== null) {
        other.goalentity = other.enemy;
        if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TARGET_ACTOR_BRUTAL)) other.monsterinfo.aiflags |= MonsterAiFlagsT.AI_BRUTAL;
        if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TARGET_ACTOR_HOLD)) {
          other.monsterinfo.aiflags |= MonsterAiFlagsT.AI_STAND_GROUND;
          actor_stand(other);
        } else {
          actor_run(other);
        }
      }
    }

    if (
      !SpawnFlags_has(self.spawnflags, SpawnFlags_or(SPAWNFLAG_TARGET_ACTOR_ATTACK, SPAWNFLAG_TARGET_ACTOR_SHOOT)) &&
      self.pathtarget !== null
    ) {
      const savetarget = self.target;
      self.target = self.pathtarget;
      G_UseTargets(self, other);
      self.target = savetarget;
    }

    other.movetarget = G_PickTarget(self.target);

    if (other.goalentity === null) other.goalentity = other.movetarget;

    if (other.movetarget === null && other.enemy === null) {
      other.monsterinfo.pausetime = HOLD_FOREVER;
      if (other.monsterinfo.stand === null) throw new Error(`target_actor_touch: monsterinfo.stand is null for ${edictFmt(other)}`);
      other.monsterinfo.stand(other);
    } else if (other.movetarget === other.goalentity && other.movetarget !== null) {
      const v = vec3_sub(other.movetarget.s.origin, other.s.origin);
      other.ideal_yaw = vectoyaw(v);
    }
  },
);

/**
 * QUAKED target_actor (.5 .3 0) (-8 -8 -8) (8 8 8) JUMP SHOOT ATTACK x HOLD
 * BRUTAL
 *
 * JUMP            jump in set direction upon reaching this target
 * SHOOT           take a single shot at the pathtarget
 * ATTACK          attack pathtarget until it or actor is dead
 *
 * "target"        next target_actor
 * "pathtarget"    target of any action to be taken at this point
 * "wait"          amount of time actor should pause at this point
 * "message"       actor will "say" this to the player
 *
 * for JUMP only:
 * "speed"         speed thrown forward (default 200)
 * "height"        speed thrown upwards (default 200)
 */
export function SP_target_actor(self: EdictT): void {
  if (!self.targetname) gi.Com_Print(`${edictFmt(self)}: no targetname\n`);

  self.solid = SolidT.SOLID_TRIGGER;
  self.touch = target_actor_touch;
  self.mins = vec3(-8, -8, -8);
  self.maxs = vec3(8, 8, 8);
  self.svflags = SvflagsT.SVF_NOCLIENT;

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TARGET_ACTOR_JUMP)) {
    if (!self.speed) self.speed = 200;
    if (!st.height) st.height = 200;
    if (self.s.angles[YAW] === 0) self.s.angles[YAW] = 360;
    G_SetMovedir(self.s.angles, self.movedir);
    self.movedir[2] = st.height;
  }

  gi.linkentity(self);
}
