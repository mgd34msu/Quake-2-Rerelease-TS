// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_medic.c -- the MEDIC monster (2023 Quake II re-release / "KEX" engine).
// Ported from ~/Projects/quake2-rerelease-dll/rerelease/m_medic.cpp
// (1,627 lines) + m_medic.h (248 lines, frame-index enum + MODEL_SCALE),
// C++17. Behavioral code, ported bug-for-bug per this port line's house
// conventions (see g_monster.ts/m_soldier.ts headers). One spawn function,
// `SP_monster_medic`, drives two entity variants that share every frame
// table: `monster_medic` (mass 400, no reinforcements) and
// `monster_medic_commander` (mass 600, the reinforcement-calling variant),
// selected at spawn time by `strcmp(self->classname, "monster_medic_commander")`
// -- see SP_monster_medic below.
//
// ============================================================================
// cleanupHealTarget -- REAL, not a stub (this is the file that resolves it)
// ============================================================================
// Two throwing stubs existed citing this file before this unit landed:
// g_combat.ts (its own local `cleanupHealTarget`, lines 185-186 pre-edit,
// called from Killed/T_Damage's AI_MEDIC-cleanup branches) and g_monster.ts
// (its own identical local stub, lines 2090-2091 pre-edit, called from
// G_Monster_CheckCoopHealthScaling's kill-off-oversized-monster branch).
// NOTE: the brief that spawned this unit says "g_ai.ts/g_combat.ts stub
// cleanupHealTarget" -- that's a discrepancy worth flagging explicitly: the
// actual throwing stubs live in g_combat.ts and g_monster.ts. g_ai.ts only
// MENTIONS cleanupHealTarget in a comment (its own "STUB SWAP" header
// section, documenting that g_combat.ts's cleanupHealTarget stub was
// "untouched (ROGUE mission-pack files, out of this unit's scope)" at the
// time g_ai.ts landed) -- it never declared a stub of its own.
//
// Both stubs are now deleted; g_combat.ts and g_monster.ts each import the
// real `cleanupHealTarget` below. This is a real, sanctioned, ONE-WAY import
// edge (m_medic.ts -> g_combat.ts for T_Damage, -> g_monster.ts for
// M_ProjectFlashSource/M_SetEffects/M_ShouldReactToPain/M_SetAnimation/
// M_AllowSpawn/monster_dead/monster_dead_think/walkmonster_start/
// monster_fire_blaster; -> g_ai.ts for visible/range_to/FindTarget/
// FoundTarget/HuntTarget/M_CheckAttack; -> g_spawn.ts for
// st/ClearSpawnTemp/ED_CallSpawn). Neither g_combat.ts nor g_monster.ts nor
// g_ai.ts nor g_spawn.ts imports anything back from m_medic.ts, so this is
// NOT a cycle -- a plain one-way dependency, verified by grepping all four
// files for `from "./m_medic"` before writing this file (no hits) and by
// `bunx tsc --noEmit` succeeding end-to-end after the swap.
//
// cleanupHealTarget's own C++ body (rogue/g_rogue_combat.cpp:13-18) is
// trivial -- four lines, no further cross-deps:
//   ent->monsterinfo.healer = nullptr; ent->takedamage = true;
//   ent->monsterinfo.aiflags &= ~AI_RESURRECTING; M_SetEffects(ent);
//
// ============================================================================
// THE REINFORCEMENTS FINDING
// ============================================================================
// `monsterinfo.reinforcements: ReinforcementListT` and
// `monsterinfo.chosen_reinforcements: Uint8Array` (g_local_types.ts
// ~550-561/716) and their save-wiring (g_save.ts's `reinforcementsField`,
// ~1139-3145) are ALREADY fully landed and sufficient as-is -- no changes
// needed to g_local_types.ts, g_save.ts, or g_spawn.ts. `M_SetupReinforcements`
// (below, ported for real) parses `st.reinforcements` (g_spawn.ts's raw
// semicolon-separated `"classname strength;classname strength;..."` spawn
// string, already wired as a plain string field) into that
// `ReinforcementListT` at commander spawn time by literally spawning and
// immediately freeing one throwaway edict per reinforcement type just to
// read its `mins`/`maxs` off `ED_CallSpawn` -- ported verbatim, including
// that spawn/free round-trip (m_medic.cpp:116-167).
//
// The bigger finding: nearly every helper `medic_determine_spawn`/
// `medic_spawngrows`/`medic_finish_spawn` need to actually place and create
// reinforcement monsters (`CreateGroundMonster`, `FindSpawnPoint`,
// `CheckSpawnPoint`, `CheckGroundSpawnPoint`, `SpawnGrow_Spawn`,
// `M_SlotsLeft`, `PickCoopTarget`, `realrange`) are declared in g_local.h
// but DEFINED in rogue/g_rogue_spawn.cpp, rogue/g_rogue_monster.cpp, and
// rogue/g_rogue_newai.cpp -- none of which have a ported .ts file yet. BUT:
// every primitive those bodies actually need (`M_droptofloor_generic` --
// g_monster.ts; `G_FixStuckObject_Generic` -- p_move.ts;
// `M_CheckBottom_Fast_Generic`/`M_CheckBottom_Slow_Generic` -- m_move.ts;
// `findradius`/`G_Spawn`/`G_FreeEdict` -- g_utils.ts; `visible` -- g_ai.ts)
// is ALREADY landed and exported. So instead of stubbing the whole
// reinforcement-spawning chain, this file ports `realrange`, `M_SlotsLeft`,
// `PickCoopTarget`, `CreateGroundMonster`, `FindSpawnPoint`, `CheckSpawnPoint`,
// `CheckGroundSpawnPoint`, and `SpawnGrow_Spawn` FOR REAL, locally
// (unexported -- narrow, single-consumer helpers, matching the
// "monster_footstep/M_CheckGib" trivial-local-duplicate idiom), each cited
// to its actual rogue/g_rogue_*.cpp source. The ONLY genuinely-stubbed piece
// of the commander path is `monster_fire_blaster2`/`fire_blaster2`
// (rogue/g_rogue_monster.cpp:7 / rogue/g_rogue_newweap.cpp:1374) -- unlike
// the spawn-placement helpers above, `fire_blaster2` is a full second
// blaster-bolt PROJECTILE weapon (its own spawn/touch/think, not a thin
// wrapper around the already-ported `fire_blaster`), a weapons-file concern
// out of this unit's scope, exactly like m_soldier.ts's own xatrix
// ionripper/blueblaster stubs. It is reached only from `medic_fire_blaster`
// when `self.mass > 400` (commander) -- narrowly gated, not a landmine: a
// base `monster_medic` (mass 400) never reaches it, and even a commander
// only reaches it on its blaster-attack branch, not its (equally likely)
// reinforcement-calling or cable-heal branches.
//
// ============================================================================
// OTHER LOCALLY-PORTED, NARROWLY-GATED, OR SHARED CROSS-DEPS
// ============================================================================
// - `monster_duck_down`/`monster_duck_hold`/`monster_duck_up`/
//   `monster_done_dodge`/`M_MonsterDodge`: imported for real from
//   m_soldier.ts (confirmed exported there; never re-registered here --
//   `self.monsterinfo.dodge = M_MonsterDodge` reuses the SAME registered
//   save name "M_MonsterDodge" m_soldier.ts already claimed).
// - `anglemod` (q_std.h's kex-own fmod-based copy) and `COM_ParseEx`
//   (no ported equivalent) follow this port line's established per-file
//   duplication idioms: `anglemod` is a local unexported copy (matching
//   g_ai.ts/m_move.ts/g_misc.ts/g_func.ts's own local copies);
//   `M_SetupReinforcements`'s `COM_ParseEx(&p, "; ")` tokenizing becomes a
//   plain `.split(";")` + per-entry `.split(/\s+/)` (matching p_client.ts's/
//   g_misc.ts's own "COM_ParseEx with a fixed delimiter set -> plain split"
//   precedent).
// - `coop->integer` (`CvarT` has no cached `.integer`, see g_utils.ts's own
//   header note) and `skill->integer`/`skill->value`: local unexported
//   `coopEnabled()`/`skillValue()` helpers, matching g_utils.ts's own
//   `coopEnabled()` idiom exactly (fresh `gi.cvar(...)` lookup each call,
//   not a cached module-level cvar handle).
// - `monster_footstep`/`M_CheckGib` (g_local.h inline helpers): duplicated
//   locally, unexported, matching m_soldier.ts's own precedent verbatim.
// - `M_PickValidReinforcements`'s C++ `static std::vector<uint8_t> &output`
//   out-param (a function-local `static` vector reused across calls, purely
//   a perf micro-optimization with no observable behavioral effect) is
//   ported as a plain returned array instead of a shared mutable
//   module-level buffer -- dropping an allocation-reuse optimization that
//   has no observable effect on behavior, not a behavioral deviation.
// - `M_PickReinforcements`'s `int32_t &num_chosen` out-param becomes part of
//   the returned `{ chosen, numChosen }` object (an out-param that is a
//   genuine second return value, not a fixed-field alias -- kept, per
//   PORTING.md's own distinction, unlike M_CatagorizePosition's dropped
//   out-params documented in g_monster.ts's header).
// - Nullable monsterinfo function-field calls (`self.monsterinfo.stand(self)`,
//   `.unduck(self)`, `.setskin(...)`) use a local `must()` null-assertion
//   helper that throws with the same message shape g_ai.ts's `HuntTarget`
//   inlines by hand at each call site (`monsterinfo.X is null for
//   <classname>`) -- collapsed into one helper here purely to cut
//   repetition across this file's many call sites; identical throwing
//   behavior.

import { vec3, type Vec3 } from "../shared/math";
import { AngleVectors, vec3_sub, vec3_length } from "./q_vec3";
import { type CvarT } from "../shared/q_shared";
import {
  MonsterMuzzleflashIdT,
  SoundchanT,
  EffectsT,
  SvflagsT,
  CvarFlagsT,
  ATTN_NORM,
  ATTN_IDLE,
  MASK_PROJECTILE,
  MASK_WATER,
  MASK_SOLID,
  MASK_MONSTERSOLID,
  ServerCommandT,
  KexMulticastT,
  KexTempEventT,
  RenderfxT,
  RF_BEAM_LIGHTNING,
  MODELINDEX_WORLD,
  type KexEdictT,
} from "../kexapi/game";
import type { ModT, ReinforcementListT, ReinforcementT, MonsterinfoIdleFn, MonsterinfoSearchFn } from "./g_local_types";
import { MframeT, MmoveT, MmoveEndfuncFn, PainFn, DieFn, ThinkFn } from "./g_local_types";
import {
  RegisterMmove,
  RegisterPain,
  RegisterDie,
  RegisterMonsterinfoIdle,
  RegisterMonsterinfoSearch,
  RegisterMonsterinfoStand,
  RegisterMonsterinfoWalk,
  RegisterMonsterinfoRun,
  RegisterMonsterinfoAttack,
  RegisterMonsterinfoSight,
  RegisterMonsterinfoSetskin,
  RegisterMonsterinfoBlocked,
  RegisterMonsterinfoDuck,
  RegisterMonsterinfoUnduck,
  RegisterMonsterinfoSidestep,
  RegisterMonsterinfoCheckattack,
} from "./g_save_registry";
import {
  type EdictT,
  MonsterAiFlagsT,
  MonsterAttackStateT,
  RANGE_MELEE,
  GibTypeT,
  AI_SPAWNED_MASK,
  HOLD_FOREVER,
  StuckResultT,
} from "./g_local";
import { gi, level, g_edicts, game } from "./g_main_globals";
import { SPAWNFLAGS_NONE } from "./spawnflags";
import { ai_stand, ai_walk, ai_run, ai_move, ai_charge, visible, range_to, FindTarget, FoundTarget, HuntTarget, M_CheckAttack } from "./g_ai";
import {
  monster_fire_blaster,
  M_ProjectFlashSource,
  M_SetAnimation,
  M_AllowSpawn,
  M_SetEffects,
  M_ShouldReactToPain,
  monster_dead,
  monster_dead_think,
  walkmonster_start,
  M_droptofloor_generic,
  monster_muzzleflash,
} from "./g_monster";
import { ThrowGibs } from "./g_misc";
import { findradius, G_Spawn, G_FreeEdict, G_CopyString } from "./g_utils";
import { T_Damage } from "./g_combat";
import { st, ClearSpawnTemp, ED_CallSpawn } from "./g_spawn";
import { G_FixStuckObject_Generic } from "./p_move";
import type { StuckObjectTraceFn } from "./bg_local";
import { M_CheckBottom_Fast_Generic, M_CheckBottom_Slow_Generic } from "./m_move";
import { Gtime_add, Gtime_subtract, Gtime_from_sec, Gtime_from_ms, Gtime_nonzero, Gtime_seconds, type GTime } from "./gtime";
import { frandom, irandom, random_element, clamp, lerp } from "./q_std";
import { ModIdT } from "./g_local";
import { monster_done_dodge, monster_duck_down, monster_duck_hold, monster_duck_up, M_MonsterDodge } from "./m_soldier";
import { blocked_checkplat } from "./m_supertank";
import { monsterFlashOffset as monsterFlashOffsetTable } from "./m_flash";

// ---------------------------------------------------------------------------
// m_medic.h frame-index enum (248 lines; anonymous enum, declaration order =
// array index, starting at 0) + MODEL_SCALE.
// ---------------------------------------------------------------------------

export const FRAME_walk1 = 0;
export const FRAME_walk2 = 1;
export const FRAME_walk3 = 2;
export const FRAME_walk4 = 3;
export const FRAME_walk5 = 4;
export const FRAME_walk6 = 5;
export const FRAME_walk7 = 6;
export const FRAME_walk8 = 7;
export const FRAME_walk9 = 8;
export const FRAME_walk10 = 9;
export const FRAME_walk11 = 10;
export const FRAME_walk12 = 11;
export const FRAME_wait1 = 12;
export const FRAME_wait2 = 13;
export const FRAME_wait3 = 14;
export const FRAME_wait4 = 15;
export const FRAME_wait5 = 16;
export const FRAME_wait6 = 17;
export const FRAME_wait7 = 18;
export const FRAME_wait8 = 19;
export const FRAME_wait9 = 20;
export const FRAME_wait10 = 21;
export const FRAME_wait11 = 22;
export const FRAME_wait12 = 23;
export const FRAME_wait13 = 24;
export const FRAME_wait14 = 25;
export const FRAME_wait15 = 26;
export const FRAME_wait16 = 27;
export const FRAME_wait17 = 28;
export const FRAME_wait18 = 29;
export const FRAME_wait19 = 30;
export const FRAME_wait20 = 31;
export const FRAME_wait21 = 32;
export const FRAME_wait22 = 33;
export const FRAME_wait23 = 34;
export const FRAME_wait24 = 35;
export const FRAME_wait25 = 36;
export const FRAME_wait26 = 37;
export const FRAME_wait27 = 38;
export const FRAME_wait28 = 39;
export const FRAME_wait29 = 40;
export const FRAME_wait30 = 41;
export const FRAME_wait31 = 42;
export const FRAME_wait32 = 43;
export const FRAME_wait33 = 44;
export const FRAME_wait34 = 45;
export const FRAME_wait35 = 46;
export const FRAME_wait36 = 47;
export const FRAME_wait37 = 48;
export const FRAME_wait38 = 49;
export const FRAME_wait39 = 50;
export const FRAME_wait40 = 51;
export const FRAME_wait41 = 52;
export const FRAME_wait42 = 53;
export const FRAME_wait43 = 54;
export const FRAME_wait44 = 55;
export const FRAME_wait45 = 56;
export const FRAME_wait46 = 57;
export const FRAME_wait47 = 58;
export const FRAME_wait48 = 59;
export const FRAME_wait49 = 60;
export const FRAME_wait50 = 61;
export const FRAME_wait51 = 62;
export const FRAME_wait52 = 63;
export const FRAME_wait53 = 64;
export const FRAME_wait54 = 65;
export const FRAME_wait55 = 66;
export const FRAME_wait56 = 67;
export const FRAME_wait57 = 68;
export const FRAME_wait58 = 69;
export const FRAME_wait59 = 70;
export const FRAME_wait60 = 71;
export const FRAME_wait61 = 72;
export const FRAME_wait62 = 73;
export const FRAME_wait63 = 74;
export const FRAME_wait64 = 75;
export const FRAME_wait65 = 76;
export const FRAME_wait66 = 77;
export const FRAME_wait67 = 78;
export const FRAME_wait68 = 79;
export const FRAME_wait69 = 80;
export const FRAME_wait70 = 81;
export const FRAME_wait71 = 82;
export const FRAME_wait72 = 83;
export const FRAME_wait73 = 84;
export const FRAME_wait74 = 85;
export const FRAME_wait75 = 86;
export const FRAME_wait76 = 87;
export const FRAME_wait77 = 88;
export const FRAME_wait78 = 89;
export const FRAME_wait79 = 90;
export const FRAME_wait80 = 91;
export const FRAME_wait81 = 92;
export const FRAME_wait82 = 93;
export const FRAME_wait83 = 94;
export const FRAME_wait84 = 95;
export const FRAME_wait85 = 96;
export const FRAME_wait86 = 97;
export const FRAME_wait87 = 98;
export const FRAME_wait88 = 99;
export const FRAME_wait89 = 100;
export const FRAME_wait90 = 101;
export const FRAME_run1 = 102;
export const FRAME_run2 = 103;
export const FRAME_run3 = 104;
export const FRAME_run4 = 105;
export const FRAME_run5 = 106;
export const FRAME_run6 = 107;
export const FRAME_paina1 = 108;
export const FRAME_paina2 = 109;
export const FRAME_paina3 = 110;
export const FRAME_paina4 = 111;
export const FRAME_paina5 = 112;
export const FRAME_paina6 = 113;
export const FRAME_paina7 = 114;
export const FRAME_paina8 = 115;
export const FRAME_painb1 = 116;
export const FRAME_painb2 = 117;
export const FRAME_painb3 = 118;
export const FRAME_painb4 = 119;
export const FRAME_painb5 = 120;
export const FRAME_painb6 = 121;
export const FRAME_painb7 = 122;
export const FRAME_painb8 = 123;
export const FRAME_painb9 = 124;
export const FRAME_painb10 = 125;
export const FRAME_painb11 = 126;
export const FRAME_painb12 = 127;
export const FRAME_painb13 = 128;
export const FRAME_painb14 = 129;
export const FRAME_painb15 = 130;
export const FRAME_duck1 = 131;
export const FRAME_duck2 = 132;
export const FRAME_duck3 = 133;
export const FRAME_duck4 = 134;
export const FRAME_duck5 = 135;
export const FRAME_duck6 = 136;
export const FRAME_duck7 = 137;
export const FRAME_duck8 = 138;
export const FRAME_duck9 = 139;
export const FRAME_duck10 = 140;
export const FRAME_duck11 = 141;
export const FRAME_duck12 = 142;
export const FRAME_duck13 = 143;
export const FRAME_duck14 = 144;
export const FRAME_duck15 = 145;
export const FRAME_duck16 = 146;
export const FRAME_death1 = 147;
export const FRAME_death2 = 148;
export const FRAME_death3 = 149;
export const FRAME_death4 = 150;
export const FRAME_death5 = 151;
export const FRAME_death6 = 152;
export const FRAME_death7 = 153;
export const FRAME_death8 = 154;
export const FRAME_death9 = 155;
export const FRAME_death10 = 156;
export const FRAME_death11 = 157;
export const FRAME_death12 = 158;
export const FRAME_death13 = 159;
export const FRAME_death14 = 160;
export const FRAME_death15 = 161;
export const FRAME_death16 = 162;
export const FRAME_death17 = 163;
export const FRAME_death18 = 164;
export const FRAME_death19 = 165;
export const FRAME_death20 = 166;
export const FRAME_death21 = 167;
export const FRAME_death22 = 168;
export const FRAME_death23 = 169;
export const FRAME_death24 = 170;
export const FRAME_death25 = 171;
export const FRAME_death26 = 172;
export const FRAME_death27 = 173;
export const FRAME_death28 = 174;
export const FRAME_death29 = 175;
export const FRAME_death30 = 176;
export const FRAME_attack1 = 177;
export const FRAME_attack2 = 178;
export const FRAME_attack3 = 179;
export const FRAME_attack4 = 180;
export const FRAME_attack5 = 181;
export const FRAME_attack6 = 182;
export const FRAME_attack7 = 183;
export const FRAME_attack8 = 184;
export const FRAME_attack9 = 185;
export const FRAME_attack10 = 186;
export const FRAME_attack11 = 187;
export const FRAME_attack12 = 188;
export const FRAME_attack13 = 189;
export const FRAME_attack14 = 190;
export const FRAME_attack15 = 191;
export const FRAME_attack16 = 192;
export const FRAME_attack17 = 193;
export const FRAME_attack18 = 194;
export const FRAME_attack19 = 195;
export const FRAME_attack20 = 196;
export const FRAME_attack21 = 197;
export const FRAME_attack22 = 198;
export const FRAME_attack23 = 199;
export const FRAME_attack24 = 200;
export const FRAME_attack25 = 201;
export const FRAME_attack26 = 202;
export const FRAME_attack27 = 203;
export const FRAME_attack28 = 204;
export const FRAME_attack29 = 205;
export const FRAME_attack30 = 206;
export const FRAME_attack31 = 207;
export const FRAME_attack32 = 208;
export const FRAME_attack33 = 209;
export const FRAME_attack34 = 210;
export const FRAME_attack35 = 211;
export const FRAME_attack36 = 212;
export const FRAME_attack37 = 213;
export const FRAME_attack38 = 214;
export const FRAME_attack39 = 215;
export const FRAME_attack40 = 216;
export const FRAME_attack41 = 217;
export const FRAME_attack42 = 218;
export const FRAME_attack43 = 219;
export const FRAME_attack44 = 220;
export const FRAME_attack45 = 221;
export const FRAME_attack46 = 222;
export const FRAME_attack47 = 223;
export const FRAME_attack48 = 224;
export const FRAME_attack49 = 225;
export const FRAME_attack50 = 226;
export const FRAME_attack51 = 227;
export const FRAME_attack52 = 228;
export const FRAME_attack53 = 229;
export const FRAME_attack54 = 230;
export const FRAME_attack55 = 231;
export const FRAME_attack56 = 232;
export const FRAME_attack57 = 233;
export const FRAME_attack58 = 234;
export const FRAME_attack59 = 235;
export const FRAME_attack60 = 236;

export const MODEL_SCALE = 1.0;

// ---------------------------------------------------------------------------
// constants (m_medic.cpp:15-17, 56-67, 836-847)
// ---------------------------------------------------------------------------

const MEDIC_MIN_DISTANCE = 32;
const MEDIC_MAX_HEAL_DISTANCE = 400;
const MEDIC_TRY_TIME: GTime = Gtime_from_sec(10);

const MAX_REINFORCEMENTS = 5; // g_local.ts's own MAX_REINFORCEMENTS -- duplicated as a literal here to match the C++ constexpr's use in this file's own array sizing; see g_local.ts:748 for the canonical export other files import.
const default_reinforcements = "monster_soldier_light 1;monster_soldier 2;monster_soldier_ss 2;monster_infantry 3;monster_gunner 4;monster_medic 5;monster_gladiator 6";
const default_monster_slots_base = 3;
const inverse_log_slots = Math.pow(2, MAX_REINFORCEMENTS);

const reinforcement_position: readonly Vec3[] = [vec3(80, 0, 0), vec3(40, 60, 0), vec3(40, -60, 0), vec3(0, 80, 0), vec3(0, -80, 0)];

const medic_cable_offsets: readonly Vec3[] = [
  vec3(45.0, -9.2, 15.5),
  vec3(48.4, -9.7, 15.2),
  vec3(47.8, -9.8, 15.8),
  vec3(47.3, -9.3, 14.3),
  vec3(45.4, -10.1, 13.1),
  vec3(41.9, -12.7, 12.0),
  vec3(37.8, -15.8, 11.2),
  vec3(34.3, -18.4, 10.7),
  vec3(32.7, -19.7, 10.4),
  vec3(32.7, -19.7, 10.4),
];

// ---------------------------------------------------------------------------
// cached_soundindex fields -- see m_soldier.ts's own precedent for this
// idiom's rationale.
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

const sound_idle1 = mkSound();
const sound_pain1 = mkSound();
const sound_pain2 = mkSound();
const sound_die = mkSound();
const sound_sight = mkSound();
const sound_search = mkSound();
const sound_hook_launch = mkSound();
const sound_hook_hit = mkSound();
const sound_hook_heal = mkSound();
const sound_hook_retract = mkSound();

// PMM - commander sounds
const commander_sound_idle1 = mkSound();
const commander_sound_pain1 = mkSound();
const commander_sound_pain2 = mkSound();
const commander_sound_die = mkSound();
const commander_sound_sight = mkSound();
const commander_sound_search = mkSound();
const commander_sound_hook_launch = mkSound();
const commander_sound_hook_hit = mkSound();
const commander_sound_hook_heal = mkSound();
const commander_sound_hook_retract = mkSound();
const commander_sound_spawn = mkSound();

// ---------------------------------------------------------------------------
// mkframe/mkMove local builders -- see m_soldier.ts's own precedent.
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

/** Throws with the same message shape g_ai.ts's HuntTarget inlines by hand
 *  at each nullable-monsterinfo-fn call site; collapsed here to cut
 *  repetition -- see file header. */
function must<T>(fn: T | null, name: string, self: EdictT): T {
  if (fn === null) throw new Error(`m_medic: ${name} is null for ${self.classname ?? "?"}`);
  return fn;
}

// ---------------------------------------------------------------------------
// trivial g_local.h inlines, duplicated locally per this port line's
// established convention (see m_soldier.ts's own header for the same two).
// ---------------------------------------------------------------------------

/** g_local.h:3281-3286 `inline void monster_footstep(edict_t *self)`. */
function monster_footstep(self: EdictT): void {
  if (!self.groundentity) return;
  gi.sound(self, SoundchanT.CHAN_BODY, gi.soundindex(`player/step${irandom(1, 5)}.wav`), 1, ATTN_NORM, 0);
}

/** g_local.h:3521-3529 `inline bool M_CheckGib(edict_t *self, const mod_t &mod)`. */
function M_CheckGib(self: EdictT, mod: ModT): boolean {
  if (self.health <= self.gib_health) {
    return mod.id !== ModIdT.MOD_CHAINFIST || self.health <= self.gib_health * 2;
  }
  return false;
}

/** q_std.h:185 -- kex's OWN anglemod (fmod-based). See g_ai.ts's/m_move.ts's/
 *  g_misc.ts's own identical local copies. */
function anglemod(a: number): number {
  return (360.0 / 65536) * (Math.trunc((a * (65536 / 360.0)) % 65536) & 65535);
}

/** coop->integer, worked around per g_utils.ts's own local `coopEnabled()`
 *  precedent (CvarT has no cached `.integer`). */
function coopEnabled(): boolean {
  const c: CvarT | null = gi.cvar("coop", "0", CvarFlagsT.CVAR_LATCH);
  return c !== null && c.value !== 0;
}

/** skill->value, worked around the same way. */
function skillValue(): number {
  const c: CvarT | null = gi.cvar("skill", "1", CvarFlagsT.CVAR_LATCH);
  return c === null ? 1 : c.value;
}

const MOD_UNKNOWN: ModT = { id: ModIdT.MOD_UNKNOWN, friendly_fire: false, no_point_loss: false };

// ---------------------------------------------------------------------------
// realrange / M_SlotsLeft / PickCoopTarget -- ported for real, locally.
// See file header's "THE REINFORCEMENTS FINDING" section.
// ---------------------------------------------------------------------------

/** rogue/g_rogue_newai.cpp:914-921. */
function realrange(self: EdictT, other: EdictT): number {
  return vec3_length(vec3_sub(self.s.origin, other.s.origin));
}

/** rogue/g_rogue_monster.cpp:105-108. */
function M_SlotsLeft(self: EdictT): number {
  return self.monsterinfo.monster_slots - self.monsterinfo.monster_used;
}

/** rogue/g_rogue_newai.cpp:1508-1534 -- returns a randomly-selected visible
 *  coop player, or null outside coop / with none visible. */
function PickCoopTarget(self: EdictT): EdictT | null {
  if (!coopEnabled()) return null;

  const targets: EdictT[] = [];
  for (let player = 1; player <= game.maxclients; player++) {
    const ent = g_edicts[player];
    if (!ent.inuse) continue;
    if (ent.client === null) continue;
    if (visible(self, ent)) targets.push(ent);
  }

  if (targets.length === 0) return null;

  return targets[irandom(targets.length)];
}

// ---------------------------------------------------------------------------
// CreateGroundMonster / FindSpawnPoint / CheckSpawnPoint /
// CheckGroundSpawnPoint -- ported for real, locally
// (rogue/g_rogue_spawn.cpp:31-152). See file header's "THE REINFORCEMENTS
// FINDING" section.
// ---------------------------------------------------------------------------

/** rogue/g_rogue_spawn.cpp:112-127. The C++'s `if (!mins || !maxs) return
 *  false;` guards against literal null pointers -- inapplicable here since
 *  this port's `mins`/`maxs` are always real `Vec3` values, never null;
 *  dropped, not ported, matching this port line's precedent for C
 *  null-pointer guards with no TS equivalent given the narrower signature. */
function CheckSpawnPoint(origin: Vec3, mins: Vec3, maxs: Vec3): boolean {
  const tr = gi.trace(origin, mins, maxs, origin, null, MASK_MONSTERSOLID);
  if (tr.startsolid || tr.allsolid) return false;
  if (tr.ent !== g_edicts[0]) return false;
  return true;
}

/** rogue/g_rogue_spawn.cpp:139-151. */
function CheckGroundSpawnPoint(origin: Vec3, entMins: Vec3, entMaxs: Vec3, height: number, _gravity: number): boolean {
  if (!CheckSpawnPoint(origin, entMins, entMaxs)) return false;

  if (M_CheckBottom_Fast_Generic(vec3(origin[0] + entMins[0], origin[1] + entMins[1], origin[2] + entMins[2]), vec3(origin[0] + entMaxs[0], origin[1] + entMaxs[1], origin[2] + entMaxs[2]), false)) return true;

  // `M_CheckBottom_Slow_Generic`'s `ignore` param is typed non-nullable
  // `EdictT` (every OTHER call site passes a real entity) -- the C++'s
  // `nullptr` ignore here is stood in for with the world edict, which
  // traces identically (world/BSP geometry always collides regardless of
  // `passent`; `passent` only ever excludes a specific MOVABLE entity).
  if (M_CheckBottom_Slow_Generic(origin, entMins, entMaxs, g_edicts[0], MASK_MONSTERSOLID, false, false)) return true;

  return false;
}

/** rogue/g_rogue_spawn.cpp:79-97. NOTE: `maxMoveUp` is genuinely unused in
 *  the C++ body (never referenced) -- kept as an unused parameter to match
 *  the call signature bug-for-bug, per this port line's "dead C parameter,
 *  kept" precedent. */
function FindSpawnPoint(startpoint: Vec3, mins: Vec3, maxs: Vec3, _maxMoveUp: number, drop: boolean = true): Vec3 | null {
  let spawnpoint = vec3(startpoint[0], startpoint[1], startpoint[2]);

  if (!drop || !M_droptofloor_generic(spawnpoint, mins, maxs, false, null, MASK_MONSTERSOLID, false)) {
    spawnpoint = vec3(startpoint[0], startpoint[1], startpoint[2]);

    const trace_func: StuckObjectTraceFn = (start, tmins, tmaxs, end) => gi.trace(start, tmins, tmaxs, end, null, MASK_MONSTERSOLID);
    if (G_FixStuckObject_Generic(spawnpoint, mins, maxs, trace_func) === StuckResultT.NO_GOOD_POSITION) return null;

    if (drop && !M_droptofloor_generic(spawnpoint, mins, maxs, false, null, MASK_MONSTERSOLID, false)) return null;
  }

  return spawnpoint;
}

/** rogue/g_rogue_spawn.cpp:29-46 (`CreateMonster`) + 60-73
 *  (`CreateGroundMonster`), collapsed into one function since
 *  `CreateMonster` has no other caller in this file's dependency closure
 *  (`CreateFlyMonster`, `CreateMonster`'s only other C++ caller, belongs to
 *  the carrier/widow files, out of scope here). */
function CreateGroundMonster(origin: Vec3, angles: Vec3, entMins: Vec3, entMaxs: Vec3, classname: string, height: number): EdictT | null {
  if (!CheckGroundSpawnPoint(origin, entMins, entMaxs, height, -1)) return null;

  const newEnt = G_Spawn();
  newEnt.s.origin = vec3(origin[0], origin[1], origin[2]);
  newEnt.s.angles = vec3(angles[0], angles[1], angles[2]);
  newEnt.classname = classname;
  newEnt.monsterinfo.aiflags |= MonsterAiFlagsT.AI_DO_NOT_COUNT;
  newEnt.gravityVector = vec3(0, 0, -1);
  ED_CallSpawn(newEnt);
  newEnt.s.renderfx |= RenderfxT.RF_IR_VISIBLE;

  return newEnt;
}

// ---------------------------------------------------------------------------
// SpawnGrow_Spawn -- ported for real, locally (rogue/g_rogue_spawn.cpp:
// 152-251). See file header's "THE REINFORCEMENTS FINDING" section.
// ---------------------------------------------------------------------------

const SPAWNGROW_LIFESPAN: GTime = Gtime_from_ms(1000);

const spawngrow_think: ThinkFn = (self: EdictT): void => {
  if (level.time >= self.timestamp) {
    G_FreeEdict(must(self.target_ent, "target_ent", self));
    G_FreeEdict(self);
    return;
  }

  self.s.angles = vec3(self.s.angles[0] + self.avelocity[0] * gi.frame_time_s, self.s.angles[1] + self.avelocity[1] * gi.frame_time_s, self.s.angles[2] + self.avelocity[2] * gi.frame_time_s);

  const t = 1.0 - Gtime_seconds(Gtime_subtract(level.time, self.teleport_time)) / self.wait;

  self.s.scale = clamp(lerp(self.decel, self.accel, t) / 16.0, 0.001, 16.0);
  self.s.alpha = t * t;

  self.nextthink = Gtime_add(self.nextthink, Gtime_from_ms(gi.frame_time_ms));
};

function SpawnGro_laser_pos(ent: EdictT): Vec3 {
  const theta = frandom(2 * Math.PI);
  const phi = Math.acos(frandom(-1, 1));

  const d = vec3(Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta), Math.cos(phi));

  const owner = must(ent.owner, "owner", ent);
  return vec3(ent.s.origin[0] + d[0] * owner.s.scale * 9.0, ent.s.origin[1] + d[1] * owner.s.scale * 9.0, ent.s.origin[2] + d[2] * owner.s.scale * 9.0);
}

const SpawnGro_laser_think: ThinkFn = (self: EdictT): void => {
  self.s.old_origin = SpawnGro_laser_pos(self);
  gi.linkentity(self);
  self.nextthink = Gtime_add(level.time, Gtime_from_ms(1));
};

function SpawnGrow_Spawn(startpos: Vec3, start_size: number, end_size: number): void {
  const ent = G_Spawn();
  ent.s.origin = vec3(startpos[0], startpos[1], startpos[2]);

  ent.s.angles = vec3(irandom(360), irandom(360), irandom(360));

  ent.avelocity = vec3(frandom(280.0, 360.0) * 2.0, frandom(280.0, 360.0) * 2.0, frandom(280.0, 360.0) * 2.0);

  ent.solid = 0; // SOLID_NOT
  ent.s.renderfx |= RenderfxT.RF_IR_VISIBLE;
  ent.movetype = 0; // MOVETYPE_NONE
  ent.classname = "spawngro";

  ent.s.modelindex = gi.modelindex("models/items/spawngro3/tris.md2");
  ent.s.skinnum = 1;

  ent.accel = start_size;
  ent.decel = end_size;
  ent.think = spawngrow_think;

  ent.s.scale = clamp(start_size / 16.0, 0.001, 8.0);

  ent.teleport_time = level.time;
  ent.wait = SPAWNGROW_LIFESPAN / 1000;
  ent.timestamp = Gtime_add(level.time, SPAWNGROW_LIFESPAN);

  ent.nextthink = Gtime_add(level.time, Gtime_from_ms(gi.frame_time_ms));

  gi.linkentity(ent);

  // [Paril-KEX]
  const beam = G_Spawn();
  ent.target_ent = beam;
  beam.s.modelindex = MODELINDEX_WORLD;
  beam.s.renderfx = RF_BEAM_LIGHTNING | RenderfxT.RF_NO_ORIGIN_LERP;
  beam.s.frame = 1;
  beam.s.skinnum = 0x30303030;
  beam.classname = "spawngro_beam";
  beam.angle = end_size;
  beam.owner = ent;
  beam.s.origin = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2]);
  beam.think = SpawnGro_laser_think;
  beam.nextthink = Gtime_add(level.time, Gtime_from_ms(1));
  beam.s.old_origin = SpawnGro_laser_pos(beam);
  gi.linkentity(beam);
}

// ---------------------------------------------------------------------------
// monster_fire_blaster2 / fire_blaster2 -- genuinely out-of-scope (a full
// second projectile weapon, not plumbing). See file header.
// ---------------------------------------------------------------------------

function monster_fire_blaster2(self: EdictT, _start: Vec3, _dir: Vec3, _damage: number, _speed: number, _flashtype: MonsterMuzzleflashIdT, _effect: EffectsT): void {
  throw new Error(`monster_fire_blaster2: not yet ported (rogue mission pack, see rogue/g_rogue_monster.cpp:7 + rogue/g_rogue_newweap.cpp:1374) -- called against ${self.classname ?? "?"}`);
}

// ---------------------------------------------------------------------------
// M_PickReinforcements / M_SetupReinforcements (m_medic.cpp:69-167).
// Non-static in the C++ (g_local.h-declared, shared with carrier/widow) --
// exported for reuse by future units, matching original linkage.
// ---------------------------------------------------------------------------

/** m_medic.cpp:70-77 (`static void M_PickValidReinforcements`). Kept local
 *  and unexported (matches the C++ `static`). See file header's note on the
 *  dropped `static std::vector` reuse optimization. */
function M_PickValidReinforcements(self: EdictT, space: number): number[] {
  const output: number[] = [];
  const list = self.monsterinfo.reinforcements.reinforcements;
  for (let i = 0; i < list.length; i++) {
    if (list[i].strength <= space) output.push(i);
  }
  return output;
}

/** m_medic.cpp:80-114. */
export function M_PickReinforcements(self: EdictT, maxSlots = 0): { chosen: Uint8Array; numChosen: number } {
  const chosen = new Uint8Array(MAX_REINFORCEMENTS).fill(255);

  const numSlots = Math.max(1, Math.trunc(Math.log2(frandom(inverse_log_slots))));

  let remaining = self.monsterinfo.monster_slots - self.monsterinfo.monster_used;

  let numChosen = 0;
  for (; numChosen < numSlots; numChosen++) {
    if ((maxSlots !== 0 && numChosen === maxSlots) || remaining === 0) break;

    const available = M_PickValidReinforcements(self, remaining);
    if (available.length === 0) break;

    const pick = random_element(available);
    chosen[numChosen] = pick;

    remaining -= self.monsterinfo.reinforcements.reinforcements[pick].strength;
  }

  return { chosen, numChosen };
}

/** m_medic.cpp:116-167. `COM_ParseEx(&p, "; ")` tokenizing ported as a plain
 *  split -- see file header. The C++'s spawn/free round-trip (spawning a
 *  throwaway edict of each reinforcement classname purely to read its
 *  ED_CallSpawn-assigned mins/maxs) is kept verbatim. */
export function M_SetupReinforcements(reinforcements: string, list: ReinforcementListT): void {
  list.reinforcements = [];

  if (!reinforcements) return;

  const entries = reinforcements
    .split(";")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);

  for (const entry of entries) {
    const parts = entry.split(/\s+/).filter((p) => p.length > 0);
    if (parts.length < 2) continue;

    const classname = parts[0];
    const strength = Number.parseInt(parts[1], 10);

    ClearSpawnTemp();

    const newEnt = G_Spawn();
    newEnt.classname = classname;
    newEnt.monsterinfo.aiflags |= MonsterAiFlagsT.AI_DO_NOT_COUNT;
    ED_CallSpawn(newEnt);

    const r: ReinforcementT = {
      classname: G_CopyString(classname),
      strength,
      mins: vec3(newEnt.mins[0], newEnt.mins[1], newEnt.mins[2]),
      maxs: vec3(newEnt.maxs[0], newEnt.maxs[1], newEnt.maxs[2]),
    };
    list.reinforcements.push(r);

    G_FreeEdict(newEnt);
  }
}

// ---------------------------------------------------------------------------
// cleanupHealTarget -- REAL. See file header.
// ---------------------------------------------------------------------------

/** rogue/g_rogue_combat.cpp:13-18. */
export function cleanupHealTarget(ent: EdictT): void {
  ent.monsterinfo.healer = null;
  ent.takedamage = true;
  ent.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_RESURRECTING;
  M_SetEffects(ent);
}

// ---------------------------------------------------------------------------
// cleanupHeal / abortHeal / canReach / medic_FindDeadMonster
// (m_medic.cpp:169-312). Non-static in the C++ -- exported for reuse.
// ---------------------------------------------------------------------------

export function cleanupHeal(self: EdictT, changeFrame: boolean): void {
  if (self.enemy !== null && self.enemy.inuse) cleanupHealTarget(self.enemy);

  if (self.oldenemy !== null && self.oldenemy.inuse && self.oldenemy.health > 0) {
    self.enemy = self.oldenemy;
    HuntTarget(self, false);
  } else {
    self.enemy = null;
    self.goalentity = null;
    self.oldenemy = null;
    if (!FindTarget(self)) {
      self.monsterinfo.pausetime = HOLD_FOREVER;
      must(self.monsterinfo.stand, "monsterinfo.stand", self)(self);
      return;
    }
  }

  if (changeFrame) self.monsterinfo.nextframe = FRAME_attack52;
}

export function abortHeal(self: EdictT, changeFrame: boolean, gib: boolean, mark: boolean): void {
  const pain_normal: Vec3 = vec3(0, 0, 1);

  if (self.enemy !== null && self.enemy.inuse) {
    cleanupHealTarget(self.enemy);

    if (mark) {
      const bm1 = self.enemy.monsterinfo.badMedic1;
      if (bm1 !== null && bm1.inuse && (bm1.classname ?? "").startsWith("monster_medic")) {
        self.enemy.monsterinfo.badMedic2 = self;
      } else {
        self.enemy.monsterinfo.badMedic1 = self;
      }
    }

    if (gib) {
      const hurt = self.enemy.gib_health !== 0 ? -self.enemy.gib_health : 500;
      T_Damage(self.enemy, self, self, vec3(0, 0, 0), self.enemy.s.origin, pain_normal, hurt, 0, 0, MOD_UNKNOWN);
    }
  }

  cleanupHeal(self, changeFrame);

  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MEDIC;
  self.monsterinfo.medicTries = 0;
}

/** m_medic.cpp:240-252. Not called anywhere else in this file (dead code in
 *  this TU, per the source's own comment history) -- ported verbatim and
 *  kept unexported since nothing in this file's own dependency closure
 *  calls it; a future carrier/widow port may. */
function canReach(self: EdictT, other: EdictT): boolean {
  const spot1 = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2] + self.viewheight);
  const spot2 = vec3(other.s.origin[0], other.s.origin[1], other.s.origin[2] + other.viewheight);
  const trace = gi.trace(spot1, null, null, spot2, self, MASK_PROJECTILE | MASK_WATER);
  return trace.fraction === 1.0 || trace.ent === other;
}

export function medic_FindDeadMonster(self: EdictT): EdictT | null {
  let best: EdictT | null = null;

  if (self.monsterinfo.react_to_damage_time > level.time) return null;

  const radius = (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n ? MEDIC_MAX_HEAL_DISTANCE : 1024;

  let ent: EdictT | null = null;
  while ((ent = findradius(ent, self.s.origin, radius)) !== null) {
    if (ent === self) continue;
    if ((ent.svflags & SvflagsT.SVF_MONSTER) === 0) continue;
    if ((ent.monsterinfo.aiflags & MonsterAiFlagsT.AI_GOOD_GUY) !== 0n) continue;
    if (ent.monsterinfo.badMedic1 === self || ent.monsterinfo.badMedic2 === self) continue;
    if (ent.monsterinfo.healer !== null) {
      const healer = ent.monsterinfo.healer;
      if (healer.inuse && healer.health > 0 && (healer.svflags & SvflagsT.SVF_MONSTER) !== 0 && (healer.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC) !== 0n) continue;
    }
    if (ent.health > 0) continue;
    if (Gtime_nonzero(ent.nextthink) && ent.think !== monster_dead_think) continue;
    if (!visible(self, ent)) continue;
    if ((ent.classname ?? "").startsWith("player")) continue;
    if (realrange(self, ent) <= MEDIC_MIN_DISTANCE) continue;
    if (best === null) {
      best = ent;
      continue;
    }
    if (ent.max_health <= best.max_health) continue;
    best = ent;
  }

  if (best !== null) self.timestamp = Gtime_add(level.time, MEDIC_TRY_TIME);

  return best;
}

// ---------------------------------------------------------------------------
// IDLE / SEARCH / SIGHT (m_medic.cpp:314-369)
// ---------------------------------------------------------------------------

function medic_findAndAcquire(self: EdictT): void {
  if (self.oldenemy === null) {
    const ent = medic_FindDeadMonster(self);
    if (ent !== null) {
      self.oldenemy = self.enemy;
      self.enemy = ent;
      ent.monsterinfo.healer = self;
      self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_MEDIC;
      FoundTarget(self);
    }
  }
}

export const medic_idle: MonsterinfoIdleFn = RegisterMonsterinfoIdle("medic_idle", (self: EdictT): void => {
  if (self.mass === 400) gi.sound(self, SoundchanT.CHAN_VOICE, sound_idle1.index, 1, ATTN_IDLE, 0);
  else gi.sound(self, SoundchanT.CHAN_VOICE, commander_sound_idle1.index, 1, ATTN_IDLE, 0);

  medic_findAndAcquire(self);
});

export const medic_search: MonsterinfoSearchFn = RegisterMonsterinfoSearch("medic_search", (self: EdictT): void => {
  if (self.mass === 400) gi.sound(self, SoundchanT.CHAN_VOICE, sound_search.index, 1, ATTN_IDLE, 0);
  else gi.sound(self, SoundchanT.CHAN_VOICE, commander_sound_search.index, 1, ATTN_IDLE, 0);

  medic_findAndAcquire(self);
});

export const medic_sight = RegisterMonsterinfoSight("medic_sight", (self: EdictT, _other: EdictT): void => {
  if (self.mass === 400) gi.sound(self, SoundchanT.CHAN_VOICE, sound_sight.index, 1, ATTN_NORM, 0);
  else gi.sound(self, SoundchanT.CHAN_VOICE, commander_sound_sight.index, 1, ATTN_NORM, 0);
});

// ---------------------------------------------------------------------------
// STAND (m_medic.cpp:371-468)
// ---------------------------------------------------------------------------

const medic_frames_stand: MframeT[] = [mkframe(ai_stand, 0, medic_idle), ...Array.from({ length: 89 }, () => mkframe(ai_stand))];
export const medic_move_stand = RegisterMmove("medic_move_stand", mkMove(FRAME_wait1, FRAME_wait90, medic_frames_stand, null));

export const medic_stand = RegisterMonsterinfoStand("medic_stand", (self: EdictT): void => {
  M_SetAnimation(self, medic_move_stand, true);
});

// ---------------------------------------------------------------------------
// WALK (m_medic.cpp:470-489)
// ---------------------------------------------------------------------------

const medic_frames_walk: MframeT[] = [
  mkframe(ai_walk, 6.2),
  mkframe(ai_walk, 18.1, monster_footstep),
  mkframe(ai_walk, 1),
  mkframe(ai_walk, 9),
  mkframe(ai_walk, 10),
  mkframe(ai_walk, 9),
  mkframe(ai_walk, 11),
  mkframe(ai_walk, 11.6, monster_footstep),
  mkframe(ai_walk, 2),
  mkframe(ai_walk, 9.9),
  mkframe(ai_walk, 14),
  mkframe(ai_walk, 9.3),
];
export const medic_move_walk = RegisterMmove("medic_move_walk", mkMove(FRAME_walk1, FRAME_walk12, medic_frames_walk, null));

export const medic_walk = RegisterMonsterinfoWalk("medic_walk", (self: EdictT): void => {
  M_SetAnimation(self, medic_move_walk, true);
});

// ---------------------------------------------------------------------------
// RUN (m_medic.cpp:491-525)
// ---------------------------------------------------------------------------

const medic_frames_run: MframeT[] = [mkframe(ai_run, 18), mkframe(ai_run, 22.5, monster_footstep), mkframe(ai_run, 25.4, monster_done_dodge), mkframe(ai_run, 23.4, monster_footstep), mkframe(ai_run, 24), mkframe(ai_run, 35.6)];
export const medic_move_run = RegisterMmove("medic_move_run", mkMove(FRAME_run1, FRAME_run6, medic_frames_run, null));

export const medic_run = RegisterMonsterinfoRun("medic_run", (self: EdictT): void => {
  monster_done_dodge(self);

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC) === 0n) {
    const ent = medic_FindDeadMonster(self);
    if (ent !== null) {
      self.oldenemy = self.enemy;
      self.enemy = ent;
      ent.monsterinfo.healer = self;
      self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_MEDIC;
      FoundTarget(self);
      return;
    }
  }

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) M_SetAnimation(self, medic_move_stand, true);
  else M_SetAnimation(self, medic_move_run, true);
});

// ---------------------------------------------------------------------------
// PAIN (m_medic.cpp:527-607)
// ---------------------------------------------------------------------------

const medic_frames_pain1: MframeT[] = [mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move)];
export const medic_move_pain1 = RegisterMmove("medic_move_pain1", mkMove(FRAME_paina2, FRAME_paina6, medic_frames_pain1, medic_run));

const medic_frames_pain2: MframeT[] = [
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0, monster_footstep),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0, monster_footstep),
];
export const medic_move_pain2 = RegisterMmove("medic_move_pain2", mkMove(FRAME_painb2, FRAME_painb13, medic_frames_pain2, medic_run));

export const medic_pain: PainFn = RegisterPain("medic_pain", (self: EdictT, _other: EdictT, _kick: number, damage: number, mod: ModT): void => {
  monster_done_dodge(self);

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));

  const r = frandom();

  if (self.mass > 400) {
    if (damage < 35) {
      gi.sound(self, SoundchanT.CHAN_VOICE, commander_sound_pain1.index, 1, ATTN_NORM, 0);

      if (mod.id !== ModIdT.MOD_CHAINFIST) return;
    }

    gi.sound(self, SoundchanT.CHAN_VOICE, commander_sound_pain2.index, 1, ATTN_NORM, 0);
  } else if (r < 0.5) gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain1.index, 1, ATTN_NORM, 0);
  else gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain2.index, 1, ATTN_NORM, 0);

  if (!M_ShouldReactToPain(self, mod)) return;

  if (mod.id !== ModIdT.MOD_CHAINFIST && (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC) !== 0n) return;

  if (self.mass > 400) {
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MANUAL_STEERING;
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_HOLD_FRAME;

    if (r < Math.min(damage * 0.005, 0.5)) M_SetAnimation(self, medic_move_pain2, true);
    else M_SetAnimation(self, medic_move_pain1, true);
  } else if (r < 0.5) M_SetAnimation(self, medic_move_pain1, true);
  else M_SetAnimation(self, medic_move_pain2, true);

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_DUCKED) !== 0n) monster_duck_up(self);

  abortHeal(self, false, false, false);
});

// ---------------------------------------------------------------------------
// SETSKIN (m_medic.cpp:609-615)
// ---------------------------------------------------------------------------

export const medic_setskin = RegisterMonsterinfoSetskin("medic_setskin", (self: EdictT): void => {
  if (self.health < self.max_health / 2) self.s.skinnum |= 1;
  else self.s.skinnum &= ~1;
});

// ---------------------------------------------------------------------------
// medic_fire_blaster (m_medic.cpp:617-660)
// ---------------------------------------------------------------------------

function medic_fire_blaster(self: EdictT): void {
  if (self.enemy === null || !self.enemy.inuse) return;

  let effect: EffectsT;
  let damage = 2;
  let mz: MonsterMuzzleflashIdT;

  if (self.s.frame === FRAME_attack9 || self.s.frame === FRAME_attack12) {
    effect = EffectsT.EF_BLASTER;
    damage = 6;
    mz = self.mass > 400 ? MonsterMuzzleflashIdT.MZ2_MEDIC_BLASTER_2 : MonsterMuzzleflashIdT.MZ2_MEDIC_BLASTER_1;
  } else {
    effect = self.s.frame % 4 ? EffectsT.EF_NONE : EffectsT.EF_HYPERBLASTER;
    mz = (self.mass > 400 ? MonsterMuzzleflashIdT.MZ2_MEDIC_HYPERBLASTER2_1 : MonsterMuzzleflashIdT.MZ2_MEDIC_HYPERBLASTER1_1) + (self.s.frame - FRAME_attack19);
  }

  const forward = vec3(0, 0, 0);
  const right = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, right, null);
  const offset = monsterFlashOffsetFor(mz);
  const start = M_ProjectFlashSource(self, offset, forward, right);

  const end = vec3(self.enemy.s.origin[0], self.enemy.s.origin[1], self.enemy.s.origin[2] + self.enemy.viewheight);
  const dirRaw = vec3_sub(end, start);
  const len = vec3_length(dirRaw);
  const dir = len > 0 ? vec3(dirRaw[0] / len, dirRaw[1] / len, dirRaw[2] / len) : vec3(1, 0, 0);

  if (self.enemy.classname === "tesla_mine") damage = 3;

  if (self.mass > 400) monster_fire_blaster2(self, start, dir, damage, 1000, mz, effect);
  else monster_fire_blaster(self, start, dir, damage, 1000, mz, effect);
}

/** m_flash.ts's `monsterFlashOffset` is a getter (see m_soldier.ts's own
 *  usage: `monsterFlashOffset()[flash_index]`) -- wrapped here purely to
 *  keep `medic_fire_blaster`'s body reading close to the C++'s
 *  `monster_flash_offset[mz]` array-index form. */
function monsterFlashOffsetFor(mz: MonsterMuzzleflashIdT): Vec3 {
  return monsterFlashOffsetTable()[mz];
}

// ---------------------------------------------------------------------------
// medic_dead / medic_shrink / DEATH (m_medic.cpp:662-749)
// ---------------------------------------------------------------------------

function medic_dead(self: EdictT): void {
  self.mins = vec3(-16, -16, -24);
  self.maxs = vec3(16, 16, -8);
  monster_dead(self);
}

function medic_shrink(self: EdictT): void {
  self.maxs = vec3(self.maxs[0], self.maxs[1], -2);
  self.svflags |= SvflagsT.SVF_DEADMONSTER;
  gi.linkentity(self);
}

const medic_frames_death: MframeT[] = [
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, -18, monster_footstep),
  mkframe(ai_move, -10, medic_shrink),
  mkframe(ai_move, -6),
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
  mkframe(ai_move, 0, monster_footstep),
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
];
export const medic_move_death = RegisterMmove("medic_move_death", mkMove(FRAME_death2, FRAME_death30, medic_frames_death, medic_dead));

export const medic_die: DieFn = RegisterDie("medic_die", (self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3, mod: ModT): void => {
  if (M_CheckGib(self, mod)) {
    gi.sound(self, SoundchanT.CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);

    self.s.skinnum = Math.trunc(self.s.skinnum / 2);

    ThrowGibs(self, damage, [
      { count: 2, gibname: "models/objects/gibs/bone/tris.md2" },
      { gibname: "models/objects/gibs/sm_meat/tris.md2" },
      { gibname: "models/objects/gibs/sm_metal/tris.md2", type: GibTypeT.GIB_METALLIC },
      { gibname: "models/monsters/medic/gibs/chest.md2", type: GibTypeT.GIB_SKINNED },
      { count: 2, gibname: "models/monsters/medic/gibs/leg.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
      { gibname: "models/monsters/medic/gibs/hook.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
      { gibname: "models/monsters/medic/gibs/gun.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
      { gibname: "models/monsters/medic/gibs/head.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_HEAD },
    ]);

    self.deadflag = true;
    return;
  }

  if (self.deadflag) return;

  if (self.mass === 400) gi.sound(self, SoundchanT.CHAN_VOICE, sound_die.index, 1, ATTN_NORM, 0);
  else gi.sound(self, SoundchanT.CHAN_VOICE, commander_sound_die.index, 1, ATTN_NORM, 0);

  self.deadflag = true;
  self.takedamage = true;

  M_SetAnimation(self, medic_move_death, true);
});

// ---------------------------------------------------------------------------
// DUCK frames (m_medic.cpp:751-766) -- registered further down, after
// MONSTERINFO_DUCK is defined, matching the C++'s own ordering note ("PMM --
// moved dodge code to after attack code so I can reference attack frames").
// ---------------------------------------------------------------------------

const medic_frames_duck: MframeT[] = [
  mkframe(ai_move, -1),
  mkframe(ai_move, -1, monster_duck_down),
  mkframe(ai_move, -1, monster_duck_hold),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1), // PMM - duck up used to be here
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1, monster_duck_up),
];
export const medic_move_duck = RegisterMmove("medic_move_duck", mkMove(FRAME_duck2, FRAME_duck14, medic_frames_duck, medic_run));

// ---------------------------------------------------------------------------
// attackHyperBlaster (m_medic.cpp:770-825)
// ---------------------------------------------------------------------------

const medic_frames_attackHyperBlaster: MframeT[] = [
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge),
  mkframe(ai_charge),
  // [Paril-KEX] end on 36 as intended
  mkframe(ai_charge, 2.0), // 33
  mkframe(ai_charge, 3.0, monster_footstep),
];
export const medic_move_attackHyperBlaster = RegisterMmove("medic_move_attackHyperBlaster", mkMove(FRAME_attack15, FRAME_attack34, medic_frames_attackHyperBlaster, medic_run));

function medic_quick_attack(self: EdictT): void {
  if (frandom() < 0.5) {
    M_SetAnimation(self, medic_move_attackHyperBlaster, false);
    self.monsterinfo.nextframe = FRAME_attack16;
  }
}

export function medic_continue(self: EdictT): void {
  if (self.enemy !== null && visible(self, self.enemy)) {
    if (frandom() <= 0.95) M_SetAnimation(self, medic_move_attackHyperBlaster, false);
  }
}

// ---------------------------------------------------------------------------
// attackBlaster (m_medic.cpp:811-825)
// ---------------------------------------------------------------------------

const medic_frames_attackBlaster: MframeT[] = [
  mkframe(ai_charge, 5),
  mkframe(ai_charge, 3),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 0, medic_quick_attack),
  mkframe(ai_charge, 0, monster_footstep),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, medic_fire_blaster),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, medic_continue),
];
export const medic_move_attackBlaster = RegisterMmove("medic_move_attackBlaster", mkMove(FRAME_attack3, FRAME_attack14, medic_frames_attackBlaster, medic_run));

// ---------------------------------------------------------------------------
// medic_hook_launch / medic_cable_attack / medic_hook_retract
// (m_medic.cpp:827-1103)
// ---------------------------------------------------------------------------

export function medic_hook_launch(self: EdictT): void {
  if (self.mass === 400) gi.sound(self, SoundchanT.CHAN_WEAPON, sound_hook_launch.index, 1, ATTN_NORM, 0);
  else gi.sound(self, SoundchanT.CHAN_WEAPON, commander_sound_hook_launch.index, 1, ATTN_NORM, 0);
}

export function medic_cable_attack(self: EdictT): void {
  if (self.enemy === null || !self.enemy.inuse || (self.enemy.s.effects & EffectsT.EF_GIB) !== 0n) {
    abortHeal(self, false, false, false);
    return;
  }

  if (self.enemy.client !== null) return;

  if (self.enemy.health > 0) {
    abortHeal(self, false, false, false);
    return;
  }

  const f = vec3(0, 0, 0);
  const r = vec3(0, 0, 0);
  AngleVectors(self.s.angles, f, r, null);
  const offset = medic_cable_offsets[self.s.frame - FRAME_attack42];
  let start = M_ProjectFlashSource(self, offset, f, r);

  const dir = vec3_sub(start, self.enemy.s.origin);
  const distance = vec3_length(dir);
  if (distance < MEDIC_MIN_DISTANCE) {
    abortHeal(self, true, true, false);
    return;
  }

  const tr = gi.trace(start, null, null, self.enemy.s.origin, self, MASK_SOLID);
  if (tr.fraction !== 1.0 && tr.ent !== self.enemy) {
    if (tr.ent === g_edicts[0]) {
      if (self.monsterinfo.medicTries > 1) {
        abortHeal(self, true, false, true);
        return;
      }
      self.monsterinfo.medicTries++;
      cleanupHeal(self, true);
      return;
    }
    abortHeal(self, true, false, false);
    return;
  }

  if (self.s.frame === FRAME_attack43) {
    if (self.mass === 400) gi.sound(self.enemy, SoundchanT.CHAN_AUTO, sound_hook_hit.index, 1, ATTN_NORM, 0);
    else gi.sound(self.enemy, SoundchanT.CHAN_AUTO, commander_sound_hook_hit.index, 1, ATTN_NORM, 0);

    self.enemy.monsterinfo.aiflags |= MonsterAiFlagsT.AI_RESURRECTING;
    self.enemy.takedamage = false;
    M_SetEffects(self.enemy);
  } else if (self.s.frame === FRAME_attack50) {
    const enemy = self.enemy;
    enemy.spawnflags = SPAWNFLAGS_NONE;
    enemy.monsterinfo.aiflags &= MonsterAiFlagsT.AI_STINKY | AI_SPAWNED_MASK;
    enemy.target = null;
    enemy.targetname = null;
    enemy.combattarget = null;
    enemy.deathtarget = null;
    enemy.healthtarget = null;
    enemy.itemtarget = null;
    enemy.monsterinfo.healer = self;

    const maxs = vec3(enemy.maxs[0], enemy.maxs[1], enemy.maxs[2] + 48);

    const stuckTrace = gi.trace(enemy.s.origin, enemy.mins, maxs, enemy.s.origin, enemy, MASK_MONSTERSOLID);

    if (stuckTrace.startsolid || stuckTrace.allsolid) {
      abortHeal(self, true, true, false);
      return;
    } else if (stuckTrace.ent !== g_edicts[0]) {
      abortHeal(self, true, true, false);
      return;
    } else {
      enemy.monsterinfo.aiflags |= MonsterAiFlagsT.AI_DO_NOT_COUNT;

      const old_max_health = enemy.max_health;
      const old_power_armor_type = enemy.monsterinfo.initial_power_armor_type;
      const old_power_armor_power = enemy.monsterinfo.max_power_armor_power;
      const old_base_health = enemy.monsterinfo.base_health;
      const old_health_scaling = enemy.monsterinfo.health_scaling;
      const reinforcements = enemy.monsterinfo.reinforcements;
      const monster_slots = enemy.monsterinfo.monster_slots;
      const monster_used = enemy.monsterinfo.monster_used;
      const old_gib_health = enemy.gib_health;

      ClearSpawnTemp();
      st.keys_specified.add("reinforcements");
      st.reinforcements = "";

      ED_CallSpawn(enemy);

      enemy.monsterinfo.reinforcements = reinforcements;
      enemy.monsterinfo.monster_slots = monster_slots;
      enemy.monsterinfo.monster_used = monster_used;

      enemy.gib_health = Math.trunc(old_gib_health / 2);
      enemy.health = enemy.max_health = old_max_health;
      enemy.monsterinfo.power_armor_power = enemy.monsterinfo.max_power_armor_power = old_power_armor_power;
      enemy.monsterinfo.power_armor_type = enemy.monsterinfo.initial_power_armor_type = old_power_armor_type;
      enemy.monsterinfo.base_health = old_base_health;
      enemy.monsterinfo.health_scaling = old_health_scaling;

      if (enemy.monsterinfo.setskin !== null) enemy.monsterinfo.setskin(enemy);

      if (enemy.think !== null) {
        enemy.nextthink = level.time;
        enemy.think(enemy);
      }
      enemy.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_RESURRECTING;
      enemy.monsterinfo.aiflags |= MonsterAiFlagsT.AI_IGNORE_SHOTS | MonsterAiFlagsT.AI_DO_NOT_COUNT;
      enemy.s.effects &= ~EffectsT.EF_FLIES;
      enemy.monsterinfo.healer = null;

      if (self.oldenemy !== null && self.oldenemy.inuse && self.oldenemy.health > 0) {
        enemy.enemy = self.oldenemy;
        FoundTarget(enemy);
      } else {
        enemy.enemy = null;
        if (!FindTarget(enemy)) {
          enemy.monsterinfo.pausetime = HOLD_FOREVER;
          must(enemy.monsterinfo.stand, "monsterinfo.stand", enemy)(enemy);
        }
        self.enemy = null;
        self.oldenemy = null;
        if (!FindTarget(self)) {
          self.monsterinfo.pausetime = HOLD_FOREVER;
          must(self.monsterinfo.stand, "monsterinfo.stand", self)(self);
          return;
        }
      }

      cleanupHeal(self, false);
      return;
    }
  } else {
    if (self.s.frame === FRAME_attack44) {
      if (self.mass === 400) gi.sound(self, SoundchanT.CHAN_WEAPON, sound_hook_heal.index, 1, ATTN_NORM, 0);
      else gi.sound(self, SoundchanT.CHAN_WEAPON, commander_sound_hook_heal.index, 1, ATTN_NORM, 0);
    }
  }

  start = vec3(start[0] + f[0] * 8, start[1] + f[1] * 8, start[2] + f[2] * 8);

  const end = vec3(self.enemy.s.origin[0], self.enemy.s.origin[1], (self.enemy.absmin[2] + self.enemy.absmax[2]) / 2);

  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_MEDIC_CABLE_ATTACK);
  gi.WriteEntity(self as unknown as KexEdictT);
  gi.WritePosition(start);
  gi.WritePosition(end);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PVS, false);
}

export function medic_hook_retract(self: EdictT): void {
  if (self.mass === 400) gi.sound(self, SoundchanT.CHAN_WEAPON, sound_hook_retract.index, 1, ATTN_NORM, 0);
  else gi.sound(self, SoundchanT.CHAN_WEAPON, sound_hook_retract.index, 1, ATTN_NORM, 0);

  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MEDIC;

  if (self.oldenemy !== null && self.oldenemy.inuse && self.oldenemy.health > 0) {
    self.enemy = self.oldenemy;
    HuntTarget(self, false);
  } else {
    self.enemy = null;
    self.goalentity = null;
    self.oldenemy = null;
    if (!FindTarget(self)) {
      self.monsterinfo.pausetime = HOLD_FOREVER;
      must(self.monsterinfo.stand, "monsterinfo.stand", self)(self);
      return;
    }
  }
}

const medic_frames_attackCable: MframeT[] = [
  // ROGUE - negated 36-40 so he scoots back from his target a little
  // ROGUE - switched 33-36 to ai_charge
  // ROGUE - changed frame 52 to 60 to compensate for changes in 36-40
  // [Paril-KEX] started on 36 as they intended
  mkframe(ai_charge, -4.7), // 37
  mkframe(ai_charge, -5.0),
  mkframe(ai_charge, -6.0),
  mkframe(ai_charge, -4.0), // 40
  mkframe(ai_charge, 0, monster_footstep),
  mkframe(ai_move, 0, medic_hook_launch), // 42
  mkframe(ai_move, 0, medic_cable_attack), // 43
  mkframe(ai_move, 0, medic_cable_attack),
  mkframe(ai_move, 0, medic_cable_attack),
  mkframe(ai_move, 0, medic_cable_attack),
  mkframe(ai_move, 0, medic_cable_attack),
  mkframe(ai_move, 0, medic_cable_attack),
  mkframe(ai_move, 0, medic_cable_attack),
  mkframe(ai_move, 0, medic_cable_attack),
  mkframe(ai_move, 0, medic_cable_attack), // 51
  mkframe(ai_move, 0, medic_hook_retract), // 52
  mkframe(ai_move, -1.5),
  mkframe(ai_move, -1.2, monster_footstep),
  mkframe(ai_move, -3.0),
];
export const medic_move_attackCable = RegisterMmove("medic_move_attackCable", mkMove(FRAME_attack37, FRAME_attack55, medic_frames_attackCable, medic_run));

// ---------------------------------------------------------------------------
// medic_start_spawn / medic_determine_spawn / medic_spawngrows /
// medic_finish_spawn / callReinforcements (m_medic.cpp:1105-1389)
// ---------------------------------------------------------------------------

export function medic_start_spawn(self: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_WEAPON, commander_sound_spawn.index, 1, ATTN_NORM, 0);
  self.monsterinfo.nextframe = FRAME_attack48;
}

export function medic_determine_spawn(self: EdictT): void {
  const f = vec3(0, 0, 0);
  const r = vec3(0, 0, 0);
  AngleVectors(self.s.angles, f, r, null);

  const { chosen, numChosen } = M_PickReinforcements(self);
  self.monsterinfo.chosen_reinforcements = chosen;

  let numSuccess = 0;

  for (let count = 0; count < numChosen; count++) {
    let offset = reinforcement_position[count];
    if (self.s.scale) offset = vec3(offset[0] * self.s.scale, offset[1] * self.s.scale, offset[2] * self.s.scale);

    let startpoint = M_ProjectFlashSource(self, offset, f, r);
    startpoint = vec3(startpoint[0], startpoint[1], startpoint[2] + 10 * (self.s.scale ? self.s.scale : 1.0));

    const reinforcement = self.monsterinfo.reinforcements.reinforcements[self.monsterinfo.chosen_reinforcements[count]];

    const spawnpoint = FindSpawnPoint(startpoint, reinforcement.mins, reinforcement.maxs, 32);
    if (spawnpoint !== null && CheckGroundSpawnPoint(spawnpoint, reinforcement.mins, reinforcement.maxs, 256, -1)) {
      numSuccess++;
      break;
    }
  }

  if (numSuccess === 0) {
    for (let count = 0; count < numChosen; count++) {
      let offset = reinforcement_position[count];
      if (self.s.scale) offset = vec3(offset[0] * self.s.scale, offset[1] * self.s.scale, offset[2] * self.s.scale);

      offset = vec3(offset[0] * -1.0, offset[1] * -1.0, offset[2]);
      let startpoint = M_ProjectFlashSource(self, offset, f, r);
      startpoint = vec3(startpoint[0], startpoint[1], startpoint[2] + 10);

      const reinforcement = self.monsterinfo.reinforcements.reinforcements[self.monsterinfo.chosen_reinforcements[count]];

      const spawnpoint = FindSpawnPoint(startpoint, reinforcement.mins, reinforcement.maxs, 32);
      if (spawnpoint !== null && CheckGroundSpawnPoint(spawnpoint, reinforcement.mins, reinforcement.maxs, 256, -1)) {
        numSuccess++;
        break;
      }
    }

    if (numSuccess) {
      self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_MANUAL_STEERING;
      self.ideal_yaw = anglemod(self.s.angles[1]) + 180;
      if (self.ideal_yaw > 360.0) self.ideal_yaw -= 360.0;
    }
  }

  if (numSuccess === 0) self.monsterinfo.nextframe = FRAME_attack53;
}

export function medic_spawngrows(self: EdictT): void {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) !== 0n) {
    const current_yaw = anglemod(self.s.angles[1]);
    if (Math.abs(current_yaw - self.ideal_yaw) > 0.1) {
      self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_HOLD_FRAME;
      return;
    }

    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_HOLD_FRAME;
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MANUAL_STEERING;
  }

  const f = vec3(0, 0, 0);
  const r = vec3(0, 0, 0);
  AngleVectors(self.s.angles, f, r, null);

  let numSummoned = 0;
  for (let i = 0; i < MAX_REINFORCEMENTS; i++, numSummoned++) {
    if (self.monsterinfo.chosen_reinforcements[i] === 255) break;
  }

  let numSuccess = 0;

  for (let count = 0; count < numSummoned; count++) {
    const offset = reinforcement_position[count];
    let startpoint = M_ProjectFlashSource(self, offset, f, r);
    startpoint = vec3(startpoint[0], startpoint[1], startpoint[2] + 10 * (self.s.scale ? self.s.scale : 1.0));

    const reinforcement = self.monsterinfo.reinforcements.reinforcements[self.monsterinfo.chosen_reinforcements[count]];

    const spawnpoint = FindSpawnPoint(startpoint, reinforcement.mins, reinforcement.maxs, 32);
    if (spawnpoint !== null && CheckGroundSpawnPoint(spawnpoint, reinforcement.mins, reinforcement.maxs, 256, -1)) {
      numSuccess++;
      const diag = vec3_sub(reinforcement.maxs, reinforcement.mins);
      const radius = vec3_length(diag) * 0.5;
      SpawnGrow_Spawn(vec3(spawnpoint[0] + reinforcement.mins[0] + reinforcement.maxs[0], spawnpoint[1] + reinforcement.mins[1] + reinforcement.maxs[1], spawnpoint[2] + reinforcement.mins[2] + reinforcement.maxs[2]), radius, radius * 2.0);
    }
  }

  if (numSuccess === 0) self.monsterinfo.nextframe = FRAME_attack53;
}

export function medic_finish_spawn(self: EdictT): void {
  const f = vec3(0, 0, 0);
  const r = vec3(0, 0, 0);
  AngleVectors(self.s.angles, f, r, null);

  let numSummoned = 0;
  for (let i = 0; i < MAX_REINFORCEMENTS; i++, numSummoned++) {
    if (self.monsterinfo.chosen_reinforcements[i] === 255) break;
  }

  for (let count = 0; count < numSummoned; count++) {
    const reinforcement = self.monsterinfo.reinforcements.reinforcements[self.monsterinfo.chosen_reinforcements[count]];
    const offset = reinforcement_position[count];

    let startpoint = M_ProjectFlashSource(self, offset, f, r);
    startpoint = vec3(startpoint[0], startpoint[1], startpoint[2] + 10 * (self.s.scale ? self.s.scale : 1.0));

    let ent: EdictT | null = null;
    const spawnpoint = FindSpawnPoint(startpoint, reinforcement.mins, reinforcement.maxs, 32);
    if (spawnpoint !== null && CheckSpawnPoint(spawnpoint, reinforcement.mins, reinforcement.maxs)) {
      ent = CreateGroundMonster(spawnpoint, self.s.angles, reinforcement.mins, reinforcement.maxs, must(reinforcement.classname, "reinforcement.classname", self), 256);
    }

    if (ent === null) continue;

    if (ent.think !== null) {
      ent.nextthink = level.time;
      ent.think(ent);
    }

    ent.monsterinfo.aiflags |= MonsterAiFlagsT.AI_IGNORE_SHOTS | MonsterAiFlagsT.AI_DO_NOT_COUNT | MonsterAiFlagsT.AI_SPAWNED_MEDIC_C;
    ent.monsterinfo.commander = self;
    ent.monsterinfo.monster_slots = reinforcement.strength;
    self.monsterinfo.monster_used += reinforcement.strength;

    let designated_enemy = (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC) !== 0n ? self.oldenemy : self.enemy;

    if (coopEnabled()) {
      let coopTarget = PickCoopTarget(ent);
      if (coopTarget !== null) {
        if (coopTarget === self.enemy) {
          coopTarget = PickCoopTarget(ent);
          if (coopTarget === null) coopTarget = self.enemy;
        }
        designated_enemy = coopTarget;
      } else {
        designated_enemy = self.enemy;
      }
    }

    if (designated_enemy !== null && designated_enemy.inuse && designated_enemy.health > 0) {
      ent.enemy = designated_enemy;
      FoundTarget(ent);
    } else {
      ent.enemy = null;
      must(ent.monsterinfo.stand, "monsterinfo.stand", ent)(ent);
    }
  }
}

const medic_frames_callReinforcements: MframeT[] = [
  // ROGUE - 33-36 now ai_charge
  mkframe(ai_charge, 2), // 33
  mkframe(ai_charge, 3),
  mkframe(ai_charge, 5),
  mkframe(ai_charge, 4.4), // 36
  mkframe(ai_charge, 4.7),
  mkframe(ai_charge, 5),
  mkframe(ai_charge, 6),
  mkframe(ai_charge, 4), // 40
  mkframe(ai_charge, 0, monster_footstep),
  mkframe(ai_move, 0, medic_start_spawn), // 42
  mkframe(ai_move), // 43 -- 43 through 47 are skipped
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0, medic_determine_spawn), // 48
  mkframe(ai_charge, 0, medic_spawngrows), // 49
  mkframe(ai_move), // 50
  mkframe(ai_move), // 51
  mkframe(ai_move, -15, medic_finish_spawn), // 52
  mkframe(ai_move, -1.5),
  mkframe(ai_move, -1.2),
  mkframe(ai_move, -3, monster_footstep),
];
export const medic_move_callReinforcements = RegisterMmove("medic_move_callReinforcements", mkMove(FRAME_attack33, FRAME_attack55, medic_frames_callReinforcements, medic_run));

// ---------------------------------------------------------------------------
// ATTACK / CHECKATTACK (m_medic.cpp:1356-1447)
// ---------------------------------------------------------------------------

export const medic_attack = RegisterMonsterinfoAttack("medic_attack", (self: EdictT): void => {
  monster_done_dodge(self);

  const enemy = must(self.enemy, "enemy", self);
  const enemy_range = range_to(self, enemy);

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_BLOCKED) !== 0n) {
    M_SetAnimation(self, medic_move_callReinforcements, true);
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_BLOCKED;
  }

  const r = frandom();
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC) !== 0n) {
    if (self.mass > 400 && r > 0.8 && M_SlotsLeft(self) > 0) M_SetAnimation(self, medic_move_callReinforcements, true);
    else M_SetAnimation(self, medic_move_attackCable, true);
  } else {
    if (self.monsterinfo.attack_state === MonsterAttackStateT.AS_BLIND) {
      M_SetAnimation(self, medic_move_callReinforcements, true);
      return;
    }
    if (self.mass > 400 && r > 0.2 && enemy_range > RANGE_MELEE && M_SlotsLeft(self) > 0) M_SetAnimation(self, medic_move_callReinforcements, true);
    else M_SetAnimation(self, medic_move_attackBlaster, true);
  }
});

export const medic_checkattack = RegisterMonsterinfoCheckattack("medic_checkattack", (self: EdictT): boolean => {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC) !== 0n) {
    if (self.enemy === null || !self.enemy.inuse) {
      abortHeal(self, true, false, false);
      return false;
    }

    if (self.timestamp < level.time) {
      abortHeal(self, true, false, true);
      self.timestamp = Gtime_from_ms(0);
      return false;
    }

    if (realrange(self, self.enemy) < MEDIC_MAX_HEAL_DISTANCE + 10) {
      medic_attack(self);
      return true;
    } else {
      self.monsterinfo.attack_state = MonsterAttackStateT.AS_STRAIGHT;
      return false;
    }
  }

  const enemy = must(self.enemy, "enemy", self);

  if (enemy.client !== null && !visible(self, enemy) && M_SlotsLeft(self) > 0) {
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_BLIND;
    return true;
  }

  if (self.monsterinfo.monster_slots !== 0 && frandom() < 0.8 && M_SlotsLeft(self) > self.monsterinfo.monster_slots * 0.8 && realrange(self, enemy) > 150) {
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_BLOCKED;
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_MISSILE;
    return true;
  }

  // ROGUE
  // since his idle animation looks kinda bad in combat, always attack
  // when he's on a combat point
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) {
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_MISSILE;
    return true;
  }

  return M_CheckAttack(self);
});

function MedicCommanderCache(): void {
  gi.modelindex("models/items/spawngro3/tris.md2");
}

// ---------------------------------------------------------------------------
// DUCK / SIDESTEP / BLOCKED (m_medic.cpp:1454-1500)
// ---------------------------------------------------------------------------

export const medic_duck = RegisterMonsterinfoDuck("medic_duck", (self: EdictT, _eta: GTime): boolean => {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC) !== 0n) return false;

  if (self.monsterinfo.active_move === medic_move_attackHyperBlaster || self.monsterinfo.active_move === medic_move_attackCable || self.monsterinfo.active_move === medic_move_attackBlaster || self.monsterinfo.active_move === medic_move_callReinforcements) {
    must(self.monsterinfo.unduck, "monsterinfo.unduck", self)(self);
    return false;
  }

  M_SetAnimation(self, medic_move_duck, true);

  return true;
});

export const medic_sidestep = RegisterMonsterinfoSidestep("medic_sidestep", (self: EdictT): boolean => {
  if (self.monsterinfo.active_move === medic_move_attackHyperBlaster || self.monsterinfo.active_move === medic_move_attackCable || self.monsterinfo.active_move === medic_move_attackBlaster || self.monsterinfo.active_move === medic_move_callReinforcements) {
    return false;
  }

  if (self.monsterinfo.active_move !== medic_move_run) M_SetAnimation(self, medic_move_run, true);

  return true;
});

// PGM
export const medic_blocked = RegisterMonsterinfoBlocked("medic_blocked", (self: EdictT, dist: number): boolean => {
  if (blocked_checkplat(self, dist)) return true;

  return false;
});
// PGM

// ---------------------------------------------------------------------------
// SP_monster_medic (m_medic.cpp:1504-1627)
// ---------------------------------------------------------------------------

/*QUAKED monster_medic_commander (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
 */
/*QUAKED monster_medic (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
model="models/monsters/medic/tris.md2"
*/
export function SP_monster_medic(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  self.movetype = 3; // MOVETYPE_STEP
  self.solid = 2; // SOLID_BBOX
  self.s.modelindex = gi.modelindex("models/monsters/medic/tris.md2");

  gi.modelindex("models/monsters/medic/gibs/chest.md2");
  gi.modelindex("models/monsters/medic/gibs/gun.md2");
  gi.modelindex("models/monsters/medic/gibs/head.md2");
  gi.modelindex("models/monsters/medic/gibs/hook.md2");
  gi.modelindex("models/monsters/medic/gibs/leg.md2");

  self.mins = vec3(-24, -24, -24);
  self.maxs = vec3(24, 24, 32);

  if (self.classname === "monster_medic_commander") {
    self.health = Math.trunc(600 * st.health_multiplier);
    self.gib_health = -130;
    self.mass = 600;
    self.yaw_speed = 40;
    MedicCommanderCache();
  } else {
    self.health = Math.trunc(300 * st.health_multiplier);
    self.gib_health = -130;
    self.mass = 400;
  }

  self.pain = medic_pain;
  self.die = medic_die;

  self.monsterinfo.stand = medic_stand;
  self.monsterinfo.walk = medic_walk;
  self.monsterinfo.run = medic_run;
  self.monsterinfo.dodge = M_MonsterDodge;
  self.monsterinfo.duck = medic_duck;
  self.monsterinfo.unduck = monster_duck_up;
  self.monsterinfo.sidestep = medic_sidestep;
  self.monsterinfo.blocked = medic_blocked;
  self.monsterinfo.attack = medic_attack;
  self.monsterinfo.melee = null;
  self.monsterinfo.sight = medic_sight;
  self.monsterinfo.idle = medic_idle;
  self.monsterinfo.search = medic_search;
  self.monsterinfo.checkattack = medic_checkattack;
  self.monsterinfo.setskin = medic_setskin;

  gi.linkentity(self);

  M_SetAnimation(self, medic_move_stand, true);
  self.monsterinfo.scale = MODEL_SCALE;

  walkmonster_start(self);

  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_IGNORE_SHOTS;

  if (self.mass > 400) {
    self.s.skinnum = 2;

    assignSound(commander_sound_idle1, "medic_commander/medidle.wav");
    assignSound(commander_sound_pain1, "medic_commander/medpain1.wav");
    assignSound(commander_sound_pain2, "medic_commander/medpain2.wav");
    assignSound(commander_sound_die, "medic_commander/meddeth.wav");
    assignSound(commander_sound_sight, "medic_commander/medsght.wav");
    assignSound(commander_sound_search, "medic_commander/medsrch.wav");
    assignSound(commander_sound_hook_launch, "medic_commander/medatck2c.wav");
    assignSound(commander_sound_hook_hit, "medic_commander/medatck3a.wav");
    assignSound(commander_sound_hook_heal, "medic_commander/medatck4a.wav");
    assignSound(commander_sound_hook_retract, "medic_commander/medatck5a.wav");
    assignSound(commander_sound_spawn, "medic_commander/monsterspawn1.wav");
    gi.soundindex("tank/tnkatck3.wav");

    let reinforcements = default_reinforcements;

    if (!st.keys_specified.has("monster_slots")) self.monsterinfo.monster_slots = default_monster_slots_base;
    if (st.keys_specified.has("reinforcements") && st.reinforcements !== null) reinforcements = st.reinforcements;

    if (self.monsterinfo.monster_slots !== 0 && reinforcements) {
      if (Math.trunc(skillValue()) !== 0) {
        self.monsterinfo.monster_slots += Math.floor(self.monsterinfo.monster_slots * (skillValue() / 2.0));
      }

      M_SetupReinforcements(reinforcements, self.monsterinfo.reinforcements);
    }
  } else {
    assignSound(sound_idle1, "medic/idle.wav");
    assignSound(sound_pain1, "medic/medpain1.wav");
    assignSound(sound_pain2, "medic/medpain2.wav");
    assignSound(sound_die, "medic/meddeth1.wav");
    assignSound(sound_sight, "medic/medsght1.wav");
    assignSound(sound_search, "medic/medsrch1.wav");
    assignSound(sound_hook_launch, "medic/medatck2.wav");
    assignSound(sound_hook_hit, "medic/medatck3.wav");
    assignSound(sound_hook_heal, "medic/medatck4.wav");
    assignSound(sound_hook_retract, "medic/medatck5.wav");
    gi.soundindex("medic/medatck1.wav");

    self.s.skinnum = 0;
  }
}
