// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_arachnid.cpp / m_arachnid.h -- ARACHNID (2023 Quake II re-release /
// "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/m_arachnid.cpp (386 lines,
// C++17) and m_arachnid.h (142 lines, 131-entry frame enum plus
// MODEL_SCALE). Behavioral code, ported bug-for-bug per PORTING.md.
//
// NEW re-release monster -- no legacy vanilla-Q2 precedent anywhere in this
// repo. Despite the C++ source's own file-header comment banner reading
// "TANK" (a leftover copy/paste from a template file, not a real code
// reference to m_tank.cpp -- this file has nothing to do with the tank
// monster), it is a rail-cannon spider: a level-fire rail attack
// (`arachnid_attack1`), a raised/upward-angle rail attack for enemies well
// above it (`arachnid_attack_up1`), and a claw melee.
//
// ============================================================================
// OTHER NOTED DEVIATIONS / QUIRKS (bug-for-bug, not "fixed")
// ============================================================================
// - `SP_monster_arachnid` assigns `sound_step.assign("insane/insane11.wav")`
//   -- a misc_insane fist-thump sound reused verbatim for this spider's
//   footstep, not a dedicated arachnid step sample. Preserved exactly, not
//   corrected to a plausible arachnid sound.
// - `sound_melee_hit` (m_arachnid.cpp:232, `gladiator/melee2.wav`) is
//   assigned in `SP_monster_arachnid` but never referenced by any gi.sound
//   call anywhere in this file -- `arachnid_melee_hit`'s own attack-landed
//   sound is silent (no `gi.sound` call at all on a successful `fire_hit`,
//   unlike `arachnid_melee_charge`, which does play `sound_melee`). This is
//   a genuine dead assignment in the shipped C++ source; preserved exactly,
//   not wired up.
// - `arachnid_attack`'s melee-range gate uses `<` (`range_to(...) <
//   MELEE_DISTANCE`) while its "enemy well above" gate uses `>` (`(enemy.z -
//   self.z) > 150`) -- both strict inequalities, no `<=`/`>=` anywhere;
//   preserved exactly.
// - `arachnid_rail`'s frame-based flash-id `switch` has `FRAME_rails4` as
//   both an explicit case AND the implicit `default:` fallthrough target
//   (`case FRAME_rails4: default: id = MZ2_ARACHNID_RAIL1; break;`) -- i.e.
//   ANY frame not exactly `FRAME_rails8`/`FRAME_rails_up7`/
//   `FRAME_rails_up11` resolves to `MZ2_ARACHNID_RAIL1`, not just
//   `FRAME_rails4` itself. Ported as an if/else-if chain ending in a bare
//   `else`, preserving the identical fallthrough semantics (not a literal
//   `switch`, since TS `switch` fallthrough-to-default-only-on-a-named-case
//   reads awkwardly; the resulting id selection is identical for every input
//   frame).
//
// ============================================================================
// PLACEMENT-MISMATCH FUNCTIONS PORTED LOCALLY -- see m_gladiator.ts header
// ============================================================================
// - `M_CheckGib` (g_local.h:3521, `inline`) -- reimplemented locally, exactly
//   m_gladiator.ts's/m_berserk.ts's own copies.

import { vec3, type Vec3 } from "../shared/math";
import { CHAN_VOICE, CHAN_BODY, CHAN_WEAPON, ATTN_NORM, ATTN_IDLE } from "../shared/q_shared";
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
import { Gtime_add, Gtime_from_sec, Gtime_from_ms, GTIME_ZERO } from "./gtime";
import { AngleVectors_destructured, vec3_sub, vec3_normalized } from "./q_vec3";
import { G_FreeEdict } from "./g_utils";
import { st } from "./g_spawn";
import { frandom } from "./q_std";
import { ai_stand, ai_walk, ai_run, ai_move, ai_charge, range_to } from "./g_ai";
import { M_SetAnimation, M_AllowSpawn, M_ProjectFlashSource, M_ShouldReactToPain, monster_fire_railgun, walkmonster_start } from "./g_monster";
import { fire_hit } from "./g_weapon";
import { ThrowGibs, type GibDefT } from "./g_misc";
import { monsterFlashOffset } from "./m_flash";
import { MonsterMuzzleflashIdT } from "../kexapi/game";
import {
  RegisterDie,
  RegisterPain,
  RegisterMonsterinfoStand,
  RegisterMonsterinfoWalk,
  RegisterMonsterinfoRun,
  RegisterMonsterinfoAttack,
  RegisterMonsterinfoSight,
  RegisterMmove,
} from "./g_save_registry";

// ---------------------------------------------------------------------------
// m_arachnid.h frame constants (generated from the enum, see file header)
// ---------------------------------------------------------------------------

export const FRAME_rails1 = 0;
export const FRAME_rails4 = 3;
export const FRAME_rails8 = 7;
export const FRAME_rails11 = 10;
export const FRAME_death1 = 11;
export const FRAME_death20 = 30;
export const FRAME_melee_atk1 = 31;
export const FRAME_melee_atk12 = 42;
export const FRAME_pain11 = 43;
export const FRAME_pain15 = 47;
export const FRAME_idle1 = 48;
export const FRAME_idle13 = 60;
export const FRAME_walk1 = 61;
export const FRAME_walk10 = 70;
export const FRAME_pain21 = 77;
export const FRAME_pain26 = 82;
export const FRAME_rails_up1 = 115;
export const FRAME_rails_up7 = 121;
export const FRAME_rails_up11 = 125;
export const FRAME_rails_up16 = 130;

export const MODEL_SCALE = 1.0;

// ---------------------------------------------------------------------------
// PLACEMENT-MISMATCH FUNCTIONS PORTED LOCALLY -- see file header
// ---------------------------------------------------------------------------

function M_CheckGib(self: EdictT, mod: ModT): boolean {
  if (self.deadflag) {
    if (mod.id === ModIdT.MOD_CRUSH) return true;
  }
  return self.health <= self.gib_health;
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

let sound_pain = 0;
let sound_death = 0;
let sound_sight = 0;
let sound_step = 0;
let sound_charge = 0;
let sound_melee = 0;
let sound_melee_hit = 0;
void sound_melee_hit; // assigned in SP_monster_arachnid, never read -- see file header DEVIATIONS

// ---------------------------------------------------------------------------
// sight / stand (m_arachnid.cpp:19-48)
// ---------------------------------------------------------------------------

const arachnid_sight = RegisterMonsterinfoSight("arachnid_sight", (self: EdictT, _other: EdictT): void => {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
});

const arachnid_frames_stand: MframeT[] = Array.from({ length: 13 }, () => frame(ai_stand));
const arachnid_move_stand = RegisterMmove("arachnid_move_stand", move(FRAME_idle1, FRAME_idle13, arachnid_frames_stand));

const arachnid_stand = RegisterMonsterinfoStand("arachnid_stand", (self: EdictT): void => {
  M_SetAnimation(self, arachnid_move_stand, true);
});

// ---------------------------------------------------------------------------
// walk / run (m_arachnid.cpp:50-107)
// ---------------------------------------------------------------------------

function arachnid_footstep(self: EdictT): void {
  gi.sound(self, CHAN_BODY, sound_step, 0.5, ATTN_IDLE, 0);
}

const arachnid_frames_walk: MframeT[] = [
  frame(ai_walk, 8, arachnid_footstep),
  frame(ai_walk, 8),
  frame(ai_walk, 8),
  frame(ai_walk, 8),
  frame(ai_walk, 8),
  frame(ai_walk, 8, arachnid_footstep),
  frame(ai_walk, 8),
  frame(ai_walk, 8),
  frame(ai_walk, 8),
  frame(ai_walk, 8),
];
const arachnid_move_walk = RegisterMmove("arachnid_move_walk", move(FRAME_walk1, FRAME_walk10, arachnid_frames_walk));

const arachnid_walk = RegisterMonsterinfoWalk("arachnid_walk", (self: EdictT): void => {
  M_SetAnimation(self, arachnid_move_walk, true);
});

const arachnid_frames_run: MframeT[] = [
  frame(ai_run, 8, arachnid_footstep),
  frame(ai_run, 8),
  frame(ai_run, 8),
  frame(ai_run, 8),
  frame(ai_run, 8),
  frame(ai_run, 8, arachnid_footstep),
  frame(ai_run, 8),
  frame(ai_run, 8),
  frame(ai_run, 8),
  frame(ai_run, 8),
];
const arachnid_move_run = RegisterMmove("arachnid_move_run", move(FRAME_walk1, FRAME_walk10, arachnid_frames_run));

const arachnid_run = RegisterMonsterinfoRun("arachnid_run", (self: EdictT): void => {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) {
    M_SetAnimation(self, arachnid_move_stand, true);
    return;
  }

  M_SetAnimation(self, arachnid_move_run, true);
});

// ---------------------------------------------------------------------------
// pain (m_arachnid.cpp:109-149)
// ---------------------------------------------------------------------------

const arachnid_frames_pain1: MframeT[] = Array.from({ length: 5 }, () => frame(ai_move));
const arachnid_move_pain1 = RegisterMmove("arachnid_move_pain1", move(FRAME_pain11, FRAME_pain15, arachnid_frames_pain1, arachnid_run));

const arachnid_frames_pain2: MframeT[] = Array.from({ length: 6 }, () => frame(ai_move));
const arachnid_move_pain2 = RegisterMmove("arachnid_move_pain2", move(FRAME_pain21, FRAME_pain26, arachnid_frames_pain2, arachnid_run));

const arachnid_pain = RegisterPain("arachnid_pain", (self: EdictT, _other: EdictT, _kick: number, _damage: number, mod: ModT): void => {
  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));
  gi.sound(self, CHAN_VOICE, sound_pain, 1, ATTN_NORM, 0);

  if (!M_ShouldReactToPain(self, mod)) return; // no pain anims in nightmare

  const r = frandom();

  if (r < 0.5) M_SetAnimation(self, arachnid_move_pain1, true);
  else M_SetAnimation(self, arachnid_move_pain2, true);
});

// ---------------------------------------------------------------------------
// rail attacks (m_arachnid.cpp:151-230)
// ---------------------------------------------------------------------------

function arachnid_charge_rail(self: EdictT): void {
  if (self.enemy === null || !self.enemy.inuse) return;

  gi.sound(self, CHAN_WEAPON, sound_charge, 1, ATTN_NORM, 0);
  self.pos1 = vec3(self.enemy.s.origin[0], self.enemy.s.origin[1], self.enemy.s.origin[2]);
  self.pos1[2] += self.enemy.viewheight;
}

function arachnid_rail(self: EdictT): void {
  let id: MonsterMuzzleflashIdT;

  // see file header DEVIATIONS: FRAME_rails4 is both an explicit case and
  // the implicit default fallthrough target in the C++ switch -- any frame
  // that isn't rails8/rails_up7/rails_up11 resolves to RAIL1.
  if (self.s.frame === FRAME_rails8) id = MonsterMuzzleflashIdT.MZ2_ARACHNID_RAIL2;
  else if (self.s.frame === FRAME_rails_up7) id = MonsterMuzzleflashIdT.MZ2_ARACHNID_RAIL_UP1;
  else if (self.s.frame === FRAME_rails_up11) id = MonsterMuzzleflashIdT.MZ2_ARACHNID_RAIL_UP2;
  else id = MonsterMuzzleflashIdT.MZ2_ARACHNID_RAIL1;

  const { forward, right } = AngleVectors_destructured(self.s.angles);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[id], forward, right);

  // calc direction to where we targeted
  const dir = vec3_normalized(vec3_sub(self.pos1, start));

  monster_fire_railgun(self, start, dir, 35, 100, id);
}

const arachnid_frames_attack1: MframeT[] = [
  frame(ai_charge, 0, arachnid_charge_rail),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, arachnid_rail),
  frame(ai_charge, 0, arachnid_charge_rail),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, arachnid_rail),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
];
const arachnid_attack1 = RegisterMmove("arachnid_attack1", move(FRAME_rails1, FRAME_rails11, arachnid_frames_attack1, arachnid_run));

const arachnid_frames_attack_up1: MframeT[] = [
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, arachnid_charge_rail),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, arachnid_rail),
  frame(ai_charge, 0, arachnid_charge_rail),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, arachnid_rail),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
];
const arachnid_attack_up1 = RegisterMmove("arachnid_attack_up1", move(FRAME_rails_up1, FRAME_rails_up16, arachnid_frames_attack_up1, arachnid_run));

// ---------------------------------------------------------------------------
// melee (m_arachnid.cpp:232-272)
// ---------------------------------------------------------------------------

function arachnid_melee_charge(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_melee, 1, ATTN_NORM, 0);
}

function arachnid_melee_hit(self: EdictT): void {
  if (!fire_hit(self, vec3(MELEE_DISTANCE, 0, 0), 15, 50)) {
    self.monsterinfo.melee_debounce_time = Gtime_add(level.time, Gtime_from_ms(1000));
  }
}

const arachnid_frames_melee: MframeT[] = [
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, arachnid_melee_charge),
  frame(ai_charge),
  frame(ai_charge, 0, arachnid_melee_hit),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, arachnid_melee_charge),
  frame(ai_charge),
  frame(ai_charge, 0, arachnid_melee_hit),
  frame(ai_charge),
];
const arachnid_melee = RegisterMmove("arachnid_melee", move(FRAME_melee_atk1, FRAME_melee_atk12, arachnid_frames_melee, arachnid_run));

const arachnid_attack = RegisterMonsterinfoAttack("arachnid_attack", (self: EdictT): void => {
  if (self.enemy === null || !self.enemy.inuse) return;

  if (self.monsterinfo.melee_debounce_time < level.time && range_to(self, self.enemy) < MELEE_DISTANCE) {
    M_SetAnimation(self, arachnid_melee, true);
  } else if (self.enemy.s.origin[2] - self.s.origin[2] > 150) {
    M_SetAnimation(self, arachnid_attack_up1, true);
  } else {
    M_SetAnimation(self, arachnid_attack1, true);
  }
});

// ---------------------------------------------------------------------------
// death (m_arachnid.cpp:274-336)
// ---------------------------------------------------------------------------

function arachnid_dead(self: EdictT): void {
  self.mins = vec3(-16, -16, -24);
  self.maxs = vec3(16, 16, -8);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SvflagsT.SVF_DEADMONSTER;
  self.nextthink = GTIME_ZERO;
  gi.linkentity(self);
}

const arachnid_frames_death1: MframeT[] = [
  frame(ai_move, 0),
  frame(ai_move, -1.23),
  frame(ai_move, -1.23),
  frame(ai_move, -1.23),
  frame(ai_move, -1.23),
  frame(ai_move, -1.64),
  frame(ai_move, -1.64),
  frame(ai_move, -2.45),
  frame(ai_move, -8.63),
  frame(ai_move, -4.0),
  frame(ai_move, -4.5),
  frame(ai_move, -6.8),
  frame(ai_move, -8.0),
  frame(ai_move, -5.4),
  frame(ai_move, -3.4),
  frame(ai_move, -1.9),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
];
const arachnid_move_death = RegisterMmove("arachnid_move_death", move(FRAME_death1, FRAME_death20, arachnid_frames_death1, arachnid_dead));

const arachnid_die = RegisterDie(
  "arachnid_die",
  (self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3, mod: ModT): void => {
    // check for gib
    if (M_CheckGib(self, mod)) {
      gi.sound(self, CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
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
    gi.sound(self, CHAN_VOICE, sound_death, 1, ATTN_NORM, 0);
    self.deadflag = true;
    self.takedamage = true;

    M_SetAnimation(self, arachnid_move_death, true);
  },
);

// ---------------------------------------------------------------------------
// monster_arachnid (m_arachnid.cpp:338-385)
// ---------------------------------------------------------------------------

/**
 * QUAKED monster_arachnid (1 .5 0) (-48 -48 -20) (48 48 48) Ambush
 * Trigger_Spawn Sight
 */
export function SP_monster_arachnid(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  sound_step = gi.soundindex("insane/insane11.wav");
  sound_charge = gi.soundindex("gladiator/railgun.wav");
  sound_melee = gi.soundindex("gladiator/melee3.wav");
  sound_melee_hit = gi.soundindex("gladiator/melee2.wav");
  sound_pain = gi.soundindex("arachnid/pain.wav");
  sound_death = gi.soundindex("arachnid/death.wav");
  sound_sight = gi.soundindex("arachnid/sight.wav");

  self.s.modelindex = gi.modelindex("models/monsters/arachnid/tris.md2");
  self.mins = vec3(-48, -48, -20);
  self.maxs = vec3(48, 48, 48);
  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;

  self.health = Math.trunc(1000 * st.health_multiplier);
  self.gib_health = -200;

  self.monsterinfo.scale = MODEL_SCALE;

  self.mass = 450;

  self.pain = arachnid_pain;
  self.die = arachnid_die;
  self.monsterinfo.stand = arachnid_stand;
  self.monsterinfo.walk = arachnid_walk;
  self.monsterinfo.run = arachnid_run;
  self.monsterinfo.attack = arachnid_attack;
  self.monsterinfo.sight = arachnid_sight;

  gi.linkentity(self);

  M_SetAnimation(self, arachnid_move_stand, true);

  walkmonster_start(self);
}
