// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_chick.cpp / m_chick.h -- CHICK / ICARUS (2023 Quake II re-release /
// "KEX" engine). Ported from ~/Projects/quake2-rerelease-dll/rerelease/
// m_chick.cpp (869 lines, C++17) and m_chick.h (299 lines, 288-entry frame
// enum -- generated mechanically from the header). Behavioral code, ported
// bug-for-bug per PORTING.md.
//
// ============================================================================
// FORWARD-REFERENCED HANDLERS (C++ needed `void chick_stand(edict_t*);`
// etc. at the top of the file; TS resolves this with plain hoisted
// `function` declarations instead)
// ============================================================================
// The C++ source forward-declares five functions at its top (chick_stand,
// chick_run, chick_reslash, chick_rerocket, chick_attack1) because their
// mframe_t/mmove_t tables reference them before their own definitions.
// `chick_reslash`/`chick_rerocket`/`chick_attack1` are pure mframe_t
// thinkfunc/mmove_t endfunc targets (never assigned to a `self.monsterinfo.*`
// field), so per g_local_types.ts's "frame-function fields are plain, not
// save-registry-typed" rule they need no RegisterX wrapper at all -- ordinary
// hoisted `function` declarations, referenced from anywhere in this file
// regardless of textual order. `chick_stand`/`chick_run` ARE assigned to
// `self.monsterinfo.stand`/`.run` (so DO need RegisterMonsterinfoStand/Run
// for save-name resolution) while ALSO being referenced as `mmove_t` endfunc
// targets earlier in the file than a `const ... = RegisterX(...)` binding
// could satisfy without a TDZ error. Resolved by keeping the real logic in
// plain hoisted functions (`chick_stand`/`chick_run`, used everywhere as
// endfunc targets) and registering a separate `chick_stand_registered`/
// `chick_run_registered` binding purely for the `self.monsterinfo.*`
// assignments in SP_monster_chick -- same underlying behavior, no ordering
// hazard, and the registered save-name still matches the C++ function name
// exactly.
//
// ============================================================================
// EXTERNAL / PLACEMENT-MISMATCH DEPENDENCIES PORTED LOCALLY
// ============================================================================
// - `M_CheckGib` (g_local.h:3520, inline): see m_flipper.ts/m_supertank.ts
//   precedent.
// - `monster_footstep` (g_local.h:3282, inline, [Paril-KEX]): one-liner,
//   `self.groundentity !== null -> self.s.event = EV_OTHER_FOOTSTEP`.
// - `monster_done_dodge` (rogue/g_rogue_monster.cpp:98): trivial 4-line
//   `aiflags &= ~AI_DODGING` + attack_state reset, ported for real (matches
//   this porting round's sibling m_gunner.ts/m_infantry.ts choice, not
//   m_berserk.ts's stub -- chick calls it unconditionally from chick_run/
//   chick_pain/chick_attack).
// - `M_MonsterDodge`/`monster_duck_down`/`monster_duck_hold`/
//   `monster_duck_up`/`G_SkillCheck` (rogue/g_rogue_newai.cpp:1292-1445):
//   chick's ENTIRE dodge/duck kit runs through these (`monsterinfo.dodge =
//   M_MonsterDodge`, `.duck = chick_duck`, `.unduck = monster_duck_up`,
//   `.sidestep = chick_sidestep` are all wired in SP_monster_chick) -- per
//   this porting round's own "a stub that breaks every caller isn't a stub,
//   it's a landmine" rule (and matching m_gunner.ts's identical ruling for
//   the identical gap), these are ported for real, not stubbed. Each
//   duplicates its own local copy rather than importing a sibling
//   concurrent-batch file's copy (m_gunner.ts/m_infantry.ts are not in this
//   task's file scope and are still in flight).
// - `PredictAim`/`monster_fire_heat`/`blocked_checkplat`: imported for real
//   from m_supertank.ts, this task's own canonical body (see that file's
//   header) -- NOT re-duplicated here, since m_supertank.ts is in this same
//   task's file scope.
//
// ============================================================================
// KEX-only content vs. the legacy (vanilla Q2) src/game/m_chick.ts port
// ============================================================================
// - Blindfire (ROGUE PMM content): `chick_attack`'s AS_BLIND branch,
//   `ChickRocket`'s entire `blindfire` parameter and its three-attempt
//   (straight/shift-left/shift-right) retry ladder, and `Chick_PreAttack1`'s
//   `AI_MANUAL_STEERING` ideal_yaw override are all absent from vanilla
//   Q2's chick, which fires exactly one predicted/unpredicted shot with no
//   retry logic and no concept of firing at an unseen target.
// - `monster_fire_heat` (heat-seeking rocket) fires instead of a plain
//   `monster_fire_rocket` whenever `self.s.skinnum > 1` -- i.e. whenever this
//   entity was spawned via `monster_chick_heat`, a [RAFAEL/xatrix]-only
//   variant with no vanilla-Q2 equivalent at all.
// - Dodge/duck (`monsterinfo.dodge`/`.duck`/`.unduck`/`.sidestep`,
//   `chick_duck`/`chick_sidestep`/the `chick_move_duck` table) are entirely
//   new; vanilla chick never ducks or sidesteps.
// - `chick_blocked` (blocked_checkplat) is new; vanilla has no blocked
//   callback.

import { vec3, type Vec3 } from "../shared/math";
import { CHAN_VOICE, CHAN_WEAPON, ATTN_NORM, ATTN_IDLE } from "../shared/q_shared";
import { SvflagsT, SolidT, MASK_PROJECTILE, CvarFlagsT, type KexTraceT } from "../kexapi/game";
import { MonsterMuzzleflashIdT } from "../kexapi/game";
import {
  type EdictT,
  type MframeAifuncFn,
  type MframeThinkfuncFn,
  type MmoveEndfuncFn,
  type ModT,
  MframeT,
  MmoveT,
  MonsterAiFlagsT,
  MonsterAttackStateT,
  MovetypeT,
  ModIdT,
  GibTypeT,
  MELEE_DISTANCE,
  RANGE_MELEE,
  DUCK_INTERVAL,
  random_time,
} from "./g_local";
import { gi, level } from "./g_main_globals";
import { Gtime_add, Gtime_from_sec, Gtime_from_ms, type GTime } from "./gtime";
import { frandom, irandom, brandom } from "./q_std";
import { vec3_add, vec3_sub, vec3_muls, vec3_dot, vec3_normalized, AngleVectors, AngleVectors_destructured, vectoyaw } from "./q_vec3";
import { G_FreeEdict } from "./g_utils";
import { st } from "./g_spawn";
import { ai_stand, ai_run, ai_walk, ai_charge, ai_move, range_to, visible, FoundTarget } from "./g_ai";
import { M_SetAnimation, M_AllowSpawn, M_ShouldReactToPain, M_ProjectFlashSource, M_CheckClearShot, monster_dead, walkmonster_start } from "./g_monster";
import { monster_duck_up, M_MonsterDodge } from "./m_soldier";
import { fire_hit } from "./g_weapon";
import { ThrowGibs, type GibDefT } from "./g_misc";
import { monsterFlashOffset } from "./m_flash";
import { PredictAim, monster_fire_heat, blocked_checkplat } from "./m_supertank";
import { monster_fire_rocket } from "./g_monster";
import {
  RegisterDie,
  RegisterPain,
  RegisterMonsterinfoStand,
  RegisterMonsterinfoWalk,
  RegisterMonsterinfoRun,
  RegisterMonsterinfoMelee,
  RegisterMonsterinfoAttack,
  RegisterMonsterinfoSight,
  RegisterMonsterinfoSetskin,
  RegisterMonsterinfoDodge,
  LookupMonsterinfoDodge,
  RegisterMonsterinfoDuck,
  RegisterMonsterinfoUnduck,
  LookupMonsterinfoUnduck,
  RegisterMonsterinfoSidestep,
  RegisterMonsterinfoBlocked,
  RegisterMmove,
} from "./g_save_registry";
import { KexEntityEventT } from "../kexapi/game";

// ---------------------------------------------------------------------------
// m_chick.h frame constants (generated from the enum, see file header)
// ---------------------------------------------------------------------------

export const FRAME_attak101 = 0;
export const FRAME_attak102 = 1;
export const FRAME_attak103 = 2;
export const FRAME_attak104 = 3;
export const FRAME_attak105 = 4;
export const FRAME_attak106 = 5;
export const FRAME_attak107 = 6;
export const FRAME_attak108 = 7;
export const FRAME_attak109 = 8;
export const FRAME_attak110 = 9;
export const FRAME_attak111 = 10;
export const FRAME_attak112 = 11;
export const FRAME_attak113 = 12;
export const FRAME_attak114 = 13;
export const FRAME_attak115 = 14;
export const FRAME_attak116 = 15;
export const FRAME_attak117 = 16;
export const FRAME_attak118 = 17;
export const FRAME_attak119 = 18;
export const FRAME_attak120 = 19;
export const FRAME_attak121 = 20;
export const FRAME_attak122 = 21;
export const FRAME_attak123 = 22;
export const FRAME_attak124 = 23;
export const FRAME_attak125 = 24;
export const FRAME_attak126 = 25;
export const FRAME_attak127 = 26;
export const FRAME_attak128 = 27;
export const FRAME_attak129 = 28;
export const FRAME_attak130 = 29;
export const FRAME_attak131 = 30;
export const FRAME_attak132 = 31;
export const FRAME_attak201 = 32;
export const FRAME_attak202 = 33;
export const FRAME_attak203 = 34;
export const FRAME_attak204 = 35;
export const FRAME_attak205 = 36;
export const FRAME_attak206 = 37;
export const FRAME_attak207 = 38;
export const FRAME_attak208 = 39;
export const FRAME_attak209 = 40;
export const FRAME_attak210 = 41;
export const FRAME_attak211 = 42;
export const FRAME_attak212 = 43;
export const FRAME_attak213 = 44;
export const FRAME_attak214 = 45;
export const FRAME_attak215 = 46;
export const FRAME_attak216 = 47;
export const FRAME_death101 = 48;
export const FRAME_death102 = 49;
export const FRAME_death103 = 50;
export const FRAME_death104 = 51;
export const FRAME_death105 = 52;
export const FRAME_death106 = 53;
export const FRAME_death107 = 54;
export const FRAME_death108 = 55;
export const FRAME_death109 = 56;
export const FRAME_death110 = 57;
export const FRAME_death111 = 58;
export const FRAME_death112 = 59;
export const FRAME_death201 = 60;
export const FRAME_death202 = 61;
export const FRAME_death203 = 62;
export const FRAME_death204 = 63;
export const FRAME_death205 = 64;
export const FRAME_death206 = 65;
export const FRAME_death207 = 66;
export const FRAME_death208 = 67;
export const FRAME_death209 = 68;
export const FRAME_death210 = 69;
export const FRAME_death211 = 70;
export const FRAME_death212 = 71;
export const FRAME_death213 = 72;
export const FRAME_death214 = 73;
export const FRAME_death215 = 74;
export const FRAME_death216 = 75;
export const FRAME_death217 = 76;
export const FRAME_death218 = 77;
export const FRAME_death219 = 78;
export const FRAME_death220 = 79;
export const FRAME_death221 = 80;
export const FRAME_death222 = 81;
export const FRAME_death223 = 82;
export const FRAME_duck01 = 83;
export const FRAME_duck02 = 84;
export const FRAME_duck03 = 85;
export const FRAME_duck04 = 86;
export const FRAME_duck05 = 87;
export const FRAME_duck06 = 88;
export const FRAME_duck07 = 89;
export const FRAME_pain101 = 90;
export const FRAME_pain102 = 91;
export const FRAME_pain103 = 92;
export const FRAME_pain104 = 93;
export const FRAME_pain105 = 94;
export const FRAME_pain201 = 95;
export const FRAME_pain202 = 96;
export const FRAME_pain203 = 97;
export const FRAME_pain204 = 98;
export const FRAME_pain205 = 99;
export const FRAME_pain301 = 100;
export const FRAME_pain302 = 101;
export const FRAME_pain303 = 102;
export const FRAME_pain304 = 103;
export const FRAME_pain305 = 104;
export const FRAME_pain306 = 105;
export const FRAME_pain307 = 106;
export const FRAME_pain308 = 107;
export const FRAME_pain309 = 108;
export const FRAME_pain310 = 109;
export const FRAME_pain311 = 110;
export const FRAME_pain312 = 111;
export const FRAME_pain313 = 112;
export const FRAME_pain314 = 113;
export const FRAME_pain315 = 114;
export const FRAME_pain316 = 115;
export const FRAME_pain317 = 116;
export const FRAME_pain318 = 117;
export const FRAME_pain319 = 118;
export const FRAME_pain320 = 119;
export const FRAME_pain321 = 120;
export const FRAME_stand101 = 121;
export const FRAME_stand102 = 122;
export const FRAME_stand103 = 123;
export const FRAME_stand104 = 124;
export const FRAME_stand105 = 125;
export const FRAME_stand106 = 126;
export const FRAME_stand107 = 127;
export const FRAME_stand108 = 128;
export const FRAME_stand109 = 129;
export const FRAME_stand110 = 130;
export const FRAME_stand111 = 131;
export const FRAME_stand112 = 132;
export const FRAME_stand113 = 133;
export const FRAME_stand114 = 134;
export const FRAME_stand115 = 135;
export const FRAME_stand116 = 136;
export const FRAME_stand117 = 137;
export const FRAME_stand118 = 138;
export const FRAME_stand119 = 139;
export const FRAME_stand120 = 140;
export const FRAME_stand121 = 141;
export const FRAME_stand122 = 142;
export const FRAME_stand123 = 143;
export const FRAME_stand124 = 144;
export const FRAME_stand125 = 145;
export const FRAME_stand126 = 146;
export const FRAME_stand127 = 147;
export const FRAME_stand128 = 148;
export const FRAME_stand129 = 149;
export const FRAME_stand130 = 150;
export const FRAME_stand201 = 151;
export const FRAME_stand202 = 152;
export const FRAME_stand203 = 153;
export const FRAME_stand204 = 154;
export const FRAME_stand205 = 155;
export const FRAME_stand206 = 156;
export const FRAME_stand207 = 157;
export const FRAME_stand208 = 158;
export const FRAME_stand209 = 159;
export const FRAME_stand210 = 160;
export const FRAME_stand211 = 161;
export const FRAME_stand212 = 162;
export const FRAME_stand213 = 163;
export const FRAME_stand214 = 164;
export const FRAME_stand215 = 165;
export const FRAME_stand216 = 166;
export const FRAME_stand217 = 167;
export const FRAME_stand218 = 168;
export const FRAME_stand219 = 169;
export const FRAME_stand220 = 170;
export const FRAME_stand221 = 171;
export const FRAME_stand222 = 172;
export const FRAME_stand223 = 173;
export const FRAME_stand224 = 174;
export const FRAME_stand225 = 175;
export const FRAME_stand226 = 176;
export const FRAME_stand227 = 177;
export const FRAME_stand228 = 178;
export const FRAME_stand229 = 179;
export const FRAME_stand230 = 180;
export const FRAME_walk01 = 181;
export const FRAME_walk02 = 182;
export const FRAME_walk03 = 183;
export const FRAME_walk04 = 184;
export const FRAME_walk05 = 185;
export const FRAME_walk06 = 186;
export const FRAME_walk07 = 187;
export const FRAME_walk08 = 188;
export const FRAME_walk09 = 189;
export const FRAME_walk10 = 190;
export const FRAME_walk11 = 191;
export const FRAME_walk12 = 192;
export const FRAME_walk13 = 193;
export const FRAME_walk14 = 194;
export const FRAME_walk15 = 195;
export const FRAME_walk16 = 196;
export const FRAME_walk17 = 197;
export const FRAME_walk18 = 198;
export const FRAME_walk19 = 199;
export const FRAME_walk20 = 200;
export const FRAME_walk21 = 201;
export const FRAME_walk22 = 202;
export const FRAME_walk23 = 203;
export const FRAME_walk24 = 204;
export const FRAME_walk25 = 205;
export const FRAME_walk26 = 206;
export const FRAME_walk27 = 207;
export const FRAME_recln201 = 208;
export const FRAME_recln202 = 209;
export const FRAME_recln203 = 210;
export const FRAME_recln204 = 211;
export const FRAME_recln205 = 212;
export const FRAME_recln206 = 213;
export const FRAME_recln207 = 214;
export const FRAME_recln208 = 215;
export const FRAME_recln209 = 216;
export const FRAME_recln210 = 217;
export const FRAME_recln211 = 218;
export const FRAME_recln212 = 219;
export const FRAME_recln213 = 220;
export const FRAME_recln214 = 221;
export const FRAME_recln215 = 222;
export const FRAME_recln216 = 223;
export const FRAME_recln217 = 224;
export const FRAME_recln218 = 225;
export const FRAME_recln219 = 226;
export const FRAME_recln220 = 227;
export const FRAME_recln221 = 228;
export const FRAME_recln222 = 229;
export const FRAME_recln223 = 230;
export const FRAME_recln224 = 231;
export const FRAME_recln225 = 232;
export const FRAME_recln226 = 233;
export const FRAME_recln227 = 234;
export const FRAME_recln228 = 235;
export const FRAME_recln229 = 236;
export const FRAME_recln230 = 237;
export const FRAME_recln231 = 238;
export const FRAME_recln232 = 239;
export const FRAME_recln233 = 240;
export const FRAME_recln234 = 241;
export const FRAME_recln235 = 242;
export const FRAME_recln236 = 243;
export const FRAME_recln237 = 244;
export const FRAME_recln238 = 245;
export const FRAME_recln239 = 246;
export const FRAME_recln240 = 247;
export const FRAME_recln101 = 248;
export const FRAME_recln102 = 249;
export const FRAME_recln103 = 250;
export const FRAME_recln104 = 251;
export const FRAME_recln105 = 252;
export const FRAME_recln106 = 253;
export const FRAME_recln107 = 254;
export const FRAME_recln108 = 255;
export const FRAME_recln109 = 256;
export const FRAME_recln110 = 257;
export const FRAME_recln111 = 258;
export const FRAME_recln112 = 259;
export const FRAME_recln113 = 260;
export const FRAME_recln114 = 261;
export const FRAME_recln115 = 262;
export const FRAME_recln116 = 263;
export const FRAME_recln117 = 264;
export const FRAME_recln118 = 265;
export const FRAME_recln119 = 266;
export const FRAME_recln120 = 267;
export const FRAME_recln121 = 268;
export const FRAME_recln122 = 269;
export const FRAME_recln123 = 270;
export const FRAME_recln124 = 271;
export const FRAME_recln125 = 272;
export const FRAME_recln126 = 273;
export const FRAME_recln127 = 274;
export const FRAME_recln128 = 275;
export const FRAME_recln129 = 276;
export const FRAME_recln130 = 277;
export const FRAME_recln131 = 278;
export const FRAME_recln132 = 279;
export const FRAME_recln133 = 280;
export const FRAME_recln134 = 281;
export const FRAME_recln135 = 282;
export const FRAME_recln136 = 283;
export const FRAME_recln137 = 284;
export const FRAME_recln138 = 285;
export const FRAME_recln139 = 286;
export const FRAME_recln140 = 287;

export const MODEL_SCALE = 1.0;

function M_CheckGib(self: EdictT, mod: ModT): boolean {
  if (self.deadflag) {
    if (mod.id === ModIdT.MOD_CRUSH) return true;
  }
  return self.health <= self.gib_health;
}

function monster_footstep(self: EdictT): void {
  if (self.groundentity !== null) self.s.event = KexEntityEventT.EV_OTHER_FOOTSTEP;
}

function monster_done_dodge(self: EdictT): void {
  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_DODGING;
  if (self.monsterinfo.attack_state === MonsterAttackStateT.AS_SLIDING) self.monsterinfo.attack_state = MonsterAttackStateT.AS_STRAIGHT;
}

function frameTimeAsGtime(): GTime {
  return Gtime_from_ms(gi.frame_time_ms);
}

function cvarOrDefault(name: string, defaultValue: string): { value: number } {
  const c = gi.cvar(name, defaultValue, CvarFlagsT.CVAR_NOFLAGS);
  if (c === null) throw new Error(`gi.cvar(${name}) returned null`);
  return c;
}

/** [Paril-KEX] returns true if the skill check passes (rogue/
 *  g_rogue_newai.cpp:1292-1299). */
function G_SkillCheck(skills: readonly number[]): boolean {
  const skillInt = Math.trunc(cvarOrDefault("skill", "1").value);
  if (skills.length < skillInt) return true;

  const skill_switch = skills[Math.max(0, Math.min(skills.length - 1, skillInt))] ?? 1.0;
  return skill_switch === 1.0 ? true : frandom() < skill_switch;
}

function monster_duck_down(self: EdictT): void {
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_DUCKED;

  self.maxs[2] = self.monsterinfo.base_height - 32;
  self.takedamage = true;
  self.monsterinfo.next_duck_time = Gtime_add(level.time, DUCK_INTERVAL);
  gi.linkentity(self);
}

function monster_duck_hold(self: EdictT): void {
  if (level.time >= self.monsterinfo.duck_wait_time) self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_HOLD_FRAME;
  else self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_HOLD_FRAME;
}

// `monster_duck_up`/`M_MonsterDodge` are also independently duplicated by
// this porting round's concurrent monster batch (m_soldier.ts registers
// both under these exact literal C++ names, matching the same rogue
// source). The save registry is a single process-wide namespace (see
// g_save_registry.ts's `register()`), so whichever module loads first wins
// the name and every later duplicate registration attempt throws. Since
// both copies are ported from the identical C++ source and are therefore
// behaviorally interchangeable, this file looks up the name first and only
// registers its own copy if nothing has claimed it yet -- safe regardless
// of module load order, and avoids a real (observed) `bun test`-time crash:
// "g_save_registry: duplicate monsterinfo_unduck registration for name
// 'monster_duck_up'".
// canonical shared infra: import from m_soldier.ts (the owner). The old
// lookup-or-register guard raced the canonical plain registration when this
// module evaluated first.

const M_MonsterDodge_impl = (self: EdictT, attacker: EdictT, eta: GTime, tr: KexTraceT | null, gravity: boolean): void => {
    const r = frandom();
    let height: number;
    let ducker = false;
    let dodger = false;

    // this needs to be here since this can be called after the monster has "died"
    if (self.health < 1) return;

    if (self.monsterinfo.duck !== null && self.monsterinfo.unduck !== null && !gravity) ducker = true;
    if (self.monsterinfo.sidestep !== null && (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) === 0n) dodger = true;

    if (!ducker && !dodger) return;

    if (self.enemy === null) {
      self.enemy = attacker;
      FoundTarget(self);
    }

    // PMM - don't bother if it's going to hit anyway; fix for weird in-your-face etas
    if (eta < frameTimeAsGtime() || eta > Gtime_from_sec(2.5)) return;

    // skill level determination..
    if (r > 0.5) return;

    if (ducker && tr !== null) {
      height = self.absmax[2] - 32 - 1; // the -1 is because the absmax is s.origin + maxs + 1

      if (!dodger && (tr.endpos[2] <= height || (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_DUCKED) !== 0n)) return;
    } else {
      height = self.absmax[2];
    }

    if (dodger) {
      // if we're already dodging, just finish the sequence, i.e. don't do anything else
      if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_DODGING) !== 0n) return;

      // if we're ducking already, or the shot is at our knees
      if (!ducker || tr === null || tr.endpos[2] <= height || (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_DUCKED) !== 0n) {
        // on Easy & Normal, don't sidestep as often (25% on Easy, 50% on Normal)
        if (!G_SkillCheck([0.25, 0.5, 1.0, 1.0])) {
          self.monsterinfo.dodge_time = Gtime_add(level.time, random_time(Gtime_from_ms(800), Gtime_from_ms(1400)));
          return;
        }

        if (tr !== null) {
          const { right } = AngleVectors_destructured(self.s.angles);
          const diff = vec3_sub(tr.endpos, self.s.origin);
          self.monsterinfo.lefty = vec3_dot(right, diff) >= 0;
        } else {
          self.monsterinfo.lefty = brandom();
        }

        // call the monster specific code here
        if (self.monsterinfo.sidestep !== null && self.monsterinfo.sidestep(self)) {
          // if we are currently ducked, unduck
          if (ducker && (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_DUCKED) !== 0n && self.monsterinfo.unduck !== null) {
            self.monsterinfo.unduck(self);
          }

          self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_DODGING;
          self.monsterinfo.attack_state = MonsterAttackStateT.AS_SLIDING;

          self.monsterinfo.dodge_time = Gtime_add(level.time, random_time(Gtime_from_ms(400), Gtime_from_sec(2)));
        }
        return;
      }
    }

    // [Paril-KEX] we don't need to duck until projectiles are going to hit us very soon.
    if (ducker && tr !== null && eta < Gtime_from_ms(500)) {
      if (self.monsterinfo.next_duck_time > level.time) return;

      monster_done_dodge(self);

      if (self.monsterinfo.duck !== null && self.monsterinfo.duck(self, eta)) {
        // if duck didn't set us yet, do it now
        if (self.monsterinfo.duck_wait_time < level.time) self.monsterinfo.duck_wait_time = Gtime_add(level.time, eta);

        monster_duck_down(self);

        // on Easy & Normal mode, duck longer
        const skillInt = Math.trunc(cvarOrDefault("skill", "1").value);
        if (skillInt === 0) self.monsterinfo.duck_wait_time = Gtime_add(self.monsterinfo.duck_wait_time, random_time(Gtime_from_ms(500), Gtime_from_ms(1000)));
        else if (skillInt === 1) self.monsterinfo.duck_wait_time = Gtime_add(self.monsterinfo.duck_wait_time, random_time(Gtime_from_ms(100), Gtime_from_ms(350)));
      }

      self.monsterinfo.dodge_time = Gtime_add(level.time, random_time(Gtime_from_ms(200), Gtime_from_ms(700)));
    }
};

// see monster_duck_up's comment above -- same process-wide save-registry
// collision risk with the concurrent monster batch's m_soldier.ts.
// canonical M_MonsterDodge imported from m_soldier.ts (see note above).

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

let sound_missile_prelaunch = 0;
let sound_missile_launch = 0;
let sound_melee_swing = 0;
let sound_melee_hit = 0;
let sound_missile_reload = 0;
let sound_death1 = 0;
let sound_death2 = 0;
let sound_fall_down = 0;
let sound_idle1 = 0;
let sound_idle2 = 0;
let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_pain3 = 0;
let sound_sight = 0;
let sound_search = 0;

function ChickMoan(self: EdictT): void {
  if (frandom() < 0.5) gi.sound(self, CHAN_VOICE, sound_idle1, 1, ATTN_IDLE, 0);
  else gi.sound(self, CHAN_VOICE, sound_idle2, 1, ATTN_IDLE, 0);
}

// forward-referenced (see file header) -- plain hoisted functions
function chick_stand(self: EdictT): void {
  M_SetAnimation(self, chick_move_stand, true);
}

function chick_run(self: EdictT): void {
  monster_done_dodge(self);

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) {
    M_SetAnimation(self, chick_move_stand, true);
    return;
  }

  if (self.monsterinfo.active_move === chick_move_walk || self.monsterinfo.active_move === chick_move_start_run) {
    M_SetAnimation(self, chick_move_run, true);
  } else {
    M_SetAnimation(self, chick_move_start_run, true);
  }
}

function chick_fidget(self: EdictT): void {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) return;
  if (self.enemy !== null) return;
  if (frandom() <= 0.3) M_SetAnimation(self, chick_move_fidget, true);
}

const chick_frames_fidget: MframeT[] = [
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand, 0, ChickMoan),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
];
const chick_move_fidget = RegisterMmove("chick_move_fidget", move(FRAME_stand201, FRAME_stand230, chick_frames_fidget, chick_stand));

const chick_frames_stand: MframeT[] = [
  ...Array.from({ length: 29 }, () => frame(ai_stand)),
  frame(ai_stand, 0, chick_fidget),
];
const chick_move_stand = RegisterMmove("chick_move_stand", move(FRAME_stand101, FRAME_stand130, chick_frames_stand));

const chick_stand_registered = RegisterMonsterinfoStand("chick_stand", chick_stand);

const chick_frames_start_run: MframeT[] = [
  frame(ai_run, 1),
  frame(ai_run),
  frame(ai_run, 0, monster_footstep),
  frame(ai_run, -1),
  frame(ai_run, -1, monster_footstep),
  frame(ai_run),
  frame(ai_run, 1),
  frame(ai_run, 3),
  frame(ai_run, 6),
  frame(ai_run, 3),
];
const chick_move_start_run = RegisterMmove("chick_move_start_run", move(FRAME_walk01, FRAME_walk10, chick_frames_start_run, chick_run));

const chick_frames_run: MframeT[] = [
  frame(ai_run, 6),
  frame(ai_run, 8, monster_footstep),
  frame(ai_run, 13),
  frame(ai_run, 5, monster_done_dodge), // make sure to clear dodge bit
  frame(ai_run, 7),
  frame(ai_run, 4),
  frame(ai_run, 11, monster_footstep),
  frame(ai_run, 5),
  frame(ai_run, 9),
  frame(ai_run, 7),
];
const chick_move_run = RegisterMmove("chick_move_run", move(FRAME_walk11, FRAME_walk20, chick_frames_run));

const chick_frames_walk: MframeT[] = [
  frame(ai_walk, 6),
  frame(ai_walk, 8, monster_footstep),
  frame(ai_walk, 13),
  frame(ai_walk, 5),
  frame(ai_walk, 7),
  frame(ai_walk, 4),
  frame(ai_walk, 11, monster_footstep),
  frame(ai_walk, 5),
  frame(ai_walk, 9),
  frame(ai_walk, 7),
];
const chick_move_walk = RegisterMmove("chick_move_walk", move(FRAME_walk11, FRAME_walk20, chick_frames_walk));

const chick_walk = RegisterMonsterinfoWalk("chick_walk", (self: EdictT): void => {
  M_SetAnimation(self, chick_move_walk, true);
});

const chick_run_registered = RegisterMonsterinfoRun("chick_run", chick_run);

const chick_frames_pain1: MframeT[] = Array.from({ length: 5 }, () => frame(ai_move));
const chick_move_pain1 = RegisterMmove("chick_move_pain1", move(FRAME_pain101, FRAME_pain105, chick_frames_pain1, chick_run));

const chick_frames_pain2: MframeT[] = Array.from({ length: 5 }, () => frame(ai_move));
const chick_move_pain2 = RegisterMmove("chick_move_pain2", move(FRAME_pain201, FRAME_pain205, chick_frames_pain2, chick_run));

const chick_frames_pain3: MframeT[] = [
  frame(ai_move),
  frame(ai_move, 0, monster_footstep),
  frame(ai_move, -6),
  frame(ai_move, 3, monster_footstep),
  frame(ai_move, 11),
  frame(ai_move, 3, monster_footstep),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, 4),
  frame(ai_move, 1),
  frame(ai_move),
  frame(ai_move, -3),
  frame(ai_move, -4),
  frame(ai_move, 5),
  frame(ai_move, 7),
  frame(ai_move, -2),
  frame(ai_move, 3),
  frame(ai_move, -5),
  frame(ai_move, -2),
  frame(ai_move, -8),
  frame(ai_move, 2, monster_footstep),
];
const chick_move_pain3 = RegisterMmove("chick_move_pain3", move(FRAME_pain301, FRAME_pain321, chick_frames_pain3, chick_run));

const chick_pain = RegisterPain("chick_pain", (self: EdictT, _other: EdictT, _kick: number, damage: number, mod: ModT): void => {
  monster_done_dodge(self);

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));

  const r = frandom();
  if (r < 0.33) gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
  else if (r < 0.66) gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_pain3, 1, ATTN_NORM, 0);

  if (!M_ShouldReactToPain(self, mod)) return; // no pain anims in nightmare

  // PMM - clear this from blindfire
  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MANUAL_STEERING;

  if (damage <= 10) M_SetAnimation(self, chick_move_pain1, true);
  else if (damage <= 25) M_SetAnimation(self, chick_move_pain2, true);
  else M_SetAnimation(self, chick_move_pain3, true);

  // PMM - clear duck flag
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_DUCKED) !== 0n) monster_duck_up(self);
});

const chick_setpain = RegisterMonsterinfoSetskin("chick_setpain", (self: EdictT): void => {
  if (self.health < self.max_health / 2) self.s.skinnum |= 1;
  else self.s.skinnum &= ~1;
});

function chick_dead(self: EdictT): void {
  self.mins = vec3(-16, -16, 0);
  self.maxs = vec3(16, 16, 8);
  monster_dead(self);
}

function chick_shrink(self: EdictT): void {
  self.maxs[2] = 12;
  self.svflags |= SvflagsT.SVF_DEADMONSTER;
  gi.linkentity(self);
}

const chick_frames_death2: MframeT[] = [
  frame(ai_move, -6),
  frame(ai_move),
  frame(ai_move, -1),
  frame(ai_move, -5, monster_footstep),
  frame(ai_move),
  frame(ai_move, -1),
  frame(ai_move, -2),
  frame(ai_move, 1),
  frame(ai_move, 10),
  frame(ai_move, 2),
  frame(ai_move, 3, monster_footstep),
  frame(ai_move, 1),
  frame(ai_move, 2),
  frame(ai_move),
  frame(ai_move, 3),
  frame(ai_move, 3),
  frame(ai_move, 1, monster_footstep),
  frame(ai_move, -3),
  frame(ai_move, -5),
  frame(ai_move, 4),
  frame(ai_move, 15, chick_shrink),
  frame(ai_move, 14, monster_footstep),
  frame(ai_move, 1),
];
const chick_move_death2 = RegisterMmove("chick_move_death2", move(FRAME_death201, FRAME_death223, chick_frames_death2, chick_dead));

const chick_frames_death1: MframeT[] = [
  frame(ai_move),
  frame(ai_move, 0, monster_footstep),
  frame(ai_move, -7),
  frame(ai_move, 4, monster_footstep),
  frame(ai_move, 11, chick_shrink),
  frame(ai_move),
  frame(ai_move, 0, monster_footstep),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, 0, monster_footstep),
  frame(ai_move),
];
const chick_move_death1 = RegisterMmove("chick_move_death1", move(FRAME_death101, FRAME_death112, chick_frames_death1, chick_dead));

const chick_die = RegisterDie(
  "chick_die",
  (self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3, mod: ModT): void => {
    // check for gib
    if (M_CheckGib(self, mod)) {
      gi.sound(self, CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);

      self.s.skinnum = Math.trunc(self.s.skinnum / 2);

      const gibs: GibDefT[] = [
        { gibname: "models/objects/gibs/bone/tris.md2", count: 2 },
        { gibname: "models/objects/gibs/sm_meat/tris.md2", count: 3 },
        { gibname: "models/monsters/bitch/gibs/arm.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
        { gibname: "models/monsters/bitch/gibs/foot.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
        { gibname: "models/monsters/bitch/gibs/tube.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
        { gibname: "models/monsters/bitch/gibs/chest.md2", type: GibTypeT.GIB_SKINNED },
        { gibname: "models/monsters/bitch/gibs/head.md2", type: GibTypeT.GIB_HEAD | GibTypeT.GIB_SKINNED },
      ];
      ThrowGibs(self, damage, gibs);
      self.deadflag = true;

      return;
    }

    if (self.deadflag) return;

    // regular death
    self.deadflag = true;
    self.takedamage = true;

    const n = brandom();

    if (!n) {
      M_SetAnimation(self, chick_move_death1, true);
      gi.sound(self, CHAN_VOICE, sound_death1, 1, ATTN_NORM, 0);
    } else {
      M_SetAnimation(self, chick_move_death2, true);
      gi.sound(self, CHAN_VOICE, sound_death2, 1, ATTN_NORM, 0);
    }
  },
);

// PMM - changes to duck code for new dodge

const chick_frames_duck: MframeT[] = [
  frame(ai_move, 0, monster_duck_down),
  frame(ai_move, 1),
  frame(ai_move, 4, monster_duck_hold),
  frame(ai_move, -4),
  frame(ai_move, -5, monster_duck_up),
  frame(ai_move, 3),
  frame(ai_move, 1),
];
const chick_move_duck = RegisterMmove("chick_move_duck", move(FRAME_duck01, FRAME_duck07, chick_frames_duck, chick_run));

function ChickSlash(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, self.mins[0], 10);
  gi.sound(self, CHAN_WEAPON, sound_melee_swing, 1, ATTN_NORM, 0);
  fire_hit(self, aim, irandom(10, 16), 100);
}

function ChickRocket(self: EdictT): void {
  const blindfire = (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) !== 0n;

  if (self.enemy === null || !self.enemy.inuse) return; // PGM

  const { forward, right } = AngleVectors_destructured(self.s.angles);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_CHICK_ROCKET_1], forward, right);

  // [Paril-KEX]
  const rocketSpeed = self.s.skinnum > 1 ? 500 : 650;

  // PMM
  const target = blindfire ? self.monsterinfo.blind_fire_target : self.enemy.s.origin;
  // pmm

  let vec: Vec3;
  let dir: Vec3;

  // PGM
  // PMM - blindfire shooting
  if (blindfire) {
    vec = vec3(target[0], target[1], target[2]);
    dir = vec3_sub(vec, start);
  }
  // pmm
  // don't shoot at feet if they're above where i'm shooting from.
  else if (frandom() < 0.33 || start[2] < self.enemy.absmin[2]) {
    vec = vec3(target[0], target[1], target[2]);
    vec[2] += self.enemy.viewheight;
    dir = vec3_sub(vec, start);
  } else {
    vec = vec3(target[0], target[1], target[2]);
    vec[2] = self.enemy.absmin[2] + 1;
    dir = vec3_sub(vec, start);
  }
  // PGM

  //======
  // PMM - lead target (not when blindfiring)
  // 20, 35, 50, 65 chance of leading
  if (!blindfire && frandom() < 0.35) {
    const dirOut = vec3Copy(dir);
    PredictAim(self, self.enemy, start, rocketSpeed, false, 0, dirOut, vec);
    dir = dirOut;
  }
  // PMM - lead target
  //======

  dir = vec3_normalized(dir);

  // pmm blindfire doesn't check target (done in checkattack)
  // paranoia, make sure we're not shooting a target right next to us
  let trace = gi.trace(start, null, null, vec, self, MASK_PROJECTILE);
  if (blindfire) {
    // blindfire has different fail criteria for the trace
    if (!(trace.startsolid || trace.allsolid || trace.fraction < 0.5)) {
      // RAFAEL
      if (self.s.skinnum > 1) monster_fire_heat(self, start, dir, 50, rocketSpeed, MonsterMuzzleflashIdT.MZ2_CHICK_ROCKET_1, 0.075);
      else monster_fire_rocket(self, start, dir, 50, rocketSpeed, MonsterMuzzleflashIdT.MZ2_CHICK_ROCKET_1);
    } else {
      // geez, this is bad. she's avoiding about 80% of her blindfires due to hitting things.
      // hunt around for a good shot
      // try shifting the target to the left a little (to help counter her large offset)
      vec = vec3(target[0], target[1], target[2]);
      vec = vec3_add(vec, vec3_muls(right, -10));
      dir = vec3_normalized(vec3_sub(vec, start));
      trace = gi.trace(start, null, null, vec, self, MASK_PROJECTILE);
      if (!(trace.startsolid || trace.allsolid || trace.fraction < 0.5)) {
        // RAFAEL
        if (self.s.skinnum > 1) monster_fire_heat(self, start, dir, 50, rocketSpeed, MonsterMuzzleflashIdT.MZ2_CHICK_ROCKET_1, 0.075);
        else monster_fire_rocket(self, start, dir, 50, rocketSpeed, MonsterMuzzleflashIdT.MZ2_CHICK_ROCKET_1);
      } else {
        // ok, that failed. try to the right
        vec = vec3(target[0], target[1], target[2]);
        vec = vec3_add(vec, vec3_muls(right, 10));
        dir = vec3_normalized(vec3_sub(vec, start));
        trace = gi.trace(start, null, null, vec, self, MASK_PROJECTILE);
        if (!(trace.startsolid || trace.allsolid || trace.fraction < 0.5)) {
          // RAFAEL
          if (self.s.skinnum > 1) monster_fire_heat(self, start, dir, 50, rocketSpeed, MonsterMuzzleflashIdT.MZ2_CHICK_ROCKET_1, 0.075);
          else monster_fire_rocket(self, start, dir, 50, rocketSpeed, MonsterMuzzleflashIdT.MZ2_CHICK_ROCKET_1);
        }
      }
    }
  } else {
    const trEnt = trace.ent;
    if (trace.fraction > 0.5 || trEnt === null || trEnt.solid !== SolidT.SOLID_BSP) {
      // RAFAEL
      if (self.s.skinnum > 1) monster_fire_heat(self, start, dir, 50, rocketSpeed, MonsterMuzzleflashIdT.MZ2_CHICK_ROCKET_1, 0.15);
      else monster_fire_rocket(self, start, dir, 50, rocketSpeed, MonsterMuzzleflashIdT.MZ2_CHICK_ROCKET_1);
    }
  }
}

function vec3Copy(v: Vec3): Vec3 {
  return vec3(v[0], v[1], v[2]);
}

function Chick_PreAttack1(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_missile_prelaunch, 1, ATTN_NORM, 0);

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) !== 0n) {
    const aim = vec3_sub(self.monsterinfo.blind_fire_target, self.s.origin);
    self.ideal_yaw = vectoyaw(aim);
  }
}

function ChickReload(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_missile_reload, 1, ATTN_NORM, 0);
}

const chick_frames_start_attack1: MframeT[] = [
  frame(ai_charge, 0, Chick_PreAttack1),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 4),
  frame(ai_charge),
  frame(ai_charge, -3),
  frame(ai_charge, 3),
  frame(ai_charge, 5),
  frame(ai_charge, 7, monster_footstep),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, (self: EdictT): void => chick_attack1(self)),
];
const chick_move_start_attack1 = RegisterMmove("chick_move_start_attack1", move(FRAME_attak101, FRAME_attak113, chick_frames_start_attack1));

const chick_frames_attack1: MframeT[] = [
  frame(ai_charge, 19, ChickRocket),
  frame(ai_charge, -6, monster_footstep),
  frame(ai_charge, -5),
  frame(ai_charge, -2),
  frame(ai_charge, -7, monster_footstep),
  frame(ai_charge),
  frame(ai_charge, 1),
  frame(ai_charge, 10, ChickReload),
  frame(ai_charge, 4),
  frame(ai_charge, 5, monster_footstep),
  frame(ai_charge, 6),
  frame(ai_charge, 6),
  frame(ai_charge, 4),
  frame(ai_charge, 3, (self: EdictT): void => {
    chick_rerocket(self);
    monster_footstep(self);
  }),
];
const chick_move_attack1 = RegisterMmove("chick_move_attack1", move(FRAME_attak114, FRAME_attak127, chick_frames_attack1));

const chick_frames_end_attack1: MframeT[] = [
  frame(ai_charge, -3),
  frame(ai_charge),
  frame(ai_charge, -6),
  frame(ai_charge, -4),
  frame(ai_charge, -2, monster_footstep),
];
const chick_move_end_attack1 = RegisterMmove("chick_move_end_attack1", move(FRAME_attak128, FRAME_attak132, chick_frames_end_attack1, chick_run));

// forward-referenced (see file header) -- plain hoisted function
function chick_rerocket(self: EdictT): void {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) !== 0n) {
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MANUAL_STEERING;
    M_SetAnimation(self, chick_move_end_attack1, true);
    return;
  }

  if (!M_CheckClearShot(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_CHICK_ROCKET_1])) {
    M_SetAnimation(self, chick_move_end_attack1, true);
    return;
  }

  if (self.enemy !== null && self.enemy.health > 0) {
    if (range_to(self, self.enemy) > RANGE_MELEE && visible(self, self.enemy) && frandom() <= 0.7) {
      M_SetAnimation(self, chick_move_attack1, true);
      return;
    }
  }
  M_SetAnimation(self, chick_move_end_attack1, true);
}

// forward-referenced (see file header) -- plain hoisted function
function chick_attack1(self: EdictT): void {
  M_SetAnimation(self, chick_move_attack1, true);
}

const chick_frames_slash: MframeT[] = [
  frame(ai_charge, 1),
  frame(ai_charge, 7, ChickSlash),
  frame(ai_charge, -7, monster_footstep),
  frame(ai_charge, 1),
  frame(ai_charge, -1),
  frame(ai_charge, 1),
  frame(ai_charge),
  frame(ai_charge, 1),
  frame(ai_charge, -2, (self: EdictT): void => chick_reslash(self)),
];
const chick_move_slash = RegisterMmove("chick_move_slash", move(FRAME_attak204, FRAME_attak212, chick_frames_slash));

const chick_frames_end_slash: MframeT[] = [
  frame(ai_charge, -6),
  frame(ai_charge, -1),
  frame(ai_charge, -6),
  frame(ai_charge, 0, monster_footstep),
];
const chick_move_end_slash = RegisterMmove("chick_move_end_slash", move(FRAME_attak213, FRAME_attak216, chick_frames_end_slash, chick_run));

// forward-referenced (see file header) -- plain hoisted function
function chick_reslash(self: EdictT): void {
  if (self.enemy !== null && self.enemy.health > 0) {
    if (range_to(self, self.enemy) <= RANGE_MELEE) {
      if (frandom() <= 0.9) {
        M_SetAnimation(self, chick_move_slash, true);
        return;
      }
      M_SetAnimation(self, chick_move_end_slash, true);
      return;
    }
  }
  M_SetAnimation(self, chick_move_end_slash, true);
}

function chick_slash(self: EdictT): void {
  M_SetAnimation(self, chick_move_slash, true);
}

const chick_frames_start_slash: MframeT[] = [frame(ai_charge, 1), frame(ai_charge, 8), frame(ai_charge, 3)];
const chick_move_start_slash = RegisterMmove("chick_move_start_slash", move(FRAME_attak201, FRAME_attak203, chick_frames_start_slash, chick_slash));

const chick_melee = RegisterMonsterinfoMelee("chick_melee", (self: EdictT): void => {
  M_SetAnimation(self, chick_move_start_slash, true);
});

const chick_attack = RegisterMonsterinfoAttack("chick_attack", (self: EdictT): void => {
  if (!M_CheckClearShot(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_CHICK_ROCKET_1])) return;

  monster_done_dodge(self);

  // PMM
  if (self.monsterinfo.attack_state === MonsterAttackStateT.AS_BLIND) {
    // setup shot probabilities
    let chance: number;
    if (self.monsterinfo.blind_fire_delay < Gtime_from_sec(1)) chance = 1.0;
    else if (self.monsterinfo.blind_fire_delay < Gtime_from_sec(7.5)) chance = 0.4;
    else chance = 0.1;

    const r = frandom();

    // minimum of 5.5 seconds, plus 0-1, after the shots are done
    self.monsterinfo.blind_fire_delay = Gtime_add(self.monsterinfo.blind_fire_delay, random_time(Gtime_from_sec(5.5), Gtime_from_sec(6.5)));

    // don't shoot at the origin
    if (self.monsterinfo.blind_fire_target[0] === 0 && self.monsterinfo.blind_fire_target[1] === 0 && self.monsterinfo.blind_fire_target[2] === 0) {
      return;
    }

    // don't shoot if the dice say not to
    if (r > chance) return;

    // turn on manual steering to signal both manual steering and blindfire
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_MANUAL_STEERING;
    M_SetAnimation(self, chick_move_start_attack1, true);
    self.monsterinfo.attack_finished = Gtime_add(level.time, random_time(Gtime_from_sec(2)));
    return;
  }
  // pmm

  M_SetAnimation(self, chick_move_start_attack1, true);
});

const chick_sight = RegisterMonsterinfoSight("chick_sight", (self: EdictT, _other: EdictT): void => {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
});

// ===========
// PGM
const chick_blocked = RegisterMonsterinfoBlocked("chick_blocked", (self: EdictT, dist: number): boolean => {
  return blocked_checkplat(self, dist);
});
// PGM
// ===========

const chick_duck = RegisterMonsterinfoDuck("chick_duck", (self: EdictT, _eta: GTime): boolean => {
  if (self.monsterinfo.active_move === chick_move_start_attack1 || self.monsterinfo.active_move === chick_move_attack1) {
    // if we're shooting don't dodge
    if (self.monsterinfo.unduck !== null) self.monsterinfo.unduck(self);
    return false;
  }

  M_SetAnimation(self, chick_move_duck, true);

  return true;
});

const chick_sidestep = RegisterMonsterinfoSidestep("chick_sidestep", (self: EdictT): boolean => {
  if (
    self.monsterinfo.active_move === chick_move_start_attack1 ||
    self.monsterinfo.active_move === chick_move_attack1 ||
    self.monsterinfo.active_move === chick_move_pain3
  ) {
    // if we're shooting, don't dodge
    return false;
  }

  if (self.monsterinfo.active_move !== chick_move_run) M_SetAnimation(self, chick_move_run, true);

  return true;
});

/**
 * QUAKED monster_chick (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn
 * Sight
 */
export function SP_monster_chick(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  sound_missile_prelaunch = gi.soundindex("chick/chkatck1.wav");
  sound_missile_launch = gi.soundindex("chick/chkatck2.wav");
  sound_melee_swing = gi.soundindex("chick/chkatck3.wav");
  sound_melee_hit = gi.soundindex("chick/chkatck4.wav");
  sound_missile_reload = gi.soundindex("chick/chkatck5.wav");
  sound_death1 = gi.soundindex("chick/chkdeth1.wav");
  sound_death2 = gi.soundindex("chick/chkdeth2.wav");
  sound_fall_down = gi.soundindex("chick/chkfall1.wav");
  sound_idle1 = gi.soundindex("chick/chkidle1.wav");
  sound_idle2 = gi.soundindex("chick/chkidle2.wav");
  sound_pain1 = gi.soundindex("chick/chkpain1.wav");
  sound_pain2 = gi.soundindex("chick/chkpain2.wav");
  sound_pain3 = gi.soundindex("chick/chkpain3.wav");
  sound_sight = gi.soundindex("chick/chksght1.wav");
  sound_search = gi.soundindex("chick/chksrch1.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/bitch/tris.md2");

  gi.modelindex("models/monsters/bitch/gibs/arm.md2");
  gi.modelindex("models/monsters/bitch/gibs/chest.md2");
  gi.modelindex("models/monsters/bitch/gibs/foot.md2");
  gi.modelindex("models/monsters/bitch/gibs/head.md2");
  gi.modelindex("models/monsters/bitch/gibs/tube.md2");

  self.mins = vec3(-16, -16, 0);
  self.maxs = vec3(16, 16, 56);

  self.health = Math.trunc(175 * st.health_multiplier);
  self.gib_health = -70;
  self.mass = 200;

  self.pain = chick_pain;
  self.die = chick_die;

  self.monsterinfo.stand = chick_stand_registered;
  self.monsterinfo.walk = chick_walk;
  self.monsterinfo.run = chick_run_registered;
  // pmm
  self.monsterinfo.dodge = M_MonsterDodge;
  self.monsterinfo.duck = chick_duck;
  self.monsterinfo.unduck = monster_duck_up;
  self.monsterinfo.sidestep = chick_sidestep;
  self.monsterinfo.blocked = chick_blocked; // PGM
  // pmm
  self.monsterinfo.attack = chick_attack;
  self.monsterinfo.melee = chick_melee;
  self.monsterinfo.sight = chick_sight;
  self.monsterinfo.setskin = chick_setpain;

  gi.linkentity(self);

  M_SetAnimation(self, chick_move_stand, true);
  self.monsterinfo.scale = MODEL_SCALE;

  // PMM
  self.monsterinfo.blindfire = true;
  // pmm
  walkmonster_start(self);
}

// RAFAEL
/**
 * QUAKED monster_chick_heat (1 .5 0) (-16 -16 -24) (16 16 32) Ambush
 * Trigger_Spawn Sight
 */
export function SP_monster_chick_heat(self: EdictT): void {
  SP_monster_chick(self);
  self.s.skinnum = 2;
  gi.soundindex("weapons/railgr1a.wav");
}
// RAFAEL
