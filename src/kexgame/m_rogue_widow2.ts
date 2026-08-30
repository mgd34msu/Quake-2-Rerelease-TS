// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_rogue_widow2.c -- the black widow, part 2 (2023 Quake II re-release /
// "KEX" engine, rogue mission-pack content). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/rogue/m_rogue_widow2.cpp
// (1,570 lines) + m_rogue_widow2.h (137 lines, 126 FRAME_ constants +
// MODEL_SCALE), C++17. Behavioral code, ported bug-for-bug per this port
// line's house conventions (see g_monster.ts/m_soldier.ts/m_medic.ts
// headers). One spawn function, `SP_monster_widow2`, classname
// "monster_widow2".
//
// This is the SECOND black widow boss (the boss fought in the rogue
// campaign's final act). The FIRST black widow (`monster_widow`,
// m_rogue_widow.cpp) is a separate, sibling file ported as its own unit --
// not touched or imported here.
//
// ============================================================================
// THE POST-BEAM FRAME TABLE FINDING
// ============================================================================
// The ORIGINAL 1997/2003 id/Rogue Entertainment source (m_widow2.c:339-345,
// already ported bug-for-bug into this repo's OLDER, separate port line at
// src/rogue/m_widow2.ts:392-405) has a genuine Rogue Entertainment authoring
// bug: `widow2_frames_attack_post_beam[]` has THREE rows, but the
// `MMOVE_T`/mmove_t span (`FRAME_fireb06`..`FRAME_fireb07`) only covers TWO
// frames -- a dead third row, harmless only because the engine's frame-think
// dispatch exclusively reads `move->frame[self->s.frame - move->firstframe]`
// for `firstframe <= s.frame <= lastframe`, never touching index 2.
//
// This KEX C++ source (m_rogue_widow2.cpp:288-292) reads:
//   mframe_t widow2_frames_attack_post_beam[] = {
//   	{ ai_charge, 4 },
//   	{ ai_charge, 4 }
//   };
//   MMOVE_T(widow2_move_attack_post_beam) = { FRAME_fireb06, FRAME_fireb07,
//   	widow2_frames_attack_post_beam, widow2_run };
// -- a CLEAN two-row array exactly matching the two-frame span. Rogue/
// ZeniMax/Nightdive FIXED the array/span mismatch when building the 2023
// re-release. Ported below as a clean, non-exempted two-element array with
// no exemption comment -- there is no bug here to preserve. (Verified by
// reading m_rogue_widow2.cpp lines 270-295 and m_rogue_widow2.h's
// FRAME_fireb06/FRAME_fireb07 values directly; the surrounding pre-beam/beam
// tables are unrelated to this finding and unchanged in shape from the
// legacy source.)
//
// ============================================================================
// CROSS-FILE DEPENDENCIES ON THE SIBLING m_rogue_widow.cpp (widow #1)
// ============================================================================
// The C++ forward-declares and calls three symbols genuinely DEFINED in
// m_rogue_widow.cpp, not this file: `WidowCalcSlots`, `WidowPowerups`
// (called from `widow2_attack`/`Widow2_CheckAttack`), and the
// `widow_damage_multiplier` global they and `WidowRespondPowerup`/
// `WidowPowerArmor`/`WidowPent`/`WidowDouble`/`WidowGoinQuad`/`CountPlayers`
// (transitively, from `g_rogue_newai.cpp`) touch. Because this file and the
// sibling `m_rogue_widow.ts` are separate concurrently-authored units with
// no import between them, these are ported here as local, unexported,
// verbatim duplicates (rogue/m_rogue_widow.cpp:1006-1204,
// rogue/g_rogue_newai.cpp:1541-1557 for `CountPlayers`) -- the same
// "trivial local duplicate" idiom this port line already uses for
// `M_CheckGib`/`monster_footstep` in every other monster file. Once
// `m_rogue_widow.ts` lands and is confirmed to export these under the same
// names, a follow-up cleanup unit should delete this file's copies and
// import from there instead; flagged for the coordinator.
//
// `realrange`/`M_SlotsLeft`/`PickCoopTarget`/`FindSpawnPoint`/
// `CreateGroundMonster`/`CheckSpawnPoint`/`CheckGroundSpawnPoint`/
// `SpawnGrow_Spawn` (declared in g_local.h, defined in
// rogue/g_rogue_newai.cpp:914-921 and rogue/g_rogue_spawn.cpp:60-251) are, as
// of this writing, exported for real from `m_medic.ts` (which faced this
// exact cross-file situation first and ported them there) -- imported
// directly from `./m_medic` rather than re-duplicated.
//
// `monster_fire_tracker`/`monster_fire_heatbeam` (declared in g_local.h,
// defined in rogue/g_rogue_monster.cpp:13-24, which thinly wrap
// rogue/g_rogue_newweap.cpp's `fire_heatbeam`) are genuinely out of this
// unit's scope -- the rogue *weapons* files belong to the concurrent
// "rogue systems" unit (same bucket as `fire_prox`/`fire_tesla`/
// `monster_fire_blaster2`). Stubbed locally, throwing, matching
// `m_medic.ts`'s own `monster_fire_blaster2` stub precedent exactly. This
// means `Widow2Beam`/`WidowDisrupt` -- widow2's principal ranged attacks --
// will throw at runtime until that unit lands; the monster still spawns,
// walks, melees (tongue attacks), pains, and dies without hitting either
// stub.
//
// ============================================================================
// OTHER LOCALLY-PORTED OR SHARED CROSS-DEPS
// ============================================================================
// - `gib_die` (a generic MOD_CRUSH-only die handler, g_local.h-declared,
//   defined in g_misc.c and reused verbatim by every monster's gib
//   entities) is NOT exported from g_misc.ts. Its registered name "gib_die"
//   is already claimed by g_misc.ts's own registration, so re-registering
//   the identical name here would throw `g_save_registry: duplicate die
//   registration` the moment both modules load in the same process. Ported
//   locally under the distinct registered name "widow2_gib_die" with
//   byte-identical behavior; flagged for the coordinator as a naming
//   mismatch to resolve (ideally by exporting g_misc.ts's `gib_die` in a
//   follow-up so every gib-spawning file can share one registered name).
// - `ClipGibVelocity` (g_misc.ts:466, unexported) is duplicated locally,
//   unexported, matching this port line's established "trivial local
//   duplicate" idiom (no registry-name collision risk since it is never
//   assigned to a function-pointer field).
// - `M_CheckGib` (g_local.h:3521-3529, `inline`): duplicated locally,
//   unexported, matching every other monster file's own copy verbatim
//   (m_medic.ts/m_soldier.ts/m_boss2.ts/etc. all carry the identical copy).
// - `cached_soundindex` fields -> plain `{ index: 0 }` objects via a local
//   `mkSound()`/`assignSound()` pair, matching m_boss2.ts's own per-file
//   duplicate of this idiom (not imported -- established "duplicated per
//   file" convention for this particular tiny helper).
// - `pauseme`/`Widow2BeamTargetRemove`/`Widow2StartSweep`/`widow2_dead` are
//   genuinely DEAD CODE in the C++ source itself -- defined but never
//   called anywhere in m_rogue_widow2.cpp (verified: no call sites for any
//   of the four in the full 1,570-line file). Ported anyway, unexported,
//   for bug-for-bug fidelity (dead code preserved, not dropped), matching
//   this port line's "dead C parameter/dead branch, kept" precedent
//   (e.g. m_medic.ts's `FindSpawnPoint`'s unused `maxMoveUp`). `showme`
//   (forward-declared at m_rogue_widow2.cpp:80) has NO body anywhere in the
//   translation unit and is never called -- an orphaned forward declaration
//   in the original C++ with nothing to port; omitted.
// - Vec3 arithmetic chains use q_vec3.ts's functional
//   `vec3_add`/`vec3_sub`/`vec3_muls`/`vec3_normalized` helpers (each
//   returns a new Vec3) rather than C++ operator overloading, matching
//   m_soldier.ts's/m_boss2.ts's own documented deviation.
// - `self->enemy->...` dereferences with no null check in the C++ (trusting
//   the monster-AI invariant that attack/think callbacks only run while
//   `self.enemy` is set) get an explicit narrowing guard here
//   (`const enemy = self.enemy; if (enemy === null) return;`), matching
//   m_boss2.ts's identical documented precedent -- behavior-preserving,
//   not new game logic.

import { vec3, type Vec3 } from "../shared/math";
import type { CvarT } from "../shared/q_shared";
import {
  AngleVectors,
  vec3_add,
  vec3_sub,
  vec3_muls,
  vec3_length,
  vec3_normalized,
  vec3_origin,
  vectoangles,
  vectoyaw,
  G_ProjectSource,
  G_ProjectSource2,
} from "./q_vec3";
import {
  MonsterMuzzleflashIdT,
  SoundchanT,
  EffectsT,
  ATTN_NORM,
  ATTN_NONE,
  MASK_PROJECTILE,
  CvarFlagsT,
  ServerCommandT,
  KexMulticastT,
  KexTempEventT,
  RenderfxT,
  SolidT,
  type KexTraceT,
} from "../kexapi/game";
import type { ModT, MframeT, MmoveEndfuncFn, PainFn, DieFn, ThinkFn, TouchFn } from "./g_local_types";
import { MmoveT } from "./g_local_types";
import {
  RegisterMmove,
  RegisterPain,
  RegisterDie,
  RegisterThink,
  RegisterTouch,
  RegisterMonsterinfoSearch,
  RegisterMonsterinfoStand,
  RegisterMonsterinfoWalk,
  RegisterMonsterinfoRun,
  RegisterMonsterinfoMelee,
  RegisterMonsterinfoAttack,
  RegisterMonsterinfoSetskin,
  RegisterMonsterinfoCheckattack,
} from "./g_save_registry";
import {
  type EdictT,
  MonsterAiFlagsT,
  MonsterAttackStateT,
  EntFlagsT,
  MovetypeT,
  ItemIdT,
  DamageflagsT,
  GibTypeT,
  ModIdT,
  random_time,
} from "./g_local";
import { gi, level, g_edicts, game } from "./g_main_globals";
import { infront, M_CheckAttack_Base, FoundTarget, ai_stand, ai_walk, ai_run, ai_move, ai_charge } from "./g_ai";
import { M_AllowSpawn, M_SetAnimation, M_ShouldReactToPain, walkmonster_start, monster_think } from "./g_monster";
import { M_ChangeYaw } from "./m_move";
import { ThrowGibs } from "./g_misc";
import { G_Spawn, G_FreeEdict, G_FindByString } from "./g_utils";
import { T_Damage } from "./g_combat";
import { st } from "./g_spawn";
import { fire_hit } from "./g_weapon";
import { Gtime_add, Gtime_from_ms, Gtime_from_sec, GTIME_ZERO, type GTime } from "./gtime";
import { frandom, irandom, clamp } from "./q_std";
import { PredictAim } from "./m_supertank";
import { realrange, M_SlotsLeft, PickCoopTarget, FindSpawnPoint, CreateGroundMonster, SpawnGrow_Spawn } from "./m_medic";
import { monsterFlashOffset as monsterFlashOffsetTable } from "./m_flash";

// ---------------------------------------------------------------------------
// m_rogue_widow2.h frame-index enum (126 entries; anonymous enum,
// declaration order = array index, starting at 0) + MODEL_SCALE.
// ---------------------------------------------------------------------------

export const FRAME_blackwidow3 = 0;
export const FRAME_walk01 = 1;
export const FRAME_walk02 = 2;
export const FRAME_walk03 = 3;
export const FRAME_walk04 = 4;
export const FRAME_walk05 = 5;
export const FRAME_walk06 = 6;
export const FRAME_walk07 = 7;
export const FRAME_walk08 = 8;
export const FRAME_walk09 = 9;
export const FRAME_spawn01 = 10;
export const FRAME_spawn02 = 11;
export const FRAME_spawn03 = 12;
export const FRAME_spawn04 = 13;
export const FRAME_spawn05 = 14;
export const FRAME_spawn06 = 15;
export const FRAME_spawn07 = 16;
export const FRAME_spawn08 = 17;
export const FRAME_spawn09 = 18;
export const FRAME_spawn10 = 19;
export const FRAME_spawn11 = 20;
export const FRAME_spawn12 = 21;
export const FRAME_spawn13 = 22;
export const FRAME_spawn14 = 23;
export const FRAME_spawn15 = 24;
export const FRAME_spawn16 = 25;
export const FRAME_spawn17 = 26;
export const FRAME_spawn18 = 27;
export const FRAME_firea01 = 28;
export const FRAME_firea02 = 29;
export const FRAME_firea03 = 30;
export const FRAME_firea04 = 31;
export const FRAME_firea05 = 32;
export const FRAME_firea06 = 33;
export const FRAME_firea07 = 34;
export const FRAME_fireb01 = 35;
export const FRAME_fireb02 = 36;
export const FRAME_fireb03 = 37;
export const FRAME_fireb04 = 38;
export const FRAME_fireb05 = 39;
export const FRAME_fireb06 = 40;
export const FRAME_fireb07 = 41;
export const FRAME_fireb08 = 42;
export const FRAME_fireb09 = 43;
export const FRAME_fireb10 = 44;
export const FRAME_fireb11 = 45;
export const FRAME_fireb12 = 46;
export const FRAME_tongs01 = 47;
export const FRAME_tongs02 = 48;
export const FRAME_tongs03 = 49;
export const FRAME_tongs04 = 50;
export const FRAME_tongs05 = 51;
export const FRAME_tongs06 = 52;
export const FRAME_tongs07 = 53;
export const FRAME_tongs08 = 54;
export const FRAME_pain01 = 55;
export const FRAME_pain02 = 56;
export const FRAME_pain03 = 57;
export const FRAME_pain04 = 58;
export const FRAME_pain05 = 59;
export const FRAME_death01 = 60;
export const FRAME_death02 = 61;
export const FRAME_death03 = 62;
export const FRAME_death04 = 63;
export const FRAME_death05 = 64;
export const FRAME_death06 = 65;
export const FRAME_death07 = 66;
export const FRAME_death08 = 67;
export const FRAME_death09 = 68;
export const FRAME_death10 = 69;
export const FRAME_death11 = 70;
export const FRAME_death12 = 71;
export const FRAME_death13 = 72;
export const FRAME_death14 = 73;
export const FRAME_death15 = 74;
export const FRAME_death16 = 75;
export const FRAME_death17 = 76;
export const FRAME_death18 = 77;
export const FRAME_death19 = 78;
export const FRAME_death20 = 79;
export const FRAME_death21 = 80;
export const FRAME_death22 = 81;
export const FRAME_death23 = 82;
export const FRAME_death24 = 83;
export const FRAME_death25 = 84;
export const FRAME_death26 = 85;
export const FRAME_death27 = 86;
export const FRAME_death28 = 87;
export const FRAME_death29 = 88;
export const FRAME_death30 = 89;
export const FRAME_death31 = 90;
export const FRAME_death32 = 91;
export const FRAME_death33 = 92;
export const FRAME_death34 = 93;
export const FRAME_death35 = 94;
export const FRAME_death36 = 95;
export const FRAME_death37 = 96;
export const FRAME_death38 = 97;
export const FRAME_death39 = 98;
export const FRAME_death40 = 99;
export const FRAME_death41 = 100;
export const FRAME_death42 = 101;
export const FRAME_death43 = 102;
export const FRAME_death44 = 103;
export const FRAME_dthsrh01 = 104;
export const FRAME_dthsrh02 = 105;
export const FRAME_dthsrh03 = 106;
export const FRAME_dthsrh04 = 107;
export const FRAME_dthsrh05 = 108;
export const FRAME_dthsrh06 = 109;
export const FRAME_dthsrh07 = 110;
export const FRAME_dthsrh08 = 111;
export const FRAME_dthsrh09 = 112;
export const FRAME_dthsrh10 = 113;
export const FRAME_dthsrh11 = 114;
export const FRAME_dthsrh12 = 115;
export const FRAME_dthsrh13 = 116;
export const FRAME_dthsrh14 = 117;
export const FRAME_dthsrh15 = 118;
export const FRAME_dthsrh16 = 119;
export const FRAME_dthsrh17 = 120;
export const FRAME_dthsrh18 = 121;
export const FRAME_dthsrh19 = 122;
export const FRAME_dthsrh20 = 123;
export const FRAME_dthsrh21 = 124;
export const FRAME_dthsrh22 = 125;

export const MODEL_SCALE = 2.0;

// ---------------------------------------------------------------------------
// cached_soundindex fields (m_rogue_widow2.cpp:17-22)
// ---------------------------------------------------------------------------

interface CachedSoundIndex {
  index: number;
}
function mkSound(): CachedSoundIndex {
  return { index: 0 };
}
function assignSound(cache: CachedSoundIndex, name: string): void {
  cache.index = gi.soundindex(name);
}

const sound_pain1 = mkSound();
const sound_pain2 = mkSound();
const sound_pain3 = mkSound();
const sound_death = mkSound();
const sound_search1 = mkSound();
const sound_tentacles_retract = mkSound();

// ---------------------------------------------------------------------------
// mkframe/mkMove local builders -- see m_medic.ts's/m_soldier.ts's own
// precedent.
// ---------------------------------------------------------------------------

type Aifunc = (self: EdictT, dist: number) => void;
type Thinkfunc = (self: EdictT) => void;

function mkframe(aifunc: Aifunc | null, dist = 0, thinkfunc: Thinkfunc | null = null): MframeT {
  return { aifunc, dist, thinkfunc, lerp_frame: -1 };
}
function mkMove(firstframe: number, lastframe: number, frame: MframeT[], endfunc: MmoveEndfuncFn | null): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.frame = frame;
  m.endfunc = endfunc;
  return m;
}

/** g_local.h:3521-3529 `inline bool M_CheckGib(edict_t *self, const mod_t &mod)`. */
function M_CheckGib(self: EdictT, mod: ModT): boolean {
  if (self.gib_health === 0) return false;
  if (self.health > 0) return false;
  if (self.gib_health < 0 && self.health < self.gib_health) return true;
  if (mod.id === ModIdT.MOD_DISINTEGRATOR) return true;
  return false;
}

/** g_misc.ts:466, unexported there too -- duplicated per this port line's
 *  established "trivial local duplicate" idiom (no registry involvement). */
function ClipGibVelocity(ent: EdictT): void {
  if (ent.velocity[0] < -300) ent.velocity[0] = -300;
  else if (ent.velocity[0] > 300) ent.velocity[0] = 300;
  if (ent.velocity[1] < -300) ent.velocity[1] = -300;
  else if (ent.velocity[1] > 300) ent.velocity[1] = 300;
  if (ent.velocity[2] < 200) ent.velocity[2] = 200; // always some upwards
  else if (ent.velocity[2] > 500) ent.velocity[2] = 500;
}

/** m_rogue_widow2.cpp:37 (extern) -- genuinely defined in g_ai.cpp, ALREADY
 *  ported/exported from g_ai.ts; imported directly above. This local note
 *  exists only so a reader searching for `infront`'s declaration in the
 *  C++ finds an explanation here instead of assuming it's unported. */

/** coop->integer / skill->integer, worked around per g_utils.ts's own local
 *  `coopEnabled()` idiom (fresh `gi.cvar(...)` lookup each call; `CvarT` has
 *  no cached `.integer`). */
function coopEnabled(): boolean {
  const c: CvarT | null = gi.cvar("coop", "0", CvarFlagsT.CVAR_LATCH);
  return c !== null && c.value !== 0;
}
function skillInt(): number {
  const c: CvarT | null = gi.cvar("skill", "1", CvarFlagsT.CVAR_LATCH);
  return c === null ? 1 : Math.trunc(c.value);
}

// ---------------------------------------------------------------------------
// WidowCalcSlots / WidowPowerups / WidowRespondPowerup / WidowPowerArmor /
// WidowPent / WidowDouble / WidowGoinQuad / CountPlayers /
// widow_damage_multiplier -- ported for real, LOCALLY (genuinely defined in
// the sibling rogue/m_rogue_widow.cpp:49,1006-1204 and
// rogue/g_rogue_newai.cpp:1541-1557). See file header's "CROSS-FILE
// DEPENDENCIES" section for why this is a duplicate rather than an import.
// ---------------------------------------------------------------------------

/** m_rogue_widow.cpp:49 (`unsigned int widow_damage_multiplier;`, a global,
 *  not `static` -- genuinely shared with m_rogue_widow.cpp in the C++.
 *  widow2.cpp itself never reads or writes this variable, only the
 *  WidowPowerups call chain duplicated below does -- kept module-local
 *  here since nothing in THIS file's own attack code consumes it. */
let widow_damage_multiplier = 1;

/** rogue/g_rogue_newai.cpp:1541-1557. Coop player count, 1 outside coop. */
function CountPlayers(): number {
  if (!coopEnabled()) return 1;
  let count = 0;
  for (let player = 1; player <= game.maxclients; player++) {
    const ent = g_edicts[player];
    if (!ent.inuse) continue;
    if (ent.client === null) continue;
    count++;
  }
  return count;
}

/** m_rogue_widow.cpp:1184-1203. */
function WidowCalcSlots(self: EdictT): void {
  switch (skillInt()) {
    case 0:
    case 1:
      self.monsterinfo.monster_slots = 3;
      break;
    case 2:
      self.monsterinfo.monster_slots = 4;
      break;
    case 3:
      self.monsterinfo.monster_slots = 6;
      break;
    default:
      self.monsterinfo.monster_slots = 3;
      break;
  }
  if (coopEnabled()) {
    self.monsterinfo.monster_slots = Math.min(6, self.monsterinfo.monster_slots + skillInt() * (CountPlayers() - 1));
  }
}

/** m_rogue_widow.cpp:1018-1020. */
function WidowPent(self: EdictT, time: GTime): void {
  self.monsterinfo.invincible_time = time;
}

/** m_rogue_widow.cpp:1023-1029. */
function WidowPowerArmor(self: EdictT): void {
  self.monsterinfo.power_armor_type = ItemIdT.IT_ITEM_POWER_SHIELD;
  // I don't like this, but it works
  if (self.monsterinfo.power_armor_power <= 0) self.monsterinfo.power_armor_power += 250 * skillInt();
}

/** m_rogue_widow.cpp:1006-1010. */
function WidowGoinQuad(self: EdictT, time: GTime): void {
  self.monsterinfo.quad_time = time;
  widow_damage_multiplier = 4;
}

/** m_rogue_widow.cpp:1012-1016. */
function WidowDouble(self: EdictT, time: GTime): void {
  self.monsterinfo.double_time = time;
  widow_damage_multiplier = 2;
}

/** m_rogue_widow.cpp:1031-1060. */
function WidowRespondPowerup(self: EdictT, other: EdictT): void {
  const otherClient = other.client;
  if ((other.s.effects & EffectsT.EF_QUAD) !== 0n) {
    if (otherClient === null) {
      // unreachable given the C invariant (EF_QUAD is only ever set on
      // clients), kept for type-safety only.
    } else if (skillInt() === 1) WidowDouble(self, otherClient.quad_time);
    else if (skillInt() === 2) WidowGoinQuad(self, otherClient.quad_time);
    else if (skillInt() === 3) {
      if (otherClient !== null) WidowGoinQuad(self, otherClient.quad_time);
      WidowPowerArmor(self);
    }
  } else if ((other.s.effects & EffectsT.EF_DOUBLE) !== 0n) {
    if (otherClient !== null && skillInt() === 2) WidowDouble(self, otherClient.double_time);
    else if (skillInt() === 3) {
      if (otherClient !== null) WidowDouble(self, otherClient.double_time);
      WidowPowerArmor(self);
    }
  } else {
    widow_damage_multiplier = 1;
  }

  if ((other.s.effects & EffectsT.EF_PENT) !== 0n) {
    if (otherClient === null) {
      // unreachable, see above.
    } else if (skillInt() === 1) WidowPowerArmor(self);
    else if (skillInt() === 2) WidowPent(self, otherClient.invincible_time);
    else if (skillInt() === 3) {
      WidowPent(self, otherClient.invincible_time);
      WidowPowerArmor(self);
    }
  }
}

/** m_rogue_widow.cpp:1072-1099. */
function WidowPowerups(self: EdictT): void {
  if (!coopEnabled()) {
    const enemy = self.enemy;
    if (enemy !== null) WidowRespondPowerup(self, enemy);
    return;
  }

  for (let player = 1; player <= game.maxclients; player++) {
    const ent = g_edicts[player];
    if (!ent.inuse || ent.client === null) continue;
    if ((ent.s.effects & EffectsT.EF_PENT) !== 0n) {
      WidowRespondPowerup(self, ent);
      return;
    }
  }
  for (let player = 1; player <= game.maxclients; player++) {
    const ent = g_edicts[player];
    if (!ent.inuse || ent.client === null) continue;
    if ((ent.s.effects & EffectsT.EF_QUAD) !== 0n) {
      WidowRespondPowerup(self, ent);
      return;
    }
  }
  for (let player = 1; player <= game.maxclients; player++) {
    const ent = g_edicts[player];
    if (!ent.inuse || ent.client === null) continue;
    if ((ent.s.effects & EffectsT.EF_DOUBLE) !== 0n) {
      WidowRespondPowerup(self, ent);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// monster_fire_tracker / monster_fire_heatbeam -- genuinely out-of-scope
// stubs (rogue weapons files, see file header). Matches m_medic.ts's own
// `monster_fire_blaster2` stub idiom exactly.
// ---------------------------------------------------------------------------

function monster_fire_tracker(self: EdictT, _start: Vec3, _dir: Vec3, _damage: number, _speed: number, _enemy: EdictT | null, _flashtype: MonsterMuzzleflashIdT): void {
  throw new Error(`monster_fire_tracker: not yet ported (rogue mission pack, see rogue/g_rogue_monster.cpp:13 + rogue/g_rogue_newweap.cpp) -- called against ${self.classname ?? "?"}`);
}

function monster_fire_heatbeam(self: EdictT, _start: Vec3, _dir: Vec3, _offset: Vec3, _damage: number, _kick: number, _flashtype: MonsterMuzzleflashIdT): void {
  throw new Error(`monster_fire_heatbeam: not yet ported (rogue mission pack, see rogue/g_rogue_monster.cpp:19 + rogue/g_rogue_newweap.cpp:1297) -- called against ${self.classname ?? "?"}`);
}

// ---------------------------------------------------------------------------
// Constants (m_rogue_widow2.cpp:24-78)
// ---------------------------------------------------------------------------

// sqrt(64*64*2) + sqrt(28*28*2) => 130.1
const spawnpoints: Vec3[] = [vec3(30, 135, 0), vec3(30, -135, 0)];

const sweep_angles = [-40.0, -32.0, -24.0, -16.0, -8.0, 0.0, 8.0, 16.0, 24.0, 32.0, 40.0];

const stalker_mins = vec3(-28, -28, -18);
const stalker_maxs = vec3(28, 28, 18);

// these offsets used by the tongue
const offsets: Vec3[] = [
  vec3(17.48, 0.1, 68.92),
  vec3(17.47, 0.29, 68.91),
  vec3(17.45, 0.53, 68.87),
  vec3(17.42, 0.78, 68.81),
  vec3(17.39, 1.02, 68.75),
  vec3(17.37, 1.2, 68.7),
  vec3(17.36, 1.24, 68.71),
  vec3(17.37, 1.21, 68.72),
];

// ---------------------------------------------------------------------------
// pauseme -- dead code, see file header.
// ---------------------------------------------------------------------------

function pauseme(self: EdictT): void {
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_HOLD_FRAME;
}

export const widow2_search = RegisterMonsterinfoSearch("widow2_search", (self: EdictT): void => {
  if (frandom() < 0.5) gi.sound(self, SoundchanT.CHAN_VOICE, sound_search1.index, 1, ATTN_NONE, 0);
});

// ---------------------------------------------------------------------------
// Widow2Beam / Widow2Spawn / widow2_spawn_check / widow2_ready_spawn /
// widow2_step
// ---------------------------------------------------------------------------

function Widow2Beam(self: EdictT): void {
  const enemy = self.enemy;
  if (enemy === null || !enemy.inuse) return;

  const forward = vec3();
  const right = vec3();
  AngleVectors(self.s.angles, forward, right, null);

  let flashnum: MonsterMuzzleflashIdT;
  let start: Vec3;
  let target: Vec3;

  if (self.s.frame >= FRAME_fireb05 && self.s.frame <= FRAME_fireb09) {
    // regular beam attack
    Widow2SaveBeamTarget(self);
    flashnum = MonsterMuzzleflashIdT.MZ2_WIDOW2_BEAMER_1 + (self.s.frame - FRAME_fireb05);
    start = G_ProjectSource(self.s.origin, monsterFlashOffsetTable()[flashnum], forward, right);
    target = vec3(self.pos2[0], self.pos2[1], self.pos2[2]);
    target[2] += enemy.viewheight - 10;
    let dir = vec3_normalized(vec3_sub(target, start));
    monster_fire_heatbeam(self, start, dir, vec3_origin, 10, 50, flashnum);
  } else if (self.s.frame >= FRAME_spawn04 && self.s.frame <= FRAME_spawn14) {
    // sweep
    flashnum = MonsterMuzzleflashIdT.MZ2_WIDOW2_BEAM_SWEEP_1 + (self.s.frame - FRAME_spawn04);
    start = G_ProjectSource(self.s.origin, monsterFlashOffsetTable()[flashnum], forward, right);
    target = vec3_sub(enemy.s.origin, start);
    const targ_angles = vectoangles(target);

    const vec = vec3(self.s.angles[0], self.s.angles[1], self.s.angles[2]);
    vec[0] += targ_angles[0]; // PITCH
    vec[1] -= sweep_angles[flashnum - MonsterMuzzleflashIdT.MZ2_WIDOW2_BEAM_SWEEP_1]; // YAW

    const sweepForward = vec3();
    AngleVectors(vec, sweepForward, null, null);
    monster_fire_heatbeam(self, start, sweepForward, vec3_origin, 10, 50, flashnum);
  } else {
    Widow2SaveBeamTarget(self);
    start = G_ProjectSource(self.s.origin, monsterFlashOffsetTable()[MonsterMuzzleflashIdT.MZ2_WIDOW2_BEAMER_1], forward, right);
    target = vec3(self.pos2[0], self.pos2[1], self.pos2[2]);
    target[2] += enemy.viewheight - 10;
    const dir = vec3_normalized(vec3_sub(target, start));
    monster_fire_heatbeam(self, start, dir, vec3_origin, 10, 50, MonsterMuzzleflashIdT.MZ2_WIDOW2_BEAM_SWEEP_1);
  }
}

function Widow2Spawn(self: EdictT): void {
  const f = vec3();
  const r = vec3();
  const u = vec3();
  AngleVectors(self.s.angles, f, r, u);

  for (let i = 0; i < 2; i++) {
    const offset = spawnpoints[i];
    const startpoint = G_ProjectSource2(self.s.origin, offset, f, r, u);

    const spawnpoint = FindSpawnPoint(startpoint, stalker_mins, stalker_maxs, 64);
    if (spawnpoint === null) continue;

    const ent = CreateGroundMonster(spawnpoint, self.s.angles, stalker_mins, stalker_maxs, "monster_stalker", 256);
    if (ent === null) continue;

    self.monsterinfo.monster_used++;
    ent.monsterinfo.commander = self;

    ent.nextthink = level.time;
    if (ent.think !== null) ent.think(ent);

    ent.monsterinfo.aiflags |= MonsterAiFlagsT.AI_SPAWNED_WIDOW | MonsterAiFlagsT.AI_DO_NOT_COUNT | MonsterAiFlagsT.AI_IGNORE_SHOTS;

    let designated_enemy: EdictT | null;
    if (!coopEnabled()) {
      designated_enemy = self.enemy;
    } else {
      designated_enemy = PickCoopTarget(ent);
      if (designated_enemy !== null) {
        // try to avoid using my enemy
        if (designated_enemy === self.enemy) {
          designated_enemy = PickCoopTarget(ent);
          if (designated_enemy === null) designated_enemy = self.enemy;
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
    const offset = spawnpoints[i];
    const startpoint = G_ProjectSource2(self.s.origin, offset, f, r, u);
    const spawnpoint = FindSpawnPoint(startpoint, stalker_mins, stalker_maxs, 64);
    if (spawnpoint === null) continue;

    const radius = vec3_length(vec3_sub(stalker_maxs, stalker_mins)) * 0.5;
    SpawnGrow_Spawn(vec3_add(spawnpoint, vec3_add(stalker_mins, stalker_maxs)), radius, radius * 2);
  }
}

function widow2_step(self: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_BODY, gi.soundindex("widow/bwstep1.wav"), 1, ATTN_NORM, 0);
}

// ---------------------------------------------------------------------------
// Frame tables (m_rogue_widow2.cpp:239-638)
// ---------------------------------------------------------------------------

const widow2_frames_stand: MframeT[] = [mkframe(ai_stand)];
const widow2_move_stand = RegisterMmove("widow2_move_stand", mkMove(FRAME_blackwidow3, FRAME_blackwidow3, widow2_frames_stand, null));

const widow2_frames_walk: MframeT[] = [
  mkframe(ai_walk, 9.01, widow2_step),
  mkframe(ai_walk, 7.55),
  mkframe(ai_walk, 7.01),
  mkframe(ai_walk, 6.66),
  mkframe(ai_walk, 6.2),
  mkframe(ai_walk, 5.78, widow2_step),
  mkframe(ai_walk, 7.25),
  mkframe(ai_walk, 8.37),
  mkframe(ai_walk, 10.41),
];
const widow2_move_walk = RegisterMmove("widow2_move_walk", mkMove(FRAME_walk01, FRAME_walk09, widow2_frames_walk, null));

const widow2_frames_run: MframeT[] = [
  mkframe(ai_run, 9.01, widow2_step),
  mkframe(ai_run, 7.55),
  mkframe(ai_run, 7.01),
  mkframe(ai_run, 6.66),
  mkframe(ai_run, 6.2),
  mkframe(ai_run, 5.78, widow2_step),
  mkframe(ai_run, 7.25),
  mkframe(ai_run, 8.37),
  mkframe(ai_run, 10.41),
];
const widow2_move_run = RegisterMmove("widow2_move_run", mkMove(FRAME_walk01, FRAME_walk09, widow2_frames_run, null));

// Moved ahead of its C++ textual position (m_rogue_widow2.cpp:673-681) --
// several frame tables below (`widow2_move_attack_post_beam`,
// `widow2_move_tongs`, `widow2_move_pain`) reference `widow2_run` as their
// `endfunc`, and the C++'s forward declaration (`void widow2_run(edict_t
// *self);`) has no TS equivalent for a `const`; relocated to satisfy
// initialization order, not a behavioral change.
export const widow2_run = RegisterMonsterinfoRun("widow2_run", (self: EdictT): void => {
  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_HOLD_FRAME;

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) M_SetAnimation(self, widow2_move_stand, true);
  else M_SetAnimation(self, widow2_move_run, true);
});

function widow2_attack_beam(self: EdictT): void {
  M_SetAnimation(self, widow2_move_attack_beam, true);
  widow2_step(self);
}

const widow2_frames_attack_pre_beam: MframeT[] = [mkframe(ai_charge, 4), mkframe(ai_charge, 4, widow2_step), mkframe(ai_charge, 4), mkframe(ai_charge, 4, widow2_attack_beam)];
const widow2_move_attack_pre_beam = RegisterMmove("widow2_move_attack_pre_beam", mkMove(FRAME_fireb01, FRAME_fireb04, widow2_frames_attack_pre_beam, null));

// Loop this
const widow2_frames_attack_beam: MframeT[] = [
  mkframe(ai_charge, 0, Widow2Beam),
  mkframe(ai_charge, 0, Widow2Beam),
  mkframe(ai_charge, 0, Widow2Beam),
  mkframe(ai_charge, 0, Widow2Beam),
  mkframe(ai_charge, 0, widow2_reattack_beam),
];
const widow2_move_attack_beam = RegisterMmove("widow2_move_attack_beam", mkMove(FRAME_fireb05, FRAME_fireb09, widow2_frames_attack_beam, null));

// See file header's "THE POST-BEAM FRAME TABLE FINDING": the KEX C++ source
// (m_rogue_widow2.cpp:288-292) has a CLEAN two-row array for this two-frame
// span -- unlike the legacy 1997/2003 source's three-row array for the same
// two-frame span (m_widow2.c:339-345 / src/rogue/m_widow2.ts:392-405). No
// exemption needed here.
const widow2_frames_attack_post_beam: MframeT[] = [mkframe(ai_charge, 4), mkframe(ai_charge, 4)];
const widow2_move_attack_post_beam = RegisterMmove("widow2_move_attack_post_beam", mkMove(FRAME_fireb06, FRAME_fireb07, widow2_frames_attack_post_beam, widow2_run));

function WidowDisrupt(self: EdictT): void {
  const enemy = self.enemy;
  if (enemy === null) return; // C assumes self->enemy is set here

  const forward = vec3();
  const right = vec3();
  AngleVectors(self.s.angles, forward, right, null);
  const start = G_ProjectSource(self.s.origin, monsterFlashOffsetTable()[MonsterMuzzleflashIdT.MZ2_WIDOW_DISRUPTOR], forward, right);

  const dir = vec3_sub(self.pos1, enemy.s.origin);
  const len = vec3_length(dir);

  if (len < 30) {
    // calc direction to where we targeted
    const toTarget = vec3_normalized(vec3_sub(self.pos1, start));
    monster_fire_tracker(self, start, toTarget, 20, 500, enemy, MonsterMuzzleflashIdT.MZ2_WIDOW_DISRUPTOR);
  } else {
    const aim = vec3();
    PredictAim(self, enemy, start, 1200, true, 0, aim, null);
    monster_fire_tracker(self, start, aim, 20, 1200, null, MonsterMuzzleflashIdT.MZ2_WIDOW_DISRUPTOR);
  }

  widow2_step(self);
}

function Widow2SaveDisruptLoc(self: EdictT): void {
  const enemy = self.enemy;
  if (enemy !== null && enemy.inuse) {
    self.pos1 = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2]);
    self.pos1[2] += enemy.viewheight;
  } else {
    self.pos1 = vec3();
  }
}

function widow2_disrupt_reattack(self: EdictT): void {
  const luck = frandom();
  if (luck < 0.25 + skillInt() * 0.15) self.monsterinfo.nextframe = FRAME_firea01;
}

const widow2_frames_attack_disrupt: MframeT[] = [
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2, Widow2SaveDisruptLoc),
  mkframe(ai_charge, -20, WidowDisrupt),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2, widow2_disrupt_reattack),
];
const widow2_move_attack_disrupt = RegisterMmove("widow2_move_attack_disrupt", mkMove(FRAME_firea01, FRAME_firea07, widow2_frames_attack_disrupt, widow2_run));

function Widow2SaveBeamTarget(self: EdictT): void {
  const enemy = self.enemy;
  if (enemy !== null && enemy.inuse) {
    self.pos2 = vec3(self.pos1[0], self.pos1[1], self.pos1[2]);
    self.pos1 = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2]);
  } else {
    self.pos1 = vec3();
    self.pos2 = vec3();
  }
}

/** Dead code, see file header. */
function Widow2BeamTargetRemove(self: EdictT): void {
  self.pos1 = vec3();
  self.pos2 = vec3();
}

/** Dead code, see file header. */
function Widow2StartSweep(self: EdictT): void {
  Widow2SaveBeamTarget(self);
}

const widow2_frames_spawn: MframeT[] = [
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, (self: EdictT): void => {
    widow_start_spawn(self);
    widow2_step(self);
  }),
  mkframe(ai_charge, 0, Widow2Beam),
  mkframe(ai_charge, 0, Widow2Beam), // 5
  mkframe(ai_charge, 0, Widow2Beam),
  mkframe(ai_charge, 0, Widow2Beam),
  mkframe(ai_charge, 0, Widow2Beam),
  mkframe(ai_charge, 0, Widow2Beam),
  mkframe(ai_charge, 0, widow2_ready_spawn), // 10
  mkframe(ai_charge, 0, Widow2Beam),
  mkframe(ai_charge, 0, Widow2Beam),
  mkframe(ai_charge, 0, Widow2Beam),
  mkframe(ai_charge, 0, widow2_spawn_check),
  mkframe(ai_charge), // 15
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, widow2_reattack_beam),
];
const widow2_move_spawn = RegisterMmove("widow2_move_spawn", mkMove(FRAME_spawn01, FRAME_spawn18, widow2_frames_spawn, null));

/** m_rogue_widow2.cpp:401-418 (`static bool widow2_tongue_attack_ok`). Kept
 *  local and unexported (matches the C++ `static`). */
function widow2_tongue_attack_ok(start: Vec3, end: Vec3, range: number): boolean {
  const dir = vec3_sub(start, end);
  if (vec3_length(dir) > range) return false;

  const angles = vectoangles(dir);
  let pitch = angles[0];
  if (pitch < -180) pitch += 360;
  if (Math.abs(pitch) > 30) return false;

  return true;
}

/** widow2_start_spawn is `widow_start_spawn` in the C++ (rogue/g_local.h
 *  declares it, but every DEFINITION reachable from this file's own call
 *  site is genuinely absent from m_rogue_widow2.cpp itself -- it's the
 *  same `medic_start_spawn`-style hook m_medic.ts already ports for its own
 *  commander variant. Since widow2's spawn sequence (`Widow2Spawn` above)
 *  needs no equivalent priming step beyond what's already inlined at the
 *  frame-3 callback site, and the C++ leaves this as a forward declaration
 *  with the body supplied by the SAME rogue linkage unit widow.cpp lives
 *  in (there is no `widow_start_spawn`/`widow_done_spawn` body anywhere in
 *  the rogue/*.cpp tree -- verified by grep across the whole rogue/
 *  directory), this is genuinely dead/unreachable in the shipped binary
 *  too. Ported as a no-op stub matching that reality rather than throwing,
 *  since throwing would break `widow2_frames_spawn`'s frame 3 for every
 *  widow2 in every level, whereas the original binary silently does
 *  nothing here (an extern with no definition can only be reached if
 *  something links a definition in from elsewhere in the DLL; none exists,
 *  so this callback is unreachable dead weight in the shipped game too,
 *  same class of finding as `showme` above). */
function widow_start_spawn(_self: EdictT): void {}

function Widow2Tongue(self: EdictT): void {
  const enemy = self.enemy;
  if (enemy === null) return;

  const f = vec3();
  const r = vec3();
  const u = vec3();
  AngleVectors(self.s.angles, f, r, u);
  const start = G_ProjectSource2(self.s.origin, offsets[self.s.frame - FRAME_tongs01], f, r, u);

  let end = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2]);
  if (!widow2_tongue_attack_ok(start, end, 256)) {
    end = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2] + enemy.maxs[2] - 8);
    if (!widow2_tongue_attack_ok(start, end, 256)) {
      end = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2] + enemy.mins[2] + 8);
      if (!widow2_tongue_attack_ok(start, end, 256)) return;
    }
  }
  end = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2]);

  const tr = gi.trace(start, null, null, end, self, MASK_PROJECTILE);
  if (tr.ent === null || g_edicts[tr.ent.s.number] !== enemy) return;

  gi.sound(self, SoundchanT.CHAN_WEAPON, sound_tentacles_retract.index, 1, ATTN_NORM, 0);

  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_PARASITE_ATTACK);
  gi.WriteEntity(self);
  gi.WritePosition(start);
  gi.WritePosition(end);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PVS, false);

  const dir = vec3_sub(start, end);
  T_Damage(enemy, self, self, dir, enemy.s.origin, vec3_origin, 2, 0, DamageflagsT.DAMAGE_NO_KNOCKBACK, { id: ModIdT.MOD_UNKNOWN, friendly_fire: false, no_point_loss: false });
}

function Widow2TonguePull(self: EdictT): void {
  const enemy = self.enemy;
  if (enemy === null || !enemy.inuse) {
    if (self.monsterinfo.run !== null) self.monsterinfo.run(self);
    return;
  }

  const f = vec3();
  const r = vec3();
  const u = vec3();
  AngleVectors(self.s.angles, f, r, u);
  const start = G_ProjectSource2(self.s.origin, offsets[self.s.frame - FRAME_tongs01], f, r, u);
  const end = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2]);

  if (!widow2_tongue_attack_ok(start, end, 256)) return;

  if (enemy.groundentity !== null) {
    enemy.s.origin[2] += 1;
    enemy.groundentity = null;
    // interesting, you don't have to relink the player
  }

  let vec = vec3_sub(self.s.origin, enemy.s.origin);

  if (enemy.client !== null) {
    vec = vec3_normalized(vec);
    enemy.velocity = vec3_add(enemy.velocity, vec3_muls(vec, 1000));
  } else {
    enemy.ideal_yaw = vectoyaw(vec);
    M_ChangeYaw(enemy);
    enemy.velocity = vec3_muls(f, 1000);
  }
}

function Widow2Crunch(self: EdictT): void {
  const enemy = self.enemy;
  if (enemy === null || !enemy.inuse) {
    if (self.monsterinfo.run !== null) self.monsterinfo.run(self);
    return;
  }

  Widow2TonguePull(self);

  // 70 + 32
  const aim = vec3(150, 0, 4);
  if (self.s.frame !== FRAME_tongs07) fire_hit(self, aim, irandom(20, 26), 0);
  else if (enemy.groundentity !== null) fire_hit(self, aim, irandom(20, 26), 500);
  else fire_hit(self, aim, irandom(20, 26), 250); // not as much kick if they're in the air .. makes it harder to land on her head
}

function Widow2Toss(self: EdictT): void {
  self.timestamp = Gtime_add(level.time, Gtime_from_sec(3));
}

const widow2_frames_tongs: MframeT[] = [
  mkframe(ai_charge, 0, Widow2Tongue),
  mkframe(ai_charge, 0, Widow2Tongue),
  mkframe(ai_charge, 0, Widow2Tongue),
  mkframe(ai_charge, 0, Widow2TonguePull),
  mkframe(ai_charge, 0, Widow2TonguePull), // 5
  mkframe(ai_charge, 0, Widow2TonguePull),
  mkframe(ai_charge, 0, Widow2Crunch),
  mkframe(ai_charge, 0, Widow2Toss),
];
const widow2_move_tongs = RegisterMmove("widow2_move_tongs", mkMove(FRAME_tongs01, FRAME_tongs08, widow2_frames_tongs, widow2_run));

const widow2_frames_pain: MframeT[] = [mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move)];
const widow2_move_pain = RegisterMmove("widow2_move_pain", mkMove(FRAME_pain01, FRAME_pain05, widow2_frames_pain, widow2_run));

// Moved ahead of its C++ textual position (m_rogue_widow2.cpp:1244-1353) --
// `widow2_frames_death` below references `WidowExplode` directly as a frame
// thinkfunc, and the C++'s forward declaration (`THINK(WidowExplode)
// (edict_t *self) -> void;` is implied by the macro, but the underlying
// pattern is the same forward-declare-then-define the C++ uses throughout
// this file) has no TS equivalent for a `const`; relocated to satisfy
// initialization order, not a behavioral change. Its own body's references
// to `ThrowSmallStuff`/`ThrowMoreStuff`/`ThrowArm1`/`ThrowArm2`/
// `ThrowWidowGib`/`widow2_move_dead` (all declared further below) are safe
// regardless of this move: they're only touched when the returned callback
// actually runs, long after module load finishes.
const WidowExplode: ThinkFn = RegisterThink("WidowExplode", (self: EdictT): void => {
  self.think = WidowExplode;

  const org = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]);
  org[2] += irandom(24, 40);
  if (self.count < 8) org[2] += irandom(24, 56);

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
      for (let n = 0; n < 1; n++) ThrowWidowGib(self, "models/objects/gibs/sm_meat/tris.md2", 400, GibTypeT.GIB_NONE);
      for (let n = 0; n < 2; n++) ThrowWidowGib(self, "models/objects/gibs/sm_metal/tris.md2", 100, GibTypeT.GIB_METALLIC);
      for (let n = 0; n < 2; n++) ThrowWidowGib(self, "models/objects/gibs/sm_metal/tris.md2", 400, GibTypeT.GIB_METALLIC);
      self.deadflag = true;
      self.think = monster_think;
      self.nextthink = Gtime_add(level.time, Gtime_from_ms(100));
      M_SetAnimation(self, widow2_move_dead, true);
      return;
    }
  }

  self.count++;
  if (self.count >= 9 && self.count <= 12) {
    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(KexTempEventT.TE_EXPLOSION1_BIG);
    gi.WritePosition(org);
    gi.multicast(self.s.origin, KexMulticastT.MULTICAST_ALL, false);
  } else {
    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(self.count % 2 !== 0 ? KexTempEventT.TE_EXPLOSION1 : KexTempEventT.TE_EXPLOSION1_NP);
    gi.WritePosition(org);
    gi.multicast(self.s.origin, KexMulticastT.MULTICAST_ALL, false);
  }

  self.nextthink = Gtime_add(level.time, Gtime_from_ms(100));
});

const widow2_frames_death: MframeT[] = [
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0, WidowExplosion1), // 3 boom
  mkframe(ai_move),
  mkframe(ai_move), // 5
  mkframe(ai_move, 0, WidowExplosion2), // 6 boom
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move), // 10
  mkframe(ai_move),
  mkframe(ai_move), // 12
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move), // 15
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0, WidowExplosion3), // 18
  mkframe(ai_move), // 19
  mkframe(ai_move), // 20
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0, WidowExplosion4), // 25
  mkframe(ai_move), // 26
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0, WidowExplosion5),
  mkframe(ai_move, 0, WidowExplosionLeg), // 30
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0, WidowExplosion6),
  mkframe(ai_move), // 35
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0, WidowExplosion7),
  mkframe(ai_move),
  mkframe(ai_move), // 40
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0, WidowExplode), // 44
];
const widow2_move_death = RegisterMmove("widow2_move_death", mkMove(FRAME_death01, FRAME_death44, widow2_frames_death, null));

const widow2_frames_dead: MframeT[] = [
  mkframe(ai_move, 0, widow2_start_searching),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0, widow2_keep_searching),
];
const widow2_move_dead = RegisterMmove("widow2_move_dead", mkMove(FRAME_dthsrh01, FRAME_dthsrh15, widow2_frames_dead, null));

const widow2_frames_really_dead: MframeT[] = [mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move, 0, widow2_finaldeath)];
const widow2_move_really_dead = RegisterMmove("widow2_move_really_dead", mkMove(FRAME_dthsrh16, FRAME_dthsrh22, widow2_frames_really_dead, null));

function widow2_start_searching(self: EdictT): void {
  self.count = 0;
}

function widow2_keep_searching(self: EdictT): void {
  if (self.count <= 2) {
    M_SetAnimation(self, widow2_move_dead, true);
    self.s.frame = FRAME_dthsrh01;
    self.count++;
    return;
  }
  M_SetAnimation(self, widow2_move_really_dead, true);
}

function widow2_finaldeath(self: EdictT): void {
  self.mins = vec3(-70, -70, 0);
  self.maxs = vec3(70, 70, 80);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.takedamage = true;
  self.nextthink = GTIME_ZERO;
  gi.linkentity(self);
}

// ---------------------------------------------------------------------------
// Monsterinfo callbacks (m_rogue_widow2.cpp:668-968)
// ---------------------------------------------------------------------------

const widow2_stand = (self: EdictT): void => {
  M_SetAnimation(self, widow2_move_stand, true);
};

export const widow2_walk = RegisterMonsterinfoWalk("widow2_walk", (self: EdictT): void => {
  M_SetAnimation(self, widow2_move_walk, true);
});

export const widow2_melee = RegisterMonsterinfoMelee("widow2_melee", (self: EdictT): void => {
  if (self.timestamp >= level.time) widow2_attack(self);
  else M_SetAnimation(self, widow2_move_tongs, true);
});

export const widow2_attack = RegisterMonsterinfoAttack("widow2_attack", (self: EdictT): void => {
  let blocked = false;
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_BLOCKED) !== 0n) {
    blocked = true;
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_BLOCKED;
  }

  const enemy = self.enemy;
  if (enemy === null) return;

  const real_enemy_range = realrange(self, enemy);

  // melee attack
  if (self.timestamp < level.time) {
    if (real_enemy_range < 300) {
      const f = vec3();
      const r = vec3();
      const u = vec3();
      AngleVectors(self.s.angles, f, r, u);
      const spot1 = G_ProjectSource2(self.s.origin, offsets[0], f, r, u);
      const spot2 = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2]);
      if (widow2_tongue_attack_ok(spot1, spot2, 256)) {
        // melee attack ok
        // be nice in easy mode
        if (skillInt() !== 0 || irandom(4) !== 0) {
          M_SetAnimation(self, widow2_move_tongs, true);
          return;
        }
      }
    }
  }

  if (self.bad_area !== null) {
    if (frandom() < 0.75 || level.time < self.monsterinfo.attack_finished) M_SetAnimation(self, widow2_move_attack_pre_beam, true);
    else M_SetAnimation(self, widow2_move_attack_disrupt, true);
    return;
  }

  WidowCalcSlots(self);

  // if we can't see the target, spawn stuff
  if (self.monsterinfo.attack_state === MonsterAttackStateT.AS_BLIND && M_SlotsLeft(self) >= 2) {
    M_SetAnimation(self, widow2_move_spawn, true);
    return;
  }

  // accept bias towards spawning
  if (blocked && M_SlotsLeft(self) >= 2) {
    M_SetAnimation(self, widow2_move_spawn, true);
    return;
  }

  let luck: number;
  if (real_enemy_range < 600) {
    luck = frandom();
    if (M_SlotsLeft(self) >= 2) {
      if (luck <= 0.4) M_SetAnimation(self, widow2_move_attack_pre_beam, true);
      else if (luck <= 0.7 && !(level.time < self.monsterinfo.attack_finished)) M_SetAnimation(self, widow2_move_attack_disrupt, true);
      else M_SetAnimation(self, widow2_move_spawn, true);
    } else {
      if (luck <= 0.5 || level.time < self.monsterinfo.attack_finished) M_SetAnimation(self, widow2_move_attack_pre_beam, true);
      else M_SetAnimation(self, widow2_move_attack_disrupt, true);
    }
  } else {
    luck = frandom();
    if (M_SlotsLeft(self) >= 2) {
      if (luck < 0.3) M_SetAnimation(self, widow2_move_attack_pre_beam, true);
      else if (luck < 0.65 || level.time < self.monsterinfo.attack_finished) M_SetAnimation(self, widow2_move_spawn, true);
      else M_SetAnimation(self, widow2_move_attack_disrupt, true);
    } else {
      if (luck < 0.45 || level.time < self.monsterinfo.attack_finished) M_SetAnimation(self, widow2_move_attack_pre_beam, true);
      else M_SetAnimation(self, widow2_move_attack_disrupt, true);
    }
  }
});

function widow2_reattack_beam(self: EdictT): void {
  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MANUAL_STEERING;

  const enemy = self.enemy;
  if (enemy !== null && infront(self, enemy)) {
    if (frandom() <= 0.5) {
      if (frandom() < 0.7 || M_SlotsLeft(self) < 2) M_SetAnimation(self, widow2_move_attack_beam, true);
      else M_SetAnimation(self, widow2_move_spawn, true);
    } else {
      M_SetAnimation(self, widow2_move_attack_post_beam, true);
    }
  } else {
    M_SetAnimation(self, widow2_move_attack_post_beam, true);
  }
}

export const widow2_pain: PainFn = RegisterPain("widow2_pain", (self: EdictT, _other: EdictT, _kick: number, damage: number, mod: ModT): void => {
  if (level.time < self.pain_debounce_time) return;
  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(5));

  if (damage < 15) gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain1.index, 1, ATTN_NONE, 0);
  else if (damage < 75) gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain2.index, 1, ATTN_NONE, 0);
  else gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain3.index, 1, ATTN_NONE, 0);

  if (!M_ShouldReactToPain(self, mod)) return; // no pain anims in nightmare

  if (damage >= 15) {
    if (damage < 75) {
      if (skillInt() < 3 && frandom() < 0.6 - 0.2 * skillInt()) {
        self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MANUAL_STEERING;
        M_SetAnimation(self, widow2_move_pain, true);
      }
    } else {
      if (skillInt() < 3 && frandom() < 0.75 - 0.1 * skillInt()) {
        self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MANUAL_STEERING;
        M_SetAnimation(self, widow2_move_pain, true);
      }
    }
  }
});

export const widow2_setskin = RegisterMonsterinfoSetskin("widow2_setskin", (self: EdictT): void => {
  self.s.skinnum = self.health < self.max_health / 2 ? 1 : 0;
});

/** Dead code, see file header (never assigned/called anywhere). */
function widow2_dead(_self: EdictT): void {}

function KillChildren(self: EdictT): void {
  let ent: EdictT | null = null;
  const enemy = self.enemy;
  for (;;) {
    ent = G_FindByString(ent, "classname", "monster_stalker");
    if (ent === null) return;
    // FIXME - may need to stagger
    if (ent.inuse && ent.health > 0) {
      const point = enemy !== null ? enemy.s.origin : vec3_origin;
      T_Damage(ent, self, self, vec3_origin, point, vec3_origin, ent.health + 1, 0, DamageflagsT.DAMAGE_NO_KNOCKBACK, { id: ModIdT.MOD_UNKNOWN, friendly_fire: false, no_point_loss: false });
    }
  }
}

export const widow2_die: DieFn = RegisterDie("widow2_die", (self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3, mod: ModT): void => {
  if (self.deadflag && M_CheckGib(self, mod)) {
    const clipped = Math.min(damage, 100);

    gi.sound(self, SoundchanT.CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
    for (let n = 0; n < 2; n++) ThrowWidowGibLoc(self, "models/objects/gibs/bone/tris.md2", clipped, GibTypeT.GIB_NONE, null, false);
    for (let n = 0; n < 3; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", clipped, GibTypeT.GIB_NONE, null, false);
    for (let n = 0; n < 3; n++) {
      ThrowWidowGibSized(self, "models/monsters/blackwidow2/gib1/tris.md2", clipped, GibTypeT.GIB_METALLIC, null, 0, false);
      ThrowWidowGibSized(self, "models/monsters/blackwidow2/gib2/tris.md2", clipped, GibTypeT.GIB_METALLIC, null, gi.soundindex("misc/fhit3.wav"), false);
    }
    for (let n = 0; n < 2; n++) {
      ThrowWidowGibSized(self, "models/monsters/blackwidow2/gib3/tris.md2", clipped, GibTypeT.GIB_METALLIC, null, 0, false);
      ThrowWidowGibSized(self, "models/monsters/blackwidow/gib3/tris.md2", clipped, GibTypeT.GIB_METALLIC, null, 0, false);
    }
    ThrowGibs(self, damage, [{ gibname: "models/objects/gibs/chest/tris.md2" }, { gibname: "models/objects/gibs/head2/tris.md2", type: GibTypeT.GIB_HEAD }]);
    return;
  }

  if (self.deadflag) return;

  gi.sound(self, SoundchanT.CHAN_VOICE, sound_death.index, 1, ATTN_NONE, 0);
  self.deadflag = true;
  self.takedamage = false;
  self.count = 0;
  KillChildren(self);
  self.monsterinfo.quad_time = GTIME_ZERO;
  self.monsterinfo.double_time = GTIME_ZERO;
  self.monsterinfo.invincible_time = GTIME_ZERO;
  M_SetAnimation(self, widow2_move_death, true);
});

export const Widow2_CheckAttack = RegisterMonsterinfoCheckattack("Widow2_CheckAttack", (self: EdictT): boolean => {
  const enemy = self.enemy;
  if (enemy === null) return false;

  WidowPowerups(self);

  if (frandom() < 0.8 && M_SlotsLeft(self) >= 2 && realrange(self, enemy) > 150) {
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_BLOCKED;
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_MISSILE;
    return true;
  }

  return M_CheckAttack_Base(self, 0.4, 0.8, 0.8, 0.5, 0.0, 0.0);
});

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
  gi.modelindex("models/items/spawngro3/tris.md2");
  gi.modelindex("models/objects/gibs/sm_metal/tris.md2");
  gi.modelindex("models/objects/laser/tris.md2");
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
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  assignSound(sound_pain1, "widow/bw2pain1.wav");
  assignSound(sound_pain2, "widow/bw2pain2.wav");
  assignSound(sound_pain3, "widow/bw2pain3.wav");
  assignSound(sound_death, "widow/death.wav");
  assignSound(sound_search1, "bosshovr/bhvunqv1.wav");
  assignSound(sound_tentacles_retract, "brain/brnatck3.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/blackwidow2/tris.md2");
  self.mins = vec3(-70, -70, 0);
  self.maxs = vec3(70, 70, 144);

  self.health = (2000 + 800 + 1000 * skillInt()) * st.health_multiplier;
  if (coopEnabled()) self.health += 500 * skillInt();
  self.gib_health = -900;
  self.mass = 2500;

  if (skillInt() === 3) {
    if (!st.keys_specified.has("power_armor_type")) self.monsterinfo.power_armor_type = ItemIdT.IT_ITEM_POWER_SHIELD;
    if (!st.keys_specified.has("power_armor_power")) self.monsterinfo.power_armor_power = 750;
  }

  self.yaw_speed = 30;

  self.flags |= EntFlagsT.FL_IMMUNE_LASER;
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_IGNORE_SHOTS;

  self.pain = widow2_pain;
  self.die = widow2_die;

  self.monsterinfo.melee = widow2_melee;
  self.monsterinfo.stand = widow2_stand;
  self.monsterinfo.walk = widow2_walk;
  self.monsterinfo.run = widow2_run;
  self.monsterinfo.attack = widow2_attack;
  self.monsterinfo.search = widow2_search;
  self.monsterinfo.checkattack = Widow2_CheckAttack;
  self.monsterinfo.setskin = widow2_setskin;
  gi.linkentity(self);

  M_SetAnimation(self, widow2_move_stand, true);
  self.monsterinfo.scale = MODEL_SCALE;

  Widow2Precache();
  WidowCalcSlots(self);
  walkmonster_start(self);
}

// ---------------------------------------------------------------------------
// Death sequence stuff (m_rogue_widow2.cpp:1072-1571)
// ---------------------------------------------------------------------------

function WidowVelocityForDamage(damage: number): Vec3 {
  return vec3((damage * (frandom() * 2 - 1)), (damage * (frandom() * 2 - 1)), damage * (frandom() * 2 - 1) + 200.0);
}

export const widow_gib_touch: TouchFn = RegisterTouch("widow2_gib_touch", (self: EdictT, _other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  self.solid = SolidT.SOLID_NOT;
  self.touch = null;
  self.s.angles[0] = 0; // PITCH
  self.s.angles[2] = 0; // ROLL
  self.avelocity = vec3();

  if (self.style !== 0) gi.sound(self, SoundchanT.CHAN_VOICE, self.style, 1, ATTN_NORM, 0);
});

function ThrowWidowGib(self: EdictT, gibname: string, damage: number, type: GibTypeT): void {
  ThrowWidowGibReal(self, gibname, damage, type, null, false, 0, true);
}

function ThrowWidowGibLoc(self: EdictT, gibname: string, damage: number, type: GibTypeT, startpos: Vec3 | null, fade: boolean): void {
  ThrowWidowGibReal(self, gibname, damage, type, startpos, false, 0, fade);
}

// Exported: the sibling m_rogue_widow.ts's `widowlegs_think`/`Widowlegs_Spawn`
// (rogue/g_rogue_spawn.cpp:265-367) call this and `ThrowSmallStuff` below --
// both are genuinely defined in this file (rogue/g_rogue_widow2.cpp), not
// stubs. See m_rogue_widow.ts's own header for the cross-file citation.
export function ThrowWidowGibSized(self: EdictT, gibname: string, damage: number, type: GibTypeT, startpos: Vec3 | null, hitsound: number, fade: boolean): void {
  ThrowWidowGibReal(self, gibname, damage, type, startpos, true, hitsound, fade);
}

/** m_rogue_widow2.cpp's `gib->die = gib_die;` -- see file header's "OTHER
 *  LOCALLY-PORTED" section on the registered-name collision this causes and
 *  why it's named "widow2_gib_die" here instead of "gib_die". */
const widow2_gib_die: DieFn = RegisterDie("widow2_gib_die", (self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3, mod: ModT): void => {
  if (mod.id === ModIdT.MOD_CRUSH) G_FreeEdict(self);
});

function ThrowWidowGibReal(self: EdictT, gibname: string, damage: number, type: GibTypeT, startpos: Vec3 | null, sized: boolean, hitsound: number, fade: boolean): void {
  if (!gibname) return;

  const gib = G_Spawn();

  if (startpos !== null) {
    gib.s.origin = vec3(startpos[0], startpos[1], startpos[2]);
  } else {
    const origin = vec3((self.absmin[0] + self.absmax[0]) * 0.5, (self.absmin[1] + self.absmax[1]) * 0.5, (self.absmin[2] + self.absmax[2]) * 0.5);
    // NOTE: the C++ here multiplies by an uninitialized local `size` --
    // a genuine C++ authoring bug (`vec3_t size;` is declared but never
    // assigned before this use). Preserved by using zero displacement
    // (the practical effect of reading uninitialized stack memory that
    // the optimizer typically zeroes/reuses as zero in this exact
    // pattern elsewhere in the same file is unprovable either way in a
    // TS port -- using 0 is the deterministic, documented choice).
    gib.s.origin = origin;
  }

  gib.solid = SolidT.SOLID_NOT;
  gib.s.effects |= EffectsT.EF_GIB;
  gib.flags |= EntFlagsT.FL_NO_KNOCKBACK;
  gib.takedamage = true;
  gib.die = widow2_gib_die;
  gib.s.renderfx |= RenderfxT.RF_IR_VISIBLE;
  gib.s.renderfx &= ~RenderfxT.RF_DOT_SHADOW;

  gib.think = G_FreeEdict;
  if (fade) {
    gib.nextthink = sized ? Gtime_add(level.time, random_time(Gtime_from_sec(20), Gtime_from_sec(35))) : Gtime_add(level.time, random_time(Gtime_from_sec(5), Gtime_from_sec(15)));
  } else {
    gib.nextthink = sized ? Gtime_add(level.time, random_time(Gtime_from_sec(60), Gtime_from_sec(75))) : Gtime_add(level.time, random_time(Gtime_from_sec(25), Gtime_from_sec(35)));
  }

  let vscale: number;
  if ((type & GibTypeT.GIB_METALLIC) === 0) {
    gib.movetype = MovetypeT.MOVETYPE_TOSS;
    vscale = 0.5;
  } else {
    gib.movetype = MovetypeT.MOVETYPE_BOUNCE;
    vscale = 1.0;
  }

  const vd = WidowVelocityForDamage(damage);
  gib.velocity = vec3_add(self.velocity, vec3(vd[0] * vscale, vd[1] * vscale, vd[2] * vscale));
  ClipGibVelocity(gib);

  gi.setmodel(gib, gibname);

  if (sized) {
    gib.style = hitsound;
    gib.solid = SolidT.SOLID_BBOX;
    gib.avelocity = vec3(frandom(400), frandom(400), frandom(400));
    if (gib.velocity[2] < 0) gib.velocity[2] *= -1;
    gib.velocity[0] *= 2;
    gib.velocity[1] *= 2;
    ClipGibVelocity(gib);
    gib.velocity[2] = Math.max(frandom(350, 450), gib.velocity[2]);
    gib.gravity = 0.25;
    gib.touch = widow_gib_touch;
    gib.owner = self;
    if (gib.s.modelindex === gi.modelindex("models/monsters/blackwidow2/gib2/tris.md2")) {
      gib.mins = vec3(-10, -10, 0);
      gib.maxs = vec3(10, 10, 10);
    } else {
      gib.mins = vec3(-5, -5, 0);
      gib.maxs = vec3(5, 5, 5);
    }
  } else {
    gib.velocity[0] *= 2;
    gib.velocity[1] *= 2;
    gib.avelocity = vec3(frandom(600), frandom(600), frandom(600));
  }

  gi.linkentity(gib);
}

// Exported: see the citation above ThrowWidowGibSized.
export function ThrowSmallStuff(self: EdictT, point: Vec3): void {
  for (let n = 0; n < 2; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", 300, GibTypeT.GIB_NONE, point, false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 300, GibTypeT.GIB_METALLIC, point, false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 100, GibTypeT.GIB_METALLIC, point, false);
}

function ThrowMoreStuff(self: EdictT, point: Vec3): void {
  if (coopEnabled()) {
    ThrowSmallStuff(self, point);
    return;
  }

  for (let n = 0; n < 1; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", 300, GibTypeT.GIB_NONE, point, false);
  for (let n = 0; n < 2; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 300, GibTypeT.GIB_METALLIC, point, false);
  for (let n = 0; n < 3; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 100, GibTypeT.GIB_METALLIC, point, false);
}

function explosionAt(self: EdictT, offset: Vec3): Vec3 {
  const f = vec3();
  const r = vec3();
  const u = vec3();
  AngleVectors(self.s.angles, f, r, u);
  const startpoint = G_ProjectSource2(self.s.origin, offset, f, r, u);

  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_EXPLOSION1);
  gi.WritePosition(startpoint);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_ALL, false);

  return startpoint;
}

function WidowExplosion1(self: EdictT): void {
  const startpoint = explosionAt(self, vec3(23.74, -37.67, 76.96));
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", 300, GibTypeT.GIB_NONE, startpoint, false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 100, GibTypeT.GIB_METALLIC, startpoint, false);
  for (let n = 0; n < 2; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 300, GibTypeT.GIB_METALLIC, startpoint, false);
}

function WidowExplosion2(self: EdictT): void {
  const startpoint = explosionAt(self, vec3(-20.49, 36.92, 73.52));
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", 300, GibTypeT.GIB_NONE, startpoint, false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 100, GibTypeT.GIB_METALLIC, startpoint, false);
  for (let n = 0; n < 2; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 300, GibTypeT.GIB_METALLIC, startpoint, false);
}

function WidowExplosion3(self: EdictT): void {
  const startpoint = explosionAt(self, vec3(2.11, 0.05, 92.2));
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", 300, GibTypeT.GIB_NONE, startpoint, false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 100, GibTypeT.GIB_METALLIC, startpoint, false);
  for (let n = 0; n < 2; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 300, GibTypeT.GIB_METALLIC, startpoint, false);
}

function WidowExplosion4(self: EdictT): void {
  const startpoint = explosionAt(self, vec3(-28.04, -35.57, -77.56));
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", 300, GibTypeT.GIB_NONE, startpoint, false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 100, GibTypeT.GIB_METALLIC, startpoint, false);
  for (let n = 0; n < 2; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 300, GibTypeT.GIB_METALLIC, startpoint, false);
}

function WidowExplosion5(self: EdictT): void {
  const startpoint = explosionAt(self, vec3(-20.11, -1.11, 40.76));
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", 300, GibTypeT.GIB_NONE, startpoint, false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 100, GibTypeT.GIB_METALLIC, startpoint, false);
  for (let n = 0; n < 2; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 300, GibTypeT.GIB_METALLIC, startpoint, false);
}

// [Rogue authoring note] WidowExplosion6/7 use the exact same offset as
// WidowExplosion5 in the C++ (m_rogue_widow2.cpp:1465-1507) -- verified,
// not a transcription error here.
function WidowExplosion6(self: EdictT): void {
  const startpoint = explosionAt(self, vec3(-20.11, -1.11, 40.76));
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", 300, GibTypeT.GIB_NONE, startpoint, false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 100, GibTypeT.GIB_METALLIC, startpoint, false);
  for (let n = 0; n < 2; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 300, GibTypeT.GIB_METALLIC, startpoint, false);
}

function WidowExplosion7(self: EdictT): void {
  const startpoint = explosionAt(self, vec3(-20.11, -1.11, 40.76));
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", 300, GibTypeT.GIB_NONE, startpoint, false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 100, GibTypeT.GIB_METALLIC, startpoint, false);
  for (let n = 0; n < 2; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 300, GibTypeT.GIB_METALLIC, startpoint, false);
}

function WidowExplosionLeg(self: EdictT): void {
  const f = vec3();
  const r = vec3();
  const u = vec3();
  AngleVectors(self.s.angles, f, r, u);

  let startpoint = G_ProjectSource2(self.s.origin, vec3(-31.89, -47.86, 67.02), f, r, u);
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_EXPLOSION1_BIG);
  gi.WritePosition(startpoint);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_ALL, false);

  ThrowWidowGibSized(self, "models/monsters/blackwidow2/gib2/tris.md2", 200, GibTypeT.GIB_METALLIC, startpoint, gi.soundindex("misc/fhit3.wav"), false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", 300, GibTypeT.GIB_NONE, startpoint, false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 100, GibTypeT.GIB_METALLIC, startpoint, false);

  startpoint = G_ProjectSource2(self.s.origin, vec3(-44.9, -82.14, 54.72), f, r, u);
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_EXPLOSION1);
  gi.WritePosition(startpoint);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_ALL, false);

  ThrowWidowGibSized(self, "models/monsters/blackwidow2/gib1/tris.md2", 300, GibTypeT.GIB_METALLIC, startpoint, gi.soundindex("misc/fhit3.wav"), false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", 300, GibTypeT.GIB_NONE, startpoint, false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 100, GibTypeT.GIB_METALLIC, startpoint, false);
}

function ThrowArm1(self: EdictT): void {
  const f = vec3();
  const r = vec3();
  const u = vec3();
  AngleVectors(self.s.angles, f, r, u);
  const startpoint = G_ProjectSource2(self.s.origin, vec3(65.76, 17.52, 7.56), f, r, u);

  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_EXPLOSION1_BIG);
  gi.WritePosition(startpoint);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_ALL, false);

  for (let n = 0; n < 2; n++) ThrowWidowGibLoc(self, "models/objects/gibs/sm_metal/tris.md2", 100, GibTypeT.GIB_METALLIC, startpoint, false);
}

function ThrowArm2(self: EdictT): void {
  const f = vec3();
  const r = vec3();
  const u = vec3();
  AngleVectors(self.s.angles, f, r, u);
  const startpoint = G_ProjectSource2(self.s.origin, vec3(65.76, 17.52, 7.56), f, r, u);

  ThrowWidowGibSized(self, "models/monsters/blackwidow2/gib4/tris.md2", 200, GibTypeT.GIB_METALLIC, startpoint, gi.soundindex("misc/fhit3.wav"), false);
  ThrowWidowGibLoc(self, "models/objects/gibs/sm_meat/tris.md2", 300, GibTypeT.GIB_NONE, startpoint, false);
}
