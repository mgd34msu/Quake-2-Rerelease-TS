// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_flipper.cpp / m_flipper.h -- FLIPPER (2023 Quake II re-release / "KEX"
// engine). Ported from ~/Projects/quake2-rerelease-dll/rerelease/m_flipper.cpp
// (384 lines, C++17) and m_flipper.h (172 lines, 160-entry frame enum plus
// MODEL_SCALE). Behavioral code, ported bug-for-bug per PORTING.md.
//
// Frame constants below are a straight transcription of m_flipper.h's
// anonymous enum (single block, FRAME_flpbit01 = 0 through FRAME_flpdth56 =
// 159, strictly sequential) -- generated mechanically from the header and
// spot-checked against the source, not retyped by hand.
//
// ============================================================================
// M_CheckGib -- placement-mismatch helper, ported locally
// ============================================================================
// `inline bool M_CheckGib(edict_t*, const mod_t&)` (g_local.h:3520-3528) is a
// header-inline used by every monster's die() function, not by g_monster.cpp
// itself, so no earlier kexgame unit had a reason to port it yet. Following
// g_monster.ts's own precedent for "declared in g_local.h, needed here
// first" helpers, it is ported locally as a small non-exported function --
// exactly the C++ inline-per-translation-unit shape (each .cpp that includes
// g_local.h gets its own copy; each of this task's six monster files gets
// its own copy for the same reason, since this unit's file scope is the six
// monster modules only, not g_local.ts).
//
// ============================================================================
// KEX alternate-flying mechanics (AI_ALTERNATE_FLY)
// ============================================================================
// Flipper is a swimmonster using `monsterinfo.fly_*` hover parameters
// (fly_thrusters=false, fly_acceleration=30, fly_speed=110, fly_min/max_
// distance=10 -- melee-only, so it closes to point-blank) and
// `AI_ALTERNATE_FLY`, both [Paril-KEX] additions absent from the vanilla
// (id Software) m_flipper.c this same directory's legacy src/game/m_flipper.ts
// ported. No other KEX-only content in this file (no tank-commander-style
// variant, no blindfire, no reinforcements).

import { vec3, type Vec3 } from "../shared/math";
import { CHAN_VOICE, CHAN_WEAPON, ATTN_NORM } from "../shared/q_shared";
import { SvflagsT, SolidT } from "../kexapi/game";
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
  ModIdT,
  GibTypeT,
  MELEE_DISTANCE,
} from "./g_local";
import { gi, level } from "./g_main_globals";
import { Gtime_add, Gtime_from_sec } from "./gtime";
import { brandom } from "./q_std";
import { G_FreeEdict } from "./g_utils";
import { st } from "./g_spawn";
import { ai_stand, ai_walk, ai_run, ai_charge, ai_move } from "./g_ai";
import { M_SetAnimation, M_AllowSpawn, M_ShouldReactToPain, monster_dead, swimmonster_start } from "./g_monster";
import { fire_hit } from "./g_weapon";
import { ThrowGibs, type GibDefT } from "./g_misc";
import {
  RegisterDie,
  RegisterPain,
  RegisterMonsterinfoStand,
  RegisterMonsterinfoWalk,
  RegisterMonsterinfoRun,
  RegisterMonsterinfoMelee,
  RegisterMonsterinfoSight,
  RegisterMonsterinfoSetskin,
  RegisterMmove,
} from "./g_save_registry";

// ---------------------------------------------------------------------------
// m_flipper.h frame constants (generated from the enum, see file header)
// ---------------------------------------------------------------------------

export const FRAME_flpbit01 = 0;
export const FRAME_flpbit02 = 1;
export const FRAME_flpbit03 = 2;
export const FRAME_flpbit04 = 3;
export const FRAME_flpbit05 = 4;
export const FRAME_flpbit06 = 5;
export const FRAME_flpbit07 = 6;
export const FRAME_flpbit08 = 7;
export const FRAME_flpbit09 = 8;
export const FRAME_flpbit10 = 9;
export const FRAME_flpbit11 = 10;
export const FRAME_flpbit12 = 11;
export const FRAME_flpbit13 = 12;
export const FRAME_flpbit14 = 13;
export const FRAME_flpbit15 = 14;
export const FRAME_flpbit16 = 15;
export const FRAME_flpbit17 = 16;
export const FRAME_flpbit18 = 17;
export const FRAME_flpbit19 = 18;
export const FRAME_flpbit20 = 19;
export const FRAME_flptal01 = 20;
export const FRAME_flptal02 = 21;
export const FRAME_flptal03 = 22;
export const FRAME_flptal04 = 23;
export const FRAME_flptal05 = 24;
export const FRAME_flptal06 = 25;
export const FRAME_flptal07 = 26;
export const FRAME_flptal08 = 27;
export const FRAME_flptal09 = 28;
export const FRAME_flptal10 = 29;
export const FRAME_flptal11 = 30;
export const FRAME_flptal12 = 31;
export const FRAME_flptal13 = 32;
export const FRAME_flptal14 = 33;
export const FRAME_flptal15 = 34;
export const FRAME_flptal16 = 35;
export const FRAME_flptal17 = 36;
export const FRAME_flptal18 = 37;
export const FRAME_flptal19 = 38;
export const FRAME_flptal20 = 39;
export const FRAME_flptal21 = 40;
export const FRAME_flphor01 = 41;
export const FRAME_flphor02 = 42;
export const FRAME_flphor03 = 43;
export const FRAME_flphor04 = 44;
export const FRAME_flphor05 = 45;
export const FRAME_flphor06 = 46;
export const FRAME_flphor07 = 47;
export const FRAME_flphor08 = 48;
export const FRAME_flphor09 = 49;
export const FRAME_flphor10 = 50;
export const FRAME_flphor11 = 51;
export const FRAME_flphor12 = 52;
export const FRAME_flphor13 = 53;
export const FRAME_flphor14 = 54;
export const FRAME_flphor15 = 55;
export const FRAME_flphor16 = 56;
export const FRAME_flphor17 = 57;
export const FRAME_flphor18 = 58;
export const FRAME_flphor19 = 59;
export const FRAME_flphor20 = 60;
export const FRAME_flphor21 = 61;
export const FRAME_flphor22 = 62;
export const FRAME_flphor23 = 63;
export const FRAME_flphor24 = 64;
export const FRAME_flpver01 = 65;
export const FRAME_flpver02 = 66;
export const FRAME_flpver03 = 67;
export const FRAME_flpver04 = 68;
export const FRAME_flpver05 = 69;
export const FRAME_flpver06 = 70;
export const FRAME_flpver07 = 71;
export const FRAME_flpver08 = 72;
export const FRAME_flpver09 = 73;
export const FRAME_flpver10 = 74;
export const FRAME_flpver11 = 75;
export const FRAME_flpver12 = 76;
export const FRAME_flpver13 = 77;
export const FRAME_flpver14 = 78;
export const FRAME_flpver15 = 79;
export const FRAME_flpver16 = 80;
export const FRAME_flpver17 = 81;
export const FRAME_flpver18 = 82;
export const FRAME_flpver19 = 83;
export const FRAME_flpver20 = 84;
export const FRAME_flpver21 = 85;
export const FRAME_flpver22 = 86;
export const FRAME_flpver23 = 87;
export const FRAME_flpver24 = 88;
export const FRAME_flpver25 = 89;
export const FRAME_flpver26 = 90;
export const FRAME_flpver27 = 91;
export const FRAME_flpver28 = 92;
export const FRAME_flpver29 = 93;
export const FRAME_flppn101 = 94;
export const FRAME_flppn102 = 95;
export const FRAME_flppn103 = 96;
export const FRAME_flppn104 = 97;
export const FRAME_flppn105 = 98;
export const FRAME_flppn201 = 99;
export const FRAME_flppn202 = 100;
export const FRAME_flppn203 = 101;
export const FRAME_flppn204 = 102;
export const FRAME_flppn205 = 103;
export const FRAME_flpdth01 = 104;
export const FRAME_flpdth02 = 105;
export const FRAME_flpdth03 = 106;
export const FRAME_flpdth04 = 107;
export const FRAME_flpdth05 = 108;
export const FRAME_flpdth06 = 109;
export const FRAME_flpdth07 = 110;
export const FRAME_flpdth08 = 111;
export const FRAME_flpdth09 = 112;
export const FRAME_flpdth10 = 113;
export const FRAME_flpdth11 = 114;
export const FRAME_flpdth12 = 115;
export const FRAME_flpdth13 = 116;
export const FRAME_flpdth14 = 117;
export const FRAME_flpdth15 = 118;
export const FRAME_flpdth16 = 119;
export const FRAME_flpdth17 = 120;
export const FRAME_flpdth18 = 121;
export const FRAME_flpdth19 = 122;
export const FRAME_flpdth20 = 123;
export const FRAME_flpdth21 = 124;
export const FRAME_flpdth22 = 125;
export const FRAME_flpdth23 = 126;
export const FRAME_flpdth24 = 127;
export const FRAME_flpdth25 = 128;
export const FRAME_flpdth26 = 129;
export const FRAME_flpdth27 = 130;
export const FRAME_flpdth28 = 131;
export const FRAME_flpdth29 = 132;
export const FRAME_flpdth30 = 133;
export const FRAME_flpdth31 = 134;
export const FRAME_flpdth32 = 135;
export const FRAME_flpdth33 = 136;
export const FRAME_flpdth34 = 137;
export const FRAME_flpdth35 = 138;
export const FRAME_flpdth36 = 139;
export const FRAME_flpdth37 = 140;
export const FRAME_flpdth38 = 141;
export const FRAME_flpdth39 = 142;
export const FRAME_flpdth40 = 143;
export const FRAME_flpdth41 = 144;
export const FRAME_flpdth42 = 145;
export const FRAME_flpdth43 = 146;
export const FRAME_flpdth44 = 147;
export const FRAME_flpdth45 = 148;
export const FRAME_flpdth46 = 149;
export const FRAME_flpdth47 = 150;
export const FRAME_flpdth48 = 151;
export const FRAME_flpdth49 = 152;
export const FRAME_flpdth50 = 153;
export const FRAME_flpdth51 = 154;
export const FRAME_flpdth52 = 155;
export const FRAME_flpdth53 = 156;
export const FRAME_flpdth54 = 157;
export const FRAME_flpdth55 = 158;
export const FRAME_flpdth56 = 159;

export const MODEL_SCALE = 1.0;

// ---------------------------------------------------------------------------
// M_CheckGib -- see file header
// ---------------------------------------------------------------------------

function M_CheckGib(self: EdictT, mod: ModT): boolean {
  if (self.deadflag) {
    if (mod.id === ModIdT.MOD_CRUSH) return true;
  }
  return self.health <= self.gib_health;
}

// ---------------------------------------------------------------------------
// local mframe_t / mmove_t helpers (see g_local_types.ts: MframeT is a plain
// interface, not a class; MmoveT's frame-count validation happens in its
// setter)
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

let sound_chomp = 0;
let sound_attack = 0;
let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_death = 0;
let sound_idle = 0;
let sound_search = 0;
let sound_sight = 0;

// ---------------------------------------------------------------------------
// stand (m_flipper.cpp:23-32)
// ---------------------------------------------------------------------------

const flipper_frames_stand: MframeT[] = [frame(ai_stand)];
const flipper_move_stand = RegisterMmove("flipper_move_stand", move(FRAME_flphor01, FRAME_flphor01, flipper_frames_stand));

const flipper_stand = RegisterMonsterinfoStand("flipper_stand", (self: EdictT): void => {
  M_SetAnimation(self, flipper_move_stand, true);
});

// ---------------------------------------------------------------------------
// run (m_flipper.cpp:34-84)
// ---------------------------------------------------------------------------

const FLIPPER_RUN_SPEED = 24;

const flipper_frames_run: MframeT[] = Array.from({ length: 24 }, () => frame(ai_run, FLIPPER_RUN_SPEED));
const flipper_move_run_loop = RegisterMmove("flipper_move_run_loop", move(FRAME_flpver06, FRAME_flpver29, flipper_frames_run));

function flipper_run_loop(self: EdictT): void {
  M_SetAnimation(self, flipper_move_run_loop, true);
}

const flipper_frames_run_start: MframeT[] = [frame(ai_run, 8), frame(ai_run, 8), frame(ai_run, 8), frame(ai_run, 8), frame(ai_run, 8), frame(ai_run, 8)];
const flipper_move_run_start = RegisterMmove(
  "flipper_move_run_start",
  move(FRAME_flpver01, FRAME_flpver06, flipper_frames_run_start, flipper_run_loop),
);

function flipper_run(self: EdictT): void {
  M_SetAnimation(self, flipper_move_run_start, true);
}

// ---------------------------------------------------------------------------
// walk (m_flipper.cpp:86-118)
// ---------------------------------------------------------------------------

const flipper_frames_walk: MframeT[] = Array.from({ length: 24 }, () => frame(ai_walk, 4));
const flipper_move_walk = RegisterMmove("flipper_move_walk", move(FRAME_flphor01, FRAME_flphor24, flipper_frames_walk));

const flipper_walk = RegisterMonsterinfoWalk("flipper_walk", (self: EdictT): void => {
  M_SetAnimation(self, flipper_move_walk, true);
});

// ---------------------------------------------------------------------------
// start_run (m_flipper.cpp:120-132)
// ---------------------------------------------------------------------------

const flipper_frames_start_run: MframeT[] = [frame(ai_run), frame(ai_run), frame(ai_run), frame(ai_run), frame(ai_run, 8, flipper_run)];
const flipper_move_start_run = RegisterMmove("flipper_move_start_run", move(FRAME_flphor01, FRAME_flphor05, flipper_frames_start_run));

const flipper_start_run = RegisterMonsterinfoRun("flipper_start_run", (self: EdictT): void => {
  M_SetAnimation(self, flipper_move_start_run, true);
});

// ---------------------------------------------------------------------------
// pain (m_flipper.cpp:134-214)
// ---------------------------------------------------------------------------

const flipper_frames_pain2: MframeT[] = Array.from({ length: 5 }, () => frame(ai_move));
const flipper_move_pain2 = RegisterMmove("flipper_move_pain2", move(FRAME_flppn101, FRAME_flppn105, flipper_frames_pain2, flipper_run));

const flipper_frames_pain1: MframeT[] = Array.from({ length: 5 }, () => frame(ai_move));
const flipper_move_pain1 = RegisterMmove("flipper_move_pain1", move(FRAME_flppn201, FRAME_flppn205, flipper_frames_pain1, flipper_run));

function flipper_bite(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, 0, 0);
  fire_hit(self, aim, 5, 0);
}

function flipper_preattack(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_chomp, 1, ATTN_NORM, 0);
}

const flipper_frames_attack: MframeT[] = [
  frame(ai_charge, 0, flipper_preattack),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, flipper_bite),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, flipper_bite),
  frame(ai_charge),
];
const flipper_move_attack = RegisterMmove("flipper_move_attack", move(FRAME_flpbit01, FRAME_flpbit20, flipper_frames_attack, flipper_run));

const flipper_melee = RegisterMonsterinfoMelee("flipper_melee", (self: EdictT): void => {
  M_SetAnimation(self, flipper_move_attack, true);
});

const flipper_pain = RegisterPain("flipper_pain", (self: EdictT, _other: EdictT, _kick: number, _damage: number, mod: ModT): void => {
  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));
  const n = brandom();

  if (!n) gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);

  if (!M_ShouldReactToPain(self, mod)) return; // no pain anims in nightmare

  if (!n) M_SetAnimation(self, flipper_move_pain1, true);
  else M_SetAnimation(self, flipper_move_pain2, true);
});

// ---------------------------------------------------------------------------
// setskin / death (m_flipper.cpp:216-325)
// ---------------------------------------------------------------------------

const flipper_setskin = RegisterMonsterinfoSetskin("flipper_setskin", (self: EdictT): void => {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;
  else self.s.skinnum = 0;
});

function flipper_dead(self: EdictT): void {
  self.mins = vec3(-16, -16, -8);
  self.maxs = vec3(16, 16, 8);
  monster_dead(self);
}

const flipper_frames_death: MframeT[] = Array.from({ length: 56 }, () => frame(ai_move));
const flipper_move_death = RegisterMmove("flipper_move_death", move(FRAME_flpdth01, FRAME_flpdth56, flipper_frames_death, flipper_dead));

const flipper_sight = RegisterMonsterinfoSight("flipper_sight", (self: EdictT, _other: EdictT): void => {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
});

const flipper_die = RegisterDie(
  "flipper_die",
  (self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3, mod: ModT): void => {
    // check for gib
    if (M_CheckGib(self, mod)) {
      gi.sound(self, CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
      const gibs: GibDefT[] = [
        { gibname: "models/objects/gibs/bone/tris.md2", count: 2 },
        { gibname: "models/objects/gibs/sm_meat/tris.md2", count: 2 },
        { gibname: "models/objects/gibs/head2/tris.md2", type: GibTypeT.GIB_HEAD },
      ];
      ThrowGibs(self, damage, gibs);
      self.deadflag = true;
      return;
    }

    if (self.deadflag) return;

    // regular death
    gi.sound(self, CHAN_VOICE, sound_death, 1, ATTN_NORM, 0);
    self.deadflag = true;
    self.takedamage = true;
    self.svflags |= SvflagsT.SVF_DEADMONSTER;
    M_SetAnimation(self, flipper_move_death, true);
  },
);

// ---------------------------------------------------------------------------
// spawn (m_flipper.cpp:327-384)
// ---------------------------------------------------------------------------

function flipper_set_fly_parameters(self: EdictT): void {
  self.monsterinfo.fly_thrusters = false;
  self.monsterinfo.fly_acceleration = 30.0;
  self.monsterinfo.fly_speed = 110.0;
  // only melee, so get in close
  self.monsterinfo.fly_min_distance = 10.0;
  self.monsterinfo.fly_max_distance = 10.0;
}

/**
 * QUAKED monster_flipper (1 .5 0) (-16 -16 -24) (16 16 32) Ambush
 * Trigger_Spawn Sight
 */
export function SP_monster_flipper(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  sound_pain1 = gi.soundindex("flipper/flppain1.wav");
  sound_pain2 = gi.soundindex("flipper/flppain2.wav");
  sound_death = gi.soundindex("flipper/flpdeth1.wav");
  sound_chomp = gi.soundindex("flipper/flpatck1.wav");
  sound_attack = gi.soundindex("flipper/flpatck2.wav");
  sound_idle = gi.soundindex("flipper/flpidle1.wav");
  sound_search = gi.soundindex("flipper/flpsrch1.wav");
  sound_sight = gi.soundindex("flipper/flpsght1.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/flipper/tris.md2");
  self.mins = vec3(-16, -16, -8);
  self.maxs = vec3(16, 16, 20);

  self.health = Math.trunc(50 * st.health_multiplier);
  self.gib_health = -30;
  self.mass = 100;

  self.pain = flipper_pain;
  self.die = flipper_die;

  self.monsterinfo.stand = flipper_stand;
  self.monsterinfo.walk = flipper_walk;
  self.monsterinfo.run = flipper_start_run;
  self.monsterinfo.melee = flipper_melee;
  self.monsterinfo.sight = flipper_sight;
  self.monsterinfo.setskin = flipper_setskin;

  gi.linkentity(self);

  M_SetAnimation(self, flipper_move_stand, true);
  self.monsterinfo.scale = MODEL_SCALE;

  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_ALTERNATE_FLY;
  flipper_set_fly_parameters(self);

  swimmonster_start(self);
}
