// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_shambler.cpp / m_shambler.h -- SHAMBLER (2023 Quake II re-release /
// "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/m_shambler.cpp (599 lines,
// C++17) and m_shambler.h (106 lines, 103-entry frame enum plus
// MODEL_SCALE). Behavioral code, ported bug-for-bug per PORTING.md.
//
// NEW re-release monster -- no legacy vanilla-Q2 precedent anywhere in this
// repo (unlike m_insane.ts/m_actor.ts, which have a src/game/ sibling). The
// C++ source above is the only reference for this monster's behavior.
// Originally a Quake 1 monster (the model/animation names -- "smash",
// "swingl"/"swingr", "magic" -- and the commented-out QuakeC snippet at
// m_shambler.cpp:242-258 are a direct callback to shambler.qc); the
// rerelease reimplements it as a Quake II monster with a lightning-bolt
// ranged attack (`ShamblerCastLightning`, a `fire_bullet` call with
// `MOD_TESLA` -- reusing the Tesla mine's damage-type enum member for an
// unrelated weapon, not a copy/paste error, see DEVIATIONS below) instead
// of Quake 1's original "cast a lightning bolt from both hands" magic.
//
// ============================================================================
// DEVIATIONS / QUIRKS (bug-for-bug, not "fixed")
// ============================================================================
// - `ShamblerCastLightning`'s damage is `fire_bullet(self, start, dir,
//   irandom(8, 12), 15, 0, 0, MOD_TESLA)` -- MOD_TESLA is otherwise the
//   xatrix Tesla mine's mod id (see g_weapon.ts's own `MOD_TESLA` handling);
//   the shambler's lightning attack reuses it verbatim, which only matters
//   for death-message/damage-type attribution (DAMAGE_ENERGY vs.
//   DAMAGE_BULLET in fire_lead) -- preserved exactly, not given its own mod
//   id.
// - `shambler_pain`'s hard/nightmare "don't interrupt an attack" guard reads
//   `skill->integer >= 2` -- ported via the established
//   `Math.trunc(cvarOrDefault("skill", "1").value)` idiom (m_soldier.ts/
//   m_tank.ts/m_chick.ts/m_gunner.ts's own precedent), not `gameCvars.skill`.
// - `shambler_setskin` (m_shambler.cpp:229-236) is entirely commented out in
//   the C++ source itself ("FIXME: create pain skin?") -- an empty function
//   body, still registered as `monsterinfo.setskin`. Ported as a no-op
//   function, not dropped, since the C++ still wires it up.
// - `sham_smash10`'s local `aim` vector is `{ MELEE_DISTANCE, self->mins[0],
//   -4 }` -- `self->mins[0]` (NOT a hardcoded width), matching the model's
//   per-monster hitbox; preserved exactly (same in `ShamClaw`).
// - `FindShamblerOffset` returns `{0,0,48}` both on success (first clear
//   offset found) AND as its final fallback if the whole 8-step loop finds
//   no clear shot -- i.e. the fallback return duplicates iteration 0's
//   value rather than returning the last (lowest, most-likely-blocked)
//   `offset` tried. This looks like a copy/paste artifact in the shipped
//   C++ source (probably meant to return the last `offset`), preserved
//   exactly, not fixed.
// - `shambler_windup`/`shambler_lightning_update` manage a single lightning
//   beam entity via `self.beam` (start/stop only -- `self.beam2` is
//   referenced only in `shambler_die`'s cleanup, never assigned anywhere in
//   this file; a defensive matching cleanup for a field this monster never
//   actually populates, preserved as dead code exactly like the C++).
// - `shambler_shrink`/`shambler_dead` are named identically to
//   `insane_shrink`/other monsters' own local helpers in sibling files but
//   are NOT shared -- each file's copy is local per PORTING.md's
//   placement-mismatch convention (trivial, no cross-file dependency).
//
// ============================================================================
// PLACEMENT-MISMATCH FUNCTIONS PORTED LOCALLY -- see m_gladiator.ts header
// ============================================================================
// - `cvarOrDefault` (g_local.h's `gi.cvar` wrapper idiom) -- reimplemented
//   locally, exactly m_gunner.ts's/m_soldier.ts's own copies.
// - `PredictAim`/`M_CheckClearShot` are NOT duplicated here: `PredictAim` is
//   imported from m_supertank.ts (that file's own header documents it as
//   exported for exactly this kind of reuse -- "shared with m_tank.ts/
//   m_chick.ts/m_parasite.ts"; this file adds a fourth importer).
//   `M_CheckClearShot` is imported from g_monster.ts, where it is already a
//   real export (not a stub).

import { vec3, type Vec3 } from "../shared/math";
import { CHAN_VOICE, CHAN_WEAPON, CHAN_AUTO, ATTN_NORM, ATTN_IDLE } from "../shared/q_shared";
import {
  SvflagsT,
  SolidT,
  ContentsT,
  RenderfxT,
  KexMulticastT,
  ServerCommandT,
  KexTempEventT,
  MASK_PROJECTILE,
  CvarFlagsT,
} from "../kexapi/game";
import {
  type EdictT,
  type CvarT,
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
import { gi, g_edicts, level } from "./g_main_globals";
import { Gtime_add, Gtime_from_sec, Gtime_from_ms } from "./gtime";
import { type SpawnFlags, SpawnFlags_from, SpawnFlags_has } from "./spawnflags";
import { frandom, brandom, irandom } from "./q_std";
import { AngleVectors_destructured, vec3_add, vec3_muls } from "./q_vec3";
import { G_FreeEdict, G_Spawn } from "./g_utils";
import { st } from "./g_spawn";
import { ai_stand, ai_walk, ai_run, ai_move, ai_charge, range_to } from "./g_ai";
import { M_SetAnimation, M_AllowSpawn, M_ProjectFlashSource, M_CheckClearShot, M_ShouldReactToPain, monster_dead, walkmonster_start } from "./g_monster";
import { fire_bullet, fire_hit } from "./g_weapon";
import { CanDamage } from "./g_combat";
import { ThrowGibs, type GibDefT } from "./g_misc";
import { PredictAim } from "./m_supertank";
import {
  RegisterDie,
  RegisterPain,
  RegisterMonsterinfoStand,
  RegisterMonsterinfoWalk,
  RegisterMonsterinfoRun,
  RegisterMonsterinfoAttack,
  RegisterMonsterinfoMelee,
  RegisterMonsterinfoSight,
  RegisterMonsterinfoIdle,
  RegisterMonsterinfoSetskin,
  RegisterMmove,
} from "./g_save_registry";

// ---------------------------------------------------------------------------
// m_shambler.h frame constants (generated from the enum, see file header)
// ---------------------------------------------------------------------------

export const FRAME_stand01 = 0;
export const FRAME_stand17 = 16;
export const FRAME_walk01 = 17;
export const FRAME_walk12 = 28;
export const FRAME_run01 = 29;
export const FRAME_run06 = 34;
export const FRAME_smash01 = 35;
export const FRAME_smash12 = 46;
export const FRAME_swingr01 = 47;
export const FRAME_swingr09 = 55;
export const FRAME_swingl01 = 56;
export const FRAME_swingl09 = 64;
export const FRAME_magic01 = 65;
export const FRAME_magic09 = 73;
export const FRAME_magic12 = 76;
export const FRAME_pain01 = 77;
export const FRAME_pain06 = 82;
export const FRAME_death01 = 83;
export const FRAME_death11 = 93;

export const MODEL_SCALE = 1.0;

const SPAWNFLAG_SHAMBLER_PRECISE: SpawnFlags = SpawnFlags_from(1);

// ---------------------------------------------------------------------------
// PLACEMENT-MISMATCH FUNCTIONS PORTED LOCALLY -- see file header
// ---------------------------------------------------------------------------

function cvarOrDefault(name: string, defaultValue: string): CvarT {
  const c = gi.cvar(name, defaultValue, CvarFlagsT.CVAR_NOFLAGS);
  if (c === null) throw new Error(`gi.cvar(${name}) returned null`);
  return c;
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
let sound_idle = 0;
let sound_die = 0;
let sound_sight = 0;
let sound_windup = 0;
let sound_melee1 = 0;
let sound_melee2 = 0;
let sound_smack = 0;
let sound_boom = 0;

// ---------------------------------------------------------------------------
// misc (m_shambler.cpp:25-88)
// ---------------------------------------------------------------------------

const shambler_sight = RegisterMonsterinfoSight("shambler_sight", (self: EdictT, _other: EdictT): void => {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
});

const lightning_left_hand: readonly Vec3[] = [
  vec3(44, 36, 25),
  vec3(10, 44, 57),
  vec3(-1, 40, 70),
  vec3(-10, 34, 75),
  vec3(7.4, 24, 89),
];

const lightning_right_hand: readonly Vec3[] = [
  vec3(28, -38, 25),
  vec3(31, -7, 70),
  vec3(20, 0, 80),
  vec3(16, 1.2, 81),
  vec3(27, -11, 83),
];

function shambler_lightning_update(self: EdictT): void {
  const lightning = self.beam;
  if (lightning === null) throw new Error(`shambler_lightning_update: self.beam is null for ${self.classname ?? "?"}`);

  if (self.s.frame >= FRAME_magic01 + lightning_left_hand.length) {
    G_FreeEdict(lightning);
    self.beam = null;
    return;
  }

  const { forward: f, right: r } = AngleVectors_destructured(self.s.angles);
  lightning.s.origin = M_ProjectFlashSource(self, lightning_left_hand[self.s.frame - FRAME_magic01], f, r);
  lightning.s.old_origin = M_ProjectFlashSource(self, lightning_right_hand[self.s.frame - FRAME_magic01], f, r);
  gi.linkentity(lightning);
}

function shambler_windup(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_windup, 1, ATTN_NORM, 0);

  const lightning = G_Spawn();
  self.beam = lightning;
  lightning.s.modelindex = gi.modelindex("models/proj/lightning/tris.md2");
  lightning.s.renderfx |= RenderfxT.RF_BEAM;
  lightning.owner = self;
  shambler_lightning_update(self);
}

const shambler_idle = RegisterMonsterinfoIdle("shambler_idle", (self: EdictT): void => {
  gi.sound(self, CHAN_VOICE, sound_idle, 1, ATTN_IDLE, 0);
});

function shambler_maybe_idle(self: EdictT): void {
  if (frandom() > 0.8) gi.sound(self, CHAN_VOICE, sound_idle, 1, ATTN_IDLE, 0);
}

// ---------------------------------------------------------------------------
// stand (m_shambler.cpp:94-118)
// ---------------------------------------------------------------------------

const shambler_frames_stand: MframeT[] = Array.from({ length: 17 }, () => frame(ai_stand));
const shambler_move_stand = RegisterMmove("shambler_move_stand", move(FRAME_stand01, FRAME_stand17, shambler_frames_stand));

const shambler_stand = RegisterMonsterinfoStand("shambler_stand", (self: EdictT): void => {
  M_SetAnimation(self, shambler_move_stand, true);
});

// ---------------------------------------------------------------------------
// walk (m_shambler.cpp:120-145)
// ---------------------------------------------------------------------------

const shambler_frames_walk: MframeT[] = [
  frame(ai_walk, 10), // FIXME: add footsteps?
  frame(ai_walk, 9),
  frame(ai_walk, 9),
  frame(ai_walk, 5),
  frame(ai_walk, 6),
  frame(ai_walk, 12),
  frame(ai_walk, 8),
  frame(ai_walk, 3),
  frame(ai_walk, 13),
  frame(ai_walk, 9),
  frame(ai_walk, 7, shambler_maybe_idle),
  frame(ai_walk, 5),
];
const shambler_move_walk = RegisterMmove("shambler_move_walk", move(FRAME_walk01, FRAME_walk12, shambler_frames_walk));

const shambler_walk = RegisterMonsterinfoWalk("shambler_walk", (self: EdictT): void => {
  M_SetAnimation(self, shambler_move_walk, true);
});

// ---------------------------------------------------------------------------
// run (m_shambler.cpp:147-177)
// ---------------------------------------------------------------------------

const shambler_frames_run: MframeT[] = [
  frame(ai_run, 20), // FIXME: add footsteps?
  frame(ai_run, 24),
  frame(ai_run, 20),
  frame(ai_run, 20),
  frame(ai_run, 24),
  frame(ai_run, 20, shambler_maybe_idle),
];
const shambler_move_run = RegisterMmove("shambler_move_run", move(FRAME_run01, FRAME_run06, shambler_frames_run));

const shambler_run = RegisterMonsterinfoRun("shambler_run", (self: EdictT): void => {
  if (self.enemy !== null && self.enemy.client !== null) self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_BRUTAL;
  else self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_BRUTAL;

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) {
    M_SetAnimation(self, shambler_move_stand, true);
    return;
  }

  M_SetAnimation(self, shambler_move_run, true);
});

// ---------------------------------------------------------------------------
// pain (m_shambler.cpp:179-236)
// ---------------------------------------------------------------------------

// FIXME: needs halved explosion damage
const shambler_frames_pain: MframeT[] = Array.from({ length: 6 }, () => frame(ai_move));
const shambler_move_pain = RegisterMmove("shambler_move_pain", move(FRAME_pain01, FRAME_pain06, shambler_frames_pain, shambler_run));

const shambler_pain = RegisterPain("shambler_pain", (self: EdictT, _other: EdictT, _kick: number, damage: number, mod: ModT): void => {
  if (level.time < self.timestamp) return;

  self.timestamp = Gtime_add(level.time, Gtime_from_ms(1));
  gi.sound(self, CHAN_AUTO, sound_pain, 1, ATTN_NORM, 0);

  if (mod.id !== ModIdT.MOD_CHAINFIST && damage <= 30 && frandom() > 0.2) return;

  // If hard or nightmare, don't go into pain while attacking
  const skillInt = Math.trunc(cvarOrDefault("skill", "1").value);
  if (skillInt >= 2) {
    if (self.s.frame >= FRAME_smash01 && self.s.frame <= FRAME_smash12) return;
    if (self.s.frame >= FRAME_swingl01 && self.s.frame <= FRAME_swingl09) return;
    if (self.s.frame >= FRAME_swingr01 && self.s.frame <= FRAME_swingr09) return;
  }

  if (!M_ShouldReactToPain(self, mod)) return; // no pain anims in nightmare

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(2));
  M_SetAnimation(self, shambler_move_pain, true);
});

const shambler_setskin = RegisterMonsterinfoSetskin("shambler_setskin", (_self: EdictT): void => {
  // FIXME: create pain skin?
  // if (self.health < self.max_health / 2) self.s.skinnum |= 1;
  // else self.s.skinnum &= ~1;
});

// ---------------------------------------------------------------------------
// magic / lightning attack (m_shambler.cpp:242-337)
// ---------------------------------------------------------------------------

function ShamblerSaveLoc(self: EdictT): void {
  if (self.enemy === null) throw new Error(`ShamblerSaveLoc: self.enemy is null for ${self.classname ?? "?"}`);

  self.pos1 = vec3(self.enemy.s.origin[0], self.enemy.s.origin[1], self.enemy.s.origin[2]); // save for aiming the shot
  self.pos1[2] += self.enemy.viewheight;
  self.monsterinfo.nextframe = FRAME_magic09;

  gi.sound(self, CHAN_WEAPON, sound_boom, 1, ATTN_NORM, 0);
  shambler_lightning_update(self);
}

function FindShamblerOffset(self: EdictT): Vec3 {
  const offset = vec3(0, 0, 48);

  for (let i = 0; i < 8; i++) {
    if (M_CheckClearShot(self, offset)) return offset;

    offset[2] -= 4;
  }

  return vec3(0, 0, 48);
}

function ShamblerCastLightning(self: EdictT): void {
  if (self.enemy === null) return;

  const offset = FindShamblerOffset(self);

  const { forward, right } = AngleVectors_destructured(self.s.angles);
  const start = M_ProjectFlashSource(self, offset, forward, right);

  // calc direction to where we targted
  const dir = vec3();
  PredictAim(self, self.enemy, start, 0, false, SpawnFlags_has(self.spawnflags, SPAWNFLAG_SHAMBLER_PRECISE) ? 0 : 0.1, dir, null);

  const end = vec3_add(start, vec3_muls(dir, 8192));
  const tr = gi.trace(start, null, null, end, self, MASK_PROJECTILE | ContentsT.CONTENTS_SLIME | ContentsT.CONTENTS_LAVA);

  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_LIGHTNING);
  gi.WriteEntity(self); // source entity
  gi.WriteEntity(g_edicts[0]); // destination entity (world)
  gi.WritePosition(start);
  gi.WritePosition(tr.endpos);
  gi.multicast(start, KexMulticastT.MULTICAST_PVS, false);

  const mod: ModT = { id: ModIdT.MOD_TESLA, friendly_fire: false, no_point_loss: false };
  fire_bullet(self, start, dir, irandom(8, 12), 15, 0, 0, mod);
}

const shambler_frames_magic: MframeT[] = [
  frame(ai_charge, 0, shambler_windup),
  frame(ai_charge, 0, shambler_lightning_update),
  frame(ai_charge, 0, shambler_lightning_update),
  frame(ai_move, 0, shambler_lightning_update),
  frame(ai_move, 0, shambler_lightning_update),
  frame(ai_move, 0, ShamblerSaveLoc),
  frame(ai_move),
  frame(ai_charge),
  frame(ai_move, 0, ShamblerCastLightning),
  frame(ai_move, 0, ShamblerCastLightning),
  frame(ai_move, 0, ShamblerCastLightning),
  frame(ai_move),
];
const shambler_attack_magic = RegisterMmove("shambler_attack_magic", move(FRAME_magic01, FRAME_magic12, shambler_frames_magic, shambler_run));

const shambler_attack = RegisterMonsterinfoAttack("shambler_attack", (self: EdictT): void => {
  M_SetAnimation(self, shambler_attack_magic, true);
});

// ---------------------------------------------------------------------------
// melee (m_shambler.cpp:339-473)
// ---------------------------------------------------------------------------

function shambler_melee1(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_melee1, 1, ATTN_NORM, 0);
}

function shambler_melee2(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_melee2, 1, ATTN_NORM, 0);
}

function sham_smash10(self: EdictT): void {
  if (self.enemy === null) return;

  ai_charge(self, 0);

  if (!CanDamage(self.enemy, self)) return;

  const aim = vec3(MELEE_DISTANCE, self.mins[0], -4);
  const hit = fire_hit(self, aim, irandom(110, 120), 120); // Slower attack

  if (hit) gi.sound(self, CHAN_WEAPON, sound_smack, 1, ATTN_NORM, 0);
}

function ShamClaw(self: EdictT): void {
  if (self.enemy === null) return;

  ai_charge(self, 10);

  if (!CanDamage(self.enemy, self)) return;

  const aim = vec3(MELEE_DISTANCE, self.mins[0], -4);
  const hit = fire_hit(self, aim, irandom(70, 80), 80); // Slower attack

  if (hit) gi.sound(self, CHAN_WEAPON, sound_smack, 1, ATTN_NORM, 0);
}

const shambler_frames_smash: MframeT[] = [
  frame(ai_charge, 2, shambler_melee1),
  frame(ai_charge, 6),
  frame(ai_charge, 6),
  frame(ai_charge, 5),
  frame(ai_charge, 4),
  frame(ai_charge, 1),
  frame(ai_charge, 0),
  frame(ai_charge, 0),
  frame(ai_charge, 0),
  frame(ai_charge, 0, sham_smash10),
  frame(ai_charge, 5),
  frame(ai_charge, 4),
];
const shambler_attack_smash = RegisterMmove("shambler_attack_smash", move(FRAME_smash01, FRAME_smash12, shambler_frames_smash, shambler_run));

const shambler_frames_swingl: MframeT[] = [
  frame(ai_charge, 5, shambler_melee1),
  frame(ai_charge, 3),
  frame(ai_charge, 7),
  frame(ai_charge, 3),
  frame(ai_charge, 7),
  frame(ai_charge, 9),
  frame(ai_charge, 5, ShamClaw),
  frame(ai_charge, 4),
  frame(ai_charge, 8, sham_swingl9),
];
const shambler_attack_swingl = RegisterMmove("shambler_attack_swingl", move(FRAME_swingl01, FRAME_swingl09, shambler_frames_swingl, shambler_run));

const shambler_frames_swingr: MframeT[] = [
  frame(ai_charge, 1, shambler_melee2),
  frame(ai_charge, 8),
  frame(ai_charge, 14),
  frame(ai_charge, 7),
  frame(ai_charge, 3),
  frame(ai_charge, 6),
  frame(ai_charge, 6, ShamClaw),
  frame(ai_charge, 3),
  frame(ai_charge, 8, sham_swingr9),
];
const shambler_attack_swingr = RegisterMmove("shambler_attack_swingr", move(FRAME_swingr01, FRAME_swingr09, shambler_frames_swingr, shambler_run));

// `sham_swingl9`/`sham_swingr9` are plain hoisted `function` declarations
// (not const-Register-wrapped -- these are unexported plain thinkfuncs, not
// monsterinfo fields, so no save-registry wrapper is needed either way)
// referenced as thinkfuncs by the two frame tables immediately above, whose
// own textual position precedes these definitions -- matching m_shambler.cpp's
// own forward declarations (`void sham_swingl9(edict_t*); void
// sham_swingr9(edict_t*);` at m_shambler.cpp:353-354). JS function
// declarations are fully hoisted, so this needs no other accommodation.
function sham_swingl9(self: EdictT): void {
  ai_charge(self, 8);

  if (brandom() && self.enemy !== null && range_to(self, self.enemy) < MELEE_DISTANCE) {
    M_SetAnimation(self, shambler_attack_swingr, true);
  }
}

function sham_swingr9(self: EdictT): void {
  ai_charge(self, 1);
  ai_charge(self, 10);

  if (brandom() && self.enemy !== null && range_to(self, self.enemy) < MELEE_DISTANCE) {
    M_SetAnimation(self, shambler_attack_swingl, true);
  }
}

const shambler_melee = RegisterMonsterinfoMelee("shambler_melee", (self: EdictT): void => {
  const chance = frandom();
  if (chance > 0.6 || self.health === 600) M_SetAnimation(self, shambler_attack_smash, true);
  else if (chance > 0.3) M_SetAnimation(self, shambler_attack_swingl, true);
  else M_SetAnimation(self, shambler_attack_swingr, true);
});

// ---------------------------------------------------------------------------
// death (m_shambler.cpp:475-545)
// ---------------------------------------------------------------------------

function shambler_dead(self: EdictT): void {
  self.mins = vec3(-16, -16, -24);
  self.maxs = vec3(16, 16, -0);
  monster_dead(self);
}

function shambler_shrink(self: EdictT): void {
  self.maxs = vec3(self.maxs[0], self.maxs[1], 0);
  self.svflags |= SvflagsT.SVF_DEADMONSTER;
  gi.linkentity(self);
}

const shambler_frames_death: MframeT[] = [
  frame(ai_move, 0),
  frame(ai_move, 0),
  frame(ai_move, 0, shambler_shrink),
  frame(ai_move, 0),
  frame(ai_move, 0),
  frame(ai_move, 0),
  frame(ai_move, 0),
  frame(ai_move, 0),
  frame(ai_move, 0),
  frame(ai_move, 0),
  frame(ai_move, 0), // FIXME: thud?
];
const shambler_move_death = RegisterMmove("shambler_move_death", move(FRAME_death01, FRAME_death11, shambler_frames_death, shambler_dead));

function M_CheckGib(self: EdictT, mod: ModT): boolean {
  if (self.deadflag) {
    if (mod.id === ModIdT.MOD_CRUSH) return true;
  }
  return self.health <= self.gib_health;
}

const shambler_die = RegisterDie(
  "shambler_die",
  (self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3, mod: ModT): void => {
    if (self.beam !== null) {
      G_FreeEdict(self.beam);
      self.beam = null;
    }

    if (self.beam2 !== null) {
      G_FreeEdict(self.beam2);
      self.beam2 = null;
    }

    // check for gib
    if (M_CheckGib(self, mod)) {
      gi.sound(self, CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
      // FIXME: better gibs for shambler, shambler head
      const gibs: GibDefT[] = [
        { gibname: "models/objects/gibs/sm_meat/tris.md2" },
        { gibname: "models/objects/gibs/chest/tris.md2" },
        { gibname: "models/objects/gibs/head2/tris.md2", type: GibTypeT.GIB_HEAD },
      ];
      ThrowGibs(self, damage, gibs);
      self.deadflag = true;
      return;
    }

    if (self.deadflag) return;

    // regular death
    gi.sound(self, CHAN_VOICE, sound_die, 1, ATTN_NORM, 0);
    self.deadflag = true;
    self.takedamage = true;

    M_SetAnimation(self, shambler_move_death, true);
  },
);

// ---------------------------------------------------------------------------
// monster_shambler (m_shambler.cpp:547-598)
// ---------------------------------------------------------------------------

export function SP_monster_shambler(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  self.s.modelindex = gi.modelindex("models/monsters/shambler/tris.md2");
  self.mins = vec3(-32, -32, -24);
  self.maxs = vec3(32, 32, 64);
  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;

  gi.modelindex("models/proj/lightning/tris.md2");
  sound_pain = gi.soundindex("shambler/shurt2.wav");
  sound_idle = gi.soundindex("shambler/sidle.wav");
  sound_die = gi.soundindex("shambler/sdeath.wav");
  sound_windup = gi.soundindex("shambler/sattck1.wav");
  sound_melee1 = gi.soundindex("shambler/melee1.wav");
  sound_melee2 = gi.soundindex("shambler/melee2.wav");
  sound_sight = gi.soundindex("shambler/ssight.wav");
  sound_smack = gi.soundindex("shambler/smack.wav");
  sound_boom = gi.soundindex("shambler/sboom.wav");

  self.health = Math.trunc(600 * st.health_multiplier);
  self.gib_health = -60;

  self.mass = 500;

  self.pain = shambler_pain;
  self.die = shambler_die;
  self.monsterinfo.stand = shambler_stand;
  self.monsterinfo.walk = shambler_walk;
  self.monsterinfo.run = shambler_run;
  self.monsterinfo.dodge = null;
  self.monsterinfo.attack = shambler_attack;
  self.monsterinfo.melee = shambler_melee;
  self.monsterinfo.sight = shambler_sight;
  self.monsterinfo.idle = shambler_idle;
  self.monsterinfo.blocked = null;
  self.monsterinfo.setskin = shambler_setskin;

  gi.linkentity(self);

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_SHAMBLER_PRECISE)) self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_IGNORE_SHOTS;

  M_SetAnimation(self, shambler_move_stand, true);
  self.monsterinfo.scale = MODEL_SCALE;

  walkmonster_start(self);
}
