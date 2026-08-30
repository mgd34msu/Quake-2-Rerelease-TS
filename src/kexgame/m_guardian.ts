// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_guardian.cpp / m_guardian.h -- GUARDIAN (2023 Quake II re-release /
// "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/m_guardian.cpp (524 lines,
// C++17) and m_guardian.h (225 lines, 215-entry frame enum plus
// MODEL_SCALE). Behavioral code, ported bug-for-bug per PORTING.md.
//
// NEW re-release monster -- no legacy vanilla-Q2 precedent anywhere in this
// repo. A three-attack boss: a spinning hyperblaster attack (`guardian_atk1`
// family), a sweeping laser attack (`guardian_atk2` family, via the
// xatrix `monster_fire_dabeam` "dabeam" primitive -- see EXTERNAL
// DEPENDENCIES below), and a melee kick.
//
// ============================================================================
// EXTERNAL DEPENDENCIES NOT YET PORTED, AND HOW EACH IS HANDLED
// ============================================================================
// - `monster_fire_dabeam`/`dabeam_update` (xatrix/g_xatrix_monster.cpp:
//   112/84): STUB SWAP (xatrix unit) -- g_xatrix_monster.ts has now landed
//   as the real home of both. The local throwing stubs that used to live
//   here are DELETED and replaced with `import { dabeam_update,
//   monster_fire_dabeam } from "./g_xatrix_monster"`. `guardian_attack`'s
//   atk2 (laser) branch (picked whenever the enemy is farther than
//   `RANGE_NEAR`, 440 units) now genuinely fires: `guardian_fire_update`
//   (already ported for real below, unchanged) is no longer dead code.
// - `guardian_fire_update` (the PRETHINK callback passed to
//   `monster_fire_dabeam`) IS ported for real below, even though the stub
//   above means `monster_fire_dabeam` never actually schedules it today --
//   matching m_brain.ts's own `brain_right_eye_laser_update`/
//   `brain_left_eye_laser_update` precedent ("port for real code that is
//   only reachable via a currently-stubbed path, not deleted"). Registered
//   under its real save name via `RegisterPrethink` so a future xatrix unit
//   can wire `monster_fire_dabeam` straight through with zero changes here.
// - `BossExplode` (rogue/g_rogue_newai.cpp): imported for real from
//   m_supertank.ts, this porting batch's canonical exported home (see that
//   file's own header) -- not re-implemented locally. Used as
//   `guardian_move_death`'s first-frame thinkfunc, exactly like
//   m_supertank.ts's/m_boss2.ts's/m_boss31.ts's own death tables.
//
// ============================================================================
// OTHER NOTED DEVIATIONS / QUIRKS (bug-for-bug, not "fixed")
// ============================================================================
// - `guardian_kick`'s aim vector is `{ MELEE_DISTANCE, 0, -80 }` -- a fixed
//   width of 0 (NOT `self->mins[0]`, unlike m_shambler.ts's melee, which
//   does use `self->mins[0]`) -- preserved exactly, not harmonized.
// - `guardian_fire_blaster`'s `EF_HYPERBLASTER` toggle is `(self->s.frame %
//   4) ? EF_NONE : EF_HYPERBLASTER` -- every 4th blaster shot in the spin
//   gets the hyperblaster muzzle glow effect, not every shot; preserved
//   exactly.
// - `guardian_fire_blaster`'s mid-loop "keep firing" check re-enters the
//   spin animation via `self->monsterinfo.nextframe = FRAME_atk1_spin5`
//   ONLY when `self->s.frame == FRAME_atk1_spin12` AND `self->timestamp >
//   level.time` (a charge-duration timer set by `guardian_atk1`) AND the
//   enemy is still visible -- a data-driven "keep spinning while charged
//   and target is visible" loop, not a fixed-length attack; preserved
//   exactly.
// - `guardian_pain`'s three "don't interrupt an attack" frame-range guards
//   run BEFORE `M_ShouldReactToPain`, i.e. hard/nightmare pain suppression
//   during attacks is unconditional (skill-independent), while the
//   final `M_ShouldReactToPain` check (which itself already skips pain
//   animations on nightmare, per its own body) runs after -- both checks
//   preserved exactly, not merged or reordered.
// - `guardian_explode`'s temp-entity write and `guardian_dead`'s gib throw
//   both run every death (not gated behind `M_CheckGib`/a health threshold,
//   unlike most other monsters in this batch) -- `guardian_die` itself never
//   checks for a "gib" vs. "die" split at all, always animating through
//   `guardian_move_death` whose SOLE frame-1 thinkfunc is `BossExplode`
//   (a *continuous* explosion-puff spawner, distinct from `guardian_explode`,
//   which is `guardian_dead`'s one-shot triple TE_EXPLOSION1_BIG burst) --
//   preserved exactly, not merged.
//
// ============================================================================
// PLACEMENT-MISMATCH FUNCTIONS PORTED LOCALLY -- see m_gladiator.ts header
// ============================================================================
// - `monster_footstep` is NOT reused here -- `guardian_footstep` is this
//   monster's own named per-file callback (matches the C++ source's own
//   `guardian_footstep`, a real gi.sound call keyed to `sound_step`, not the
//   shared `g_local.h:3282` inline helper other files reuse under the
//   generic name).

import { vec3, type Vec3 } from "../shared/math";
import { CHAN_WEAPON, CHAN_BODY, ATTN_NORM } from "../shared/q_shared";
import { SvflagsT, SolidT, EffectsT, KexMulticastT, ServerCommandT, KexTempEventT } from "../kexapi/game";
import {
  type EdictT,
  type MframeAifuncFn,
  type MframeThinkfuncFn,
  type MmoveEndfuncFn,
  type ModT,
  type PrethinkFn,
  MframeT,
  MmoveT,
  MonsterAiFlagsT,
  MovetypeT,
  ModIdT,
  GibTypeT,
  RANGE_NEAR,
  MELEE_DISTANCE,
  random_time,
} from "./g_local";
import { gi, level } from "./g_main_globals";
import { Gtime_add, Gtime_from_sec, Gtime_from_ms } from "./gtime";
import { frandom, crandom_open } from "./q_std";
import { AngleVectors_destructured, vec3_add, vec3_sub, vec3_muls, vec3_normalized } from "./q_vec3";
import { G_FreeEdict } from "./g_utils";
import { st } from "./g_spawn";
import { ai_stand, ai_walk, ai_run, ai_move, ai_charge, range_to, visible } from "./g_ai";
import { M_SetAnimation, M_AllowSpawn, M_ProjectFlashSource, M_ShouldReactToPain, monster_fire_blaster, walkmonster_start } from "./g_monster";
import { fire_hit } from "./g_weapon";
import { ThrowGibs, type GibDefT } from "./g_misc";
import { BossExplode } from "./m_supertank";
import { dabeam_update, monster_fire_dabeam } from "./g_xatrix_monster";
import { monsterFlashOffset } from "./m_flash";
import { MonsterMuzzleflashIdT } from "../kexapi/game";
import {
  RegisterDie,
  RegisterPain,
  RegisterPrethink,
  RegisterMonsterinfoStand,
  RegisterMonsterinfoWalk,
  RegisterMonsterinfoRun,
  RegisterMonsterinfoAttack,
  RegisterMmove,
} from "./g_save_registry";

// ---------------------------------------------------------------------------
// m_guardian.h frame constants (generated from the enum, see file header)
// ---------------------------------------------------------------------------

export const FRAME_death1 = 14;
export const FRAME_death26 = 39;
export const FRAME_atk1_out1 = 40;
export const FRAME_atk1_out3 = 42;
export const FRAME_atk2_out1 = 43;
export const FRAME_atk2_out7 = 49;
export const FRAME_pain1_1 = 62;
export const FRAME_pain1_8 = 69;
export const FRAME_idle1 = 70;
export const FRAME_idle52 = 121;
export const FRAME_atk1_in1 = 122;
export const FRAME_atk1_in3 = 124;
export const FRAME_kick_in1 = 125;
export const FRAME_kick_in13 = 137;
export const FRAME_walk1 = 138;
export const FRAME_walk19 = 156;
export const FRAME_atk1_spin1 = 162;
export const FRAME_atk1_spin5 = 166;
export const FRAME_atk1_spin12 = 173;
export const FRAME_atk1_spin15 = 176;
export const FRAME_atk2_fire1 = 177;
export const FRAME_atk2_fire4 = 180;
export const FRAME_atk2_in1 = 203;
export const FRAME_atk2_in12 = 214;

export const MODEL_SCALE = 1.0;

// ---------------------------------------------------------------------------
// EXTERNAL DEPENDENCIES NOT YET PORTED -- see file header
// ---------------------------------------------------------------------------

// dabeam_update / monster_fire_dabeam: real imports from g_xatrix_monster.ts
// -- see file header "STUB SWAP (xatrix unit)".

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

let sound_step = 0;
let sound_charge = 0;
let sound_spin_loop = 0;
let sound_laser = 0;

// ---------------------------------------------------------------------------
// stand (m_guardian.cpp:15-78)
// ---------------------------------------------------------------------------

const guardian_frames_stand: MframeT[] = Array.from({ length: 52 }, () => frame(ai_stand));
const guardian_move_stand = RegisterMmove("guardian_move_stand", move(FRAME_idle1, FRAME_idle52, guardian_frames_stand));

const guardian_stand = RegisterMonsterinfoStand("guardian_stand", (self: EdictT): void => {
  M_SetAnimation(self, guardian_move_stand, true);
});

// ---------------------------------------------------------------------------
// walk / run (m_guardian.cpp:80-155)
// ---------------------------------------------------------------------------

function guardian_footstep(self: EdictT): void {
  gi.sound(self, CHAN_BODY, sound_step, 1, ATTN_NORM, 0);
}

const guardian_frames_walk: MframeT[] = [
  frame(ai_walk, 8),
  frame(ai_walk, 8),
  frame(ai_walk, 8),
  frame(ai_walk, 8),
  frame(ai_walk, 8),
  frame(ai_walk, 8),
  frame(ai_walk, 8),
  frame(ai_walk, 8, guardian_footstep),
  frame(ai_walk, 8),
  frame(ai_walk, 8),
  frame(ai_walk, 8),
  frame(ai_walk, 8),
  frame(ai_walk, 8),
  frame(ai_walk, 8),
  frame(ai_walk, 8),
  frame(ai_walk, 8),
  frame(ai_walk, 8),
  frame(ai_walk, 8, guardian_footstep),
  frame(ai_walk, 8),
];
const guardian_move_walk = RegisterMmove("guardian_move_walk", move(FRAME_walk1, FRAME_walk19, guardian_frames_walk));

const guardian_walk = RegisterMonsterinfoWalk("guardian_walk", (self: EdictT): void => {
  M_SetAnimation(self, guardian_move_walk, true);
});

const guardian_frames_run: MframeT[] = [
  frame(ai_run, 8),
  frame(ai_run, 8),
  frame(ai_run, 8),
  frame(ai_run, 8),
  frame(ai_run, 8),
  frame(ai_run, 8),
  frame(ai_run, 8),
  frame(ai_run, 8, guardian_footstep),
  frame(ai_run, 8),
  frame(ai_run, 8),
  frame(ai_run, 8),
  frame(ai_run, 8),
  frame(ai_run, 8),
  frame(ai_run, 8),
  frame(ai_run, 8),
  frame(ai_run, 8),
  frame(ai_run, 8),
  frame(ai_run, 8, guardian_footstep),
  frame(ai_run, 8),
];
const guardian_move_run = RegisterMmove("guardian_move_run", move(FRAME_walk1, FRAME_walk19, guardian_frames_run));

const guardian_run = RegisterMonsterinfoRun("guardian_run", (self: EdictT): void => {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) {
    M_SetAnimation(self, guardian_move_stand, true);
    return;
  }

  M_SetAnimation(self, guardian_move_run, true);
});

// ---------------------------------------------------------------------------
// pain (m_guardian.cpp:157-201)
// ---------------------------------------------------------------------------

const guardian_frames_pain1: MframeT[] = Array.from({ length: 8 }, () => frame(ai_move));
const guardian_move_pain1 = RegisterMmove("guardian_move_pain1", move(FRAME_pain1_1, FRAME_pain1_8, guardian_frames_pain1, guardian_run));

const guardian_pain = RegisterPain("guardian_pain", (self: EdictT, _other: EdictT, _kick: number, damage: number, mod: ModT): void => {
  if (mod.id !== ModIdT.MOD_CHAINFIST && damage <= 10) return;

  if (level.time < self.pain_debounce_time) return;

  if (mod.id !== ModIdT.MOD_CHAINFIST && damage <= 75) {
    if (frandom() > 0.2) return;
  }

  // don't go into pain while attacking
  if (self.s.frame >= FRAME_atk1_spin1 && self.s.frame <= FRAME_atk1_spin15) return;
  if (self.s.frame >= FRAME_atk2_fire1 && self.s.frame <= FRAME_atk2_fire4) return;
  if (self.s.frame >= FRAME_kick_in1 && self.s.frame <= FRAME_kick_in13) return;

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));
  // gi.sound(self, CHAN_VOICE, sound_pain, 1, ATTN_NORM, 0);

  if (!M_ShouldReactToPain(self, mod)) return; // no pain anims in nightmare

  M_SetAnimation(self, guardian_move_pain1, true);
  self.monsterinfo.weapon_sound = 0;
});

// ---------------------------------------------------------------------------
// attack 1: spinning hyperblaster (m_guardian.cpp:203-277)
// ---------------------------------------------------------------------------

const guardian_frames_atk1_out: MframeT[] = [frame(ai_charge), frame(ai_charge), frame(ai_charge)];
const guardian_atk1_out = RegisterMmove("guardian_atk1_out", move(FRAME_atk1_out1, FRAME_atk1_out3, guardian_frames_atk1_out, guardian_run));

function guardian_atk1_finish(self: EdictT): void {
  M_SetAnimation(self, guardian_atk1_out, true);
  self.monsterinfo.weapon_sound = 0;
}

function guardian_atk1_charge(self: EdictT): void {
  self.monsterinfo.weapon_sound = sound_spin_loop;
  gi.sound(self, CHAN_WEAPON, sound_charge, 1, ATTN_NORM, 0);
}

function guardian_fire_blaster(self: EdictT): void {
  if (self.enemy === null) throw new Error(`guardian_fire_blaster: self.enemy is null for ${self.classname ?? "?"}`);

  const id = MonsterMuzzleflashIdT.MZ2_GUARDIAN_BLASTER;

  const { forward: fwd, right } = AngleVectors_destructured(self.s.angles);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[id], fwd, right);
  const target = vec3(self.enemy.s.origin[0], self.enemy.s.origin[1], self.enemy.s.origin[2]);
  target[2] += self.enemy.viewheight;
  for (let i = 0; i < 3; i++) target[i] += crandom_open() * 5;
  const forward = vec3_normalized(vec3_sub(target, start));

  monster_fire_blaster(self, start, forward, 2, 1000, id, self.s.frame % 4 ? EffectsT.EF_NONE : EffectsT.EF_HYPERBLASTER);

  if (
    self.enemy !== null &&
    self.enemy.health > 0 &&
    self.s.frame === FRAME_atk1_spin12 &&
    self.timestamp > level.time &&
    visible(self, self.enemy)
  ) {
    self.monsterinfo.nextframe = FRAME_atk1_spin5;
  }
}

const guardian_frames_atk1_spin: MframeT[] = [
  frame(ai_charge, 0, guardian_atk1_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, guardian_fire_blaster),
  frame(ai_charge, 0, guardian_fire_blaster),
  frame(ai_charge, 0, guardian_fire_blaster),
  frame(ai_charge, 0, guardian_fire_blaster),
  frame(ai_charge, 0, guardian_fire_blaster),
  frame(ai_charge, 0, guardian_fire_blaster),
  frame(ai_charge, 0, guardian_fire_blaster),
  frame(ai_charge, 0, guardian_fire_blaster),
  frame(ai_charge, 0),
  frame(ai_charge, 0),
  frame(ai_charge, 0),
];
const guardian_move_atk1_spin = RegisterMmove(
  "guardian_move_atk1_spin",
  move(FRAME_atk1_spin1, FRAME_atk1_spin15, guardian_frames_atk1_spin, guardian_atk1_finish),
);

function guardian_atk1(self: EdictT): void {
  M_SetAnimation(self, guardian_move_atk1_spin, true);
  self.timestamp = Gtime_add(level.time, Gtime_add(Gtime_from_ms(650), random_time(Gtime_from_sec(1.5))));
}

const guardian_frames_atk1_in: MframeT[] = [frame(ai_charge), frame(ai_charge), frame(ai_charge)];
const guardian_move_atk1_in = RegisterMmove("guardian_move_atk1_in", move(FRAME_atk1_in1, FRAME_atk1_in3, guardian_frames_atk1_in, guardian_atk1));

// ---------------------------------------------------------------------------
// attack 2: laser sweep (m_guardian.cpp:279-356)
// ---------------------------------------------------------------------------

const guardian_frames_atk2_out: MframeT[] = [
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, guardian_footstep),
  frame(ai_charge),
  frame(ai_charge),
];
const guardian_move_atk2_out = RegisterMmove("guardian_move_atk2_out", move(FRAME_atk2_out1, FRAME_atk2_out7, guardian_frames_atk2_out, guardian_run));

function guardian_atk2_out(self: EdictT): void {
  M_SetAnimation(self, guardian_move_atk2_out, true);
}

const laser_positions: readonly Vec3[] = [vec3(125, -70, 60), vec3(112, -62, 60)];

/** PRETHINK callback -- see file header's EXTERNAL DEPENDENCIES note: ported
 *  for real even though `monster_fire_dabeam` (the only thing that would
 *  ever schedule it) is currently a throwing stub. */
const guardian_fire_update: PrethinkFn = RegisterPrethink("guardian_fire_update", (laser: EdictT): void => {
  const self = laser.owner;
  if (self === null) return;
  if (self.enemy === null) throw new Error(`guardian_fire_update: self.enemy is null for ${self.classname ?? "?"}`);

  const { forward: fwd, right } = AngleVectors_destructured(self.s.angles);
  const start = M_ProjectFlashSource(self, laser_positions[1 - (self.s.frame & 1)], fwd, right);
  const target = vec3_add(self.enemy.s.origin, self.enemy.mins);
  for (let i = 0; i < 3; i++) target[i] += frandom() * self.enemy.size[i];
  const forward = vec3_normalized(vec3_sub(target, start));

  laser.s.origin = start;
  laser.movedir = forward;
  gi.linkentity(laser);
  dabeam_update(laser, false);
});

function guardian_laser_fire(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_laser, 1, ATTN_NORM, 0);
  monster_fire_dabeam(self, 25, (self.s.frame & 1) !== 0, guardian_fire_update);
}

const guardian_frames_atk2_fire: MframeT[] = [
  frame(ai_charge, 0, guardian_laser_fire),
  frame(ai_charge, 0, guardian_laser_fire),
  frame(ai_charge, 0, guardian_laser_fire),
  frame(ai_charge, 0, guardian_laser_fire),
];
const guardian_move_atk2_fire = RegisterMmove(
  "guardian_move_atk2_fire",
  move(FRAME_atk2_fire1, FRAME_atk2_fire4, guardian_frames_atk2_fire, guardian_atk2_out),
);

function guardian_atk2(self: EdictT): void {
  M_SetAnimation(self, guardian_move_atk2_fire, true);
}

const guardian_frames_atk2_in: MframeT[] = [
  frame(ai_charge, 0, guardian_footstep),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, guardian_footstep),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, guardian_footstep),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
];
const guardian_move_atk2_in = RegisterMmove("guardian_move_atk2_in", move(FRAME_atk2_in1, FRAME_atk2_in12, guardian_frames_atk2_in, guardian_atk2));

// ---------------------------------------------------------------------------
// melee kick (m_guardian.cpp:358-394)
// ---------------------------------------------------------------------------

function guardian_kick(self: EdictT): void {
  if (!fire_hit(self, vec3(MELEE_DISTANCE, 0, -80), 85, 700)) {
    self.monsterinfo.melee_debounce_time = Gtime_add(level.time, Gtime_from_ms(1000));
  }
}

const guardian_frames_kick: MframeT[] = [
  frame(ai_charge),
  frame(ai_charge, 0, guardian_footstep),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, guardian_kick),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, guardian_footstep),
  frame(ai_charge),
  frame(ai_charge),
];
const guardian_move_kick = RegisterMmove("guardian_move_kick", move(FRAME_kick_in1, FRAME_kick_in13, guardian_frames_kick, guardian_run));

const guardian_attack = RegisterMonsterinfoAttack("guardian_attack", (self: EdictT): void => {
  if (self.enemy === null || !self.enemy.inuse) return;

  const r = range_to(self, self.enemy);

  if (r > RANGE_NEAR) M_SetAnimation(self, guardian_move_atk2_in, true);
  else if (self.monsterinfo.melee_debounce_time < level.time && r < 120) M_SetAnimation(self, guardian_move_kick, true);
  else M_SetAnimation(self, guardian_move_atk1_in, true);
});

// ---------------------------------------------------------------------------
// death (m_guardian.cpp:396-475)
// ---------------------------------------------------------------------------

function guardian_explode(self: EdictT): void {
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_EXPLOSION1_BIG);
  const org = vec3_add(self.s.origin, self.mins);
  org[0] += frandom() * self.size[0];
  org[1] += frandom() * self.size[1];
  org[2] += frandom() * self.size[2];
  gi.WritePosition(org);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_ALL, false);
}

const gibs: readonly string[] = [
  "models/monsters/guardian/gib1.md2",
  "models/monsters/guardian/gib2.md2",
  "models/monsters/guardian/gib3.md2",
  "models/monsters/guardian/gib4.md2",
  "models/monsters/guardian/gib5.md2",
  "models/monsters/guardian/gib6.md2",
  "models/monsters/guardian/gib7.md2",
];

function guardian_dead(self: EdictT): void {
  for (let i = 0; i < 3; i++) guardian_explode(self);

  const gibDefs: GibDefT[] = [
    { gibname: "models/objects/gibs/sm_meat/tris.md2", count: 2 },
    { gibname: "models/objects/gibs/sm_metal/tris.md2", count: 4, type: GibTypeT.GIB_METALLIC },
    { gibname: gibs[0], count: 2, type: GibTypeT.GIB_METALLIC },
    { gibname: gibs[1], count: 2, type: GibTypeT.GIB_METALLIC },
    { gibname: gibs[2], count: 2, type: GibTypeT.GIB_METALLIC },
    { gibname: gibs[3], count: 2, type: GibTypeT.GIB_METALLIC },
    { gibname: gibs[4], count: 2, type: GibTypeT.GIB_METALLIC },
    { gibname: gibs[5], count: 2, type: GibTypeT.GIB_METALLIC },
    { gibname: gibs[6], type: GibTypeT.GIB_METALLIC | GibTypeT.GIB_HEAD },
  ];
  ThrowGibs(self, 125, gibDefs);
}

const guardian_frames_death1: MframeT[] = [frame(ai_move, 0, BossExplode), ...Array.from({ length: 25 }, () => frame(ai_move))];
const guardian_move_death = RegisterMmove("guardian_move_death", move(FRAME_death1, FRAME_death26, guardian_frames_death1, guardian_dead));

const guardian_die = RegisterDie(
  "guardian_die",
  (self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3, _mod: ModT): void => {
    // regular death
    // gi.sound(self, CHAN_VOICE, sound_die, 1, ATTN_NORM, 0);
    self.monsterinfo.weapon_sound = 0;
    self.deadflag = true;
    self.takedamage = true;

    M_SetAnimation(self, guardian_move_death, true);
  },
);

// ---------------------------------------------------------------------------
// monster_guardian (m_guardian.cpp:477-523)
// ---------------------------------------------------------------------------

/**
 * QUAKED monster_guardian (1 .5 0) (-96 -96 -66) (96 96 62) Ambush
 * Trigger_Spawn Sight
 */
export function SP_monster_guardian(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  sound_step = gi.soundindex("zortemp/step.wav");
  sound_charge = gi.soundindex("weapons/hyprbu1a.wav");
  sound_spin_loop = gi.soundindex("weapons/hyprbl1a.wav");
  sound_laser = gi.soundindex("weapons/laser2.wav");

  for (const gib of gibs) gi.modelindex(gib);

  self.s.modelindex = gi.modelindex("models/monsters/guardian/tris.md2");
  self.mins = vec3(-96, -96, -66);
  self.maxs = vec3(96, 96, 62);
  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;

  self.health = Math.trunc(2500 * st.health_multiplier);
  self.gib_health = -200;

  self.monsterinfo.scale = MODEL_SCALE;

  self.mass = 850;

  self.pain = guardian_pain;
  self.die = guardian_die;
  self.monsterinfo.stand = guardian_stand;
  self.monsterinfo.walk = guardian_walk;
  self.monsterinfo.run = guardian_run;
  self.monsterinfo.attack = guardian_attack;

  gi.linkentity(self);

  M_SetAnimation(self, guardian_move_stand, true);

  walkmonster_start(self);
}
