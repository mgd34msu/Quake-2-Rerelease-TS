// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_boss2.c -- BOSS2 ("Hornet") monster (2023 Quake II re-release / "KEX"
// engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/m_boss2.cpp (685 lines) +
// m_boss2.h (192 lines, frame-index enum + MODEL_SCALE), C++17. Behavioral
// code, ported bug-for-bug per this port line's house conventions (see
// g_monster.ts/m_soldier.ts headers). Single spawn: SP_monster_boss2
// (matching g_spawn.ts:1099's already-landed `unported(...)` placeholder
// name exactly).
//
// `src/game/m_boss2.ts` (the already-landed vanilla 3.21 port of the
// *original* boss2) was read for structural sanity-check only (frame-table
// shape, gib list) -- the KEX C++ source above is the actual authority, and
// it differs from the original in several re-release-only ways: the
// hyperblaster attack variant (`Boss2HyperBlaster`, `[Paril-KEX]`), the N64
// rocket-burst behavior (`Boss2Rocket64`, gated by `SPAWNFLAG_BOSS2_N64`),
// `AI_IGNORE_SHOTS`, and the generic `M_CheckAttack_Base`-based
// `Boss2_CheckAttack` (the original used a bespoke checkattack).
//
// ============================================================================
// EXTERNAL DEPENDENCIES ALREADY LANDED ELSEWHERE -- IMPORTED, NOT DUPLICATED
// ============================================================================
// - `PredictAim` (rogue/g_rogue_newai.cpp:1083-1132) and `BossExplode`
//   (m_boss2.cpp:406's periodic-explosion death-frame thinkfunc) are both
//   real, exported logic in `m_supertank.ts` -- imported from there rather
//   than re-derived, per that file's own precedent ("exported, shared with
//   m_tank.ts/m_chick.ts/m_parasite.ts"), to avoid a second independent
//   copy of either algorithm.
// - `infront` (g_ai.ts) and `M_CheckAttack_Base` (g_ai.ts) are landed,
//   exported helpers; `Boss2_CheckAttack` is a thin one-line wrapper over
//   the latter, exactly as the C++ comment "[Paril-KEX] use generic
//   function" implies.
//
// ============================================================================
// FORWARD-DECLARED C++ FUNCTIONS -> TS HOISTED `function` DECLARATIONS
// ============================================================================
// The C++ source forward-declares `boss2_run`/`boss2_dead`/
// `boss2_attack_mg`/`boss2_reattack_mg` so its frame tables (defined above
// their bodies) can reference them. Matching m_soldier.ts's established
// idiom, each is a plain `function name(...) {}` (hoisted with its full
// body), not a `const x = RegisterXxx(...)` arrow. Only the C++
// macro-decorated functions (MONSTERINFO_*/PAIN/DIE) are genuinely
// save-registry-tagged in the source; `boss2_dead`, `boss2_attack_mg`,
// `boss2_reattack_mg`, and every `Boss2*`/`boss2_*` frame-thinkfunc/mmove-
// endfunc helper are plain, undecorated C++ functions, so per
// g_local_types.ts's own note ("Frame-function fields are plain (not
// save-registry-typed)") they get NO RegisterXxx call here either --
// they're referenced directly as `MframeT.thinkfunc`/`MmoveT.endfunc`
// values, exactly like the C++ raw function pointers they came from.
//
// ============================================================================
// OTHER DEVIATIONS
// ============================================================================
// - `self->enemy->...` dereferences with no null check (`Boss2Rocket`,
//   `Boss2Rocket64`, `boss2_attack`, `boss2_reattack_mg`) trust the
//   monster-AI invariant that `monsterinfo.attack`/frame-thinkfuncs are only
//   ever invoked while `self.enemy` is set. TS requires an explicit
//   narrowing guard for the same access; each such function captures
//   `const enemy = self.enemy;` and returns early on `null` (a
//   behavior-preserving guard, not new game logic), matching
//   `blocked_checkplat`'s/`M_MonsterDodge`'s own established precedent for
//   the identical situation elsewhere in this port line.
// - Vec3 arithmetic chains (`dir = vec - start; dir.normalize(); dir +=
//   (right * k); dir.normalize();`) use q_vec3.ts's functional
//   `vec3_add`/`vec3_sub`/`vec3_muls`/`vec3_normalized` helpers (each
//   returns a new Vec3), matching m_soldier.ts's own documented deviation
//   from the C++ operator-overload style.
// - `cached_soundindex` fields are plain `{ index: 0 }` objects assigned via
//   a local `assignSound` helper, duplicating m_soldier.ts's identical
//   per-file helper (not imported -- matches this port line's "duplicated
//   per-file, not imported" convention for such small helpers).
// - `frandom()` -> `frandom()` imported from `q_std.ts` (not raw
//   `Math.random()`), matching m_supertank.ts's own mapping for the
//   identical C++ call.

import { vec3, type Vec3 } from "../shared/math";
import { MonsterMuzzleflashIdT, SolidT, SoundchanT, EffectsT, ATTN_NONE, ServerCommandT, KexTempEventT, KexMulticastT } from "../kexapi/game";
import {
  type EdictT,
  MovetypeT,
  MonsterAiFlagsT,
  EntFlagsT,
  DEFAULT_BULLET_HSPREAD,
  DEFAULT_BULLET_VSPREAD,
  GibTypeT,
  SPAWNFLAG_MONSTER_DEAD,
  ModIdT,
} from "./g_local";
import { gi, level } from "./g_main_globals";
import { Gtime_add, Gtime_from_sec } from "./gtime";
import { frandom } from "./q_std";
import { type SpawnFlags, SpawnFlags_from, SpawnFlags_has } from "./spawnflags";
import { vec3_add, vec3_sub, vec3_muls, vec3_length, vec3_normalized, AngleVectors } from "./q_vec3";
import { MframeT, MmoveT, MmoveEndfuncFn } from "./g_local_types";
import { RegisterMmove, RegisterPain, RegisterDie, RegisterMonsterinfoStand, RegisterMonsterinfoWalk, RegisterMonsterinfoRun, RegisterMonsterinfoAttack, RegisterMonsterinfoSearch, RegisterMonsterinfoSetskin, RegisterMonsterinfoCheckattack } from "./g_save_registry";
import type { ModT } from "./g_local_types";
import { ai_stand, ai_walk, ai_run, ai_move, ai_charge, infront, M_CheckAttack_Base } from "./g_ai";
import { monster_fire_bullet, monster_fire_blaster, monster_fire_rocket, M_ProjectFlashSource, M_ShouldReactToPain, M_SetAnimation, M_AllowSpawn, flymonster_start } from "./g_monster";
import { PredictAim, BossExplode } from "./m_supertank";
import { monsterFlashOffset } from "./m_flash";
import { ThrowGibs, type GibDefT } from "./g_misc";
import { G_FreeEdict } from "./g_utils";
import { st } from "./g_spawn";

// ---------------------------------------------------------------------------
// m_boss2.h frame-index enum (192 lines; anonymous enum, declaration order =
// array index, starting at 0) + MODEL_SCALE.
// ---------------------------------------------------------------------------

export const FRAME_stand30 = 0;
export const FRAME_stand31 = 1;
export const FRAME_stand32 = 2;
export const FRAME_stand33 = 3;
export const FRAME_stand34 = 4;
export const FRAME_stand35 = 5;
export const FRAME_stand36 = 6;
export const FRAME_stand37 = 7;
export const FRAME_stand38 = 8;
export const FRAME_stand39 = 9;
export const FRAME_stand40 = 10;
export const FRAME_stand41 = 11;
export const FRAME_stand42 = 12;
export const FRAME_stand43 = 13;
export const FRAME_stand44 = 14;
export const FRAME_stand45 = 15;
export const FRAME_stand46 = 16;
export const FRAME_stand47 = 17;
export const FRAME_stand48 = 18;
export const FRAME_stand49 = 19;
export const FRAME_stand50 = 20;
export const FRAME_stand1 = 21;
export const FRAME_stand2 = 22;
export const FRAME_stand3 = 23;
export const FRAME_stand4 = 24;
export const FRAME_stand5 = 25;
export const FRAME_stand6 = 26;
export const FRAME_stand7 = 27;
export const FRAME_stand8 = 28;
export const FRAME_stand9 = 29;
export const FRAME_stand10 = 30;
export const FRAME_stand11 = 31;
export const FRAME_stand12 = 32;
export const FRAME_stand13 = 33;
export const FRAME_stand14 = 34;
export const FRAME_stand15 = 35;
export const FRAME_stand16 = 36;
export const FRAME_stand17 = 37;
export const FRAME_stand18 = 38;
export const FRAME_stand19 = 39;
export const FRAME_stand20 = 40;
export const FRAME_stand21 = 41;
export const FRAME_stand22 = 42;
export const FRAME_stand23 = 43;
export const FRAME_stand24 = 44;
export const FRAME_stand25 = 45;
export const FRAME_stand26 = 46;
export const FRAME_stand27 = 47;
export const FRAME_stand28 = 48;
export const FRAME_stand29 = 49;
export const FRAME_walk1 = 50;
export const FRAME_walk2 = 51;
export const FRAME_walk3 = 52;
export const FRAME_walk4 = 53;
export const FRAME_walk5 = 54;
export const FRAME_walk6 = 55;
export const FRAME_walk7 = 56;
export const FRAME_walk8 = 57;
export const FRAME_walk9 = 58;
export const FRAME_walk10 = 59;
export const FRAME_walk11 = 60;
export const FRAME_walk12 = 61;
export const FRAME_walk13 = 62;
export const FRAME_walk14 = 63;
export const FRAME_walk15 = 64;
export const FRAME_walk16 = 65;
export const FRAME_walk17 = 66;
export const FRAME_walk18 = 67;
export const FRAME_walk19 = 68;
export const FRAME_walk20 = 69;
export const FRAME_attack1 = 70;
export const FRAME_attack2 = 71;
export const FRAME_attack3 = 72;
export const FRAME_attack4 = 73;
export const FRAME_attack5 = 74;
export const FRAME_attack6 = 75;
export const FRAME_attack7 = 76;
export const FRAME_attack8 = 77;
export const FRAME_attack9 = 78;
export const FRAME_attack10 = 79;
export const FRAME_attack11 = 80;
export const FRAME_attack12 = 81;
export const FRAME_attack13 = 82;
export const FRAME_attack14 = 83;
export const FRAME_attack15 = 84;
export const FRAME_attack16 = 85;
export const FRAME_attack17 = 86;
export const FRAME_attack18 = 87;
export const FRAME_attack19 = 88;
export const FRAME_attack20 = 89;
export const FRAME_attack21 = 90;
export const FRAME_attack22 = 91;
export const FRAME_attack23 = 92;
export const FRAME_attack24 = 93;
export const FRAME_attack25 = 94;
export const FRAME_attack26 = 95;
export const FRAME_attack27 = 96;
export const FRAME_attack28 = 97;
export const FRAME_attack29 = 98;
export const FRAME_attack30 = 99;
export const FRAME_attack31 = 100;
export const FRAME_attack32 = 101;
export const FRAME_attack33 = 102;
export const FRAME_attack34 = 103;
export const FRAME_attack35 = 104;
export const FRAME_attack36 = 105;
export const FRAME_attack37 = 106;
export const FRAME_attack38 = 107;
export const FRAME_attack39 = 108;
export const FRAME_attack40 = 109;
export const FRAME_pain2 = 110;
export const FRAME_pain3 = 111;
export const FRAME_pain4 = 112;
export const FRAME_pain5 = 113;
export const FRAME_pain6 = 114;
export const FRAME_pain7 = 115;
export const FRAME_pain8 = 116;
export const FRAME_pain9 = 117;
export const FRAME_pain10 = 118;
export const FRAME_pain11 = 119;
export const FRAME_pain12 = 120;
export const FRAME_pain13 = 121;
export const FRAME_pain14 = 122;
export const FRAME_pain15 = 123;
export const FRAME_pain16 = 124;
export const FRAME_pain17 = 125;
export const FRAME_pain18 = 126;
export const FRAME_pain19 = 127;
export const FRAME_pain20 = 128;
export const FRAME_pain21 = 129;
export const FRAME_pain22 = 130;
export const FRAME_pain23 = 131;
export const FRAME_death2 = 132;
export const FRAME_death3 = 133;
export const FRAME_death4 = 134;
export const FRAME_death5 = 135;
export const FRAME_death6 = 136;
export const FRAME_death7 = 137;
export const FRAME_death8 = 138;
export const FRAME_death9 = 139;
export const FRAME_death10 = 140;
export const FRAME_death11 = 141;
export const FRAME_death12 = 142;
export const FRAME_death13 = 143;
export const FRAME_death14 = 144;
export const FRAME_death15 = 145;
export const FRAME_death16 = 146;
export const FRAME_death17 = 147;
export const FRAME_death18 = 148;
export const FRAME_death19 = 149;
export const FRAME_death20 = 150;
export const FRAME_death21 = 151;
export const FRAME_death22 = 152;
export const FRAME_death23 = 153;
export const FRAME_death24 = 154;
export const FRAME_death25 = 155;
export const FRAME_death26 = 156;
export const FRAME_death27 = 157;
export const FRAME_death28 = 158;
export const FRAME_death29 = 159;
export const FRAME_death30 = 160;
export const FRAME_death31 = 161;
export const FRAME_death32 = 162;
export const FRAME_death33 = 163;
export const FRAME_death34 = 164;
export const FRAME_death35 = 165;
export const FRAME_death36 = 166;
export const FRAME_death37 = 167;
export const FRAME_death38 = 168;
export const FRAME_death39 = 169;
export const FRAME_death40 = 170;
export const FRAME_death41 = 171;
export const FRAME_death42 = 172;
export const FRAME_death43 = 173;
export const FRAME_death44 = 174;
export const FRAME_death45 = 175;
export const FRAME_death46 = 176;
export const FRAME_death47 = 177;
export const FRAME_death48 = 178;
export const FRAME_death49 = 179;
export const FRAME_death50 = 180;

export const MODEL_SCALE = 1.0;

// [Paril-KEX] m_boss2.cpp:16
const SPAWNFLAG_BOSS2_N64: SpawnFlags = SpawnFlags_from(8);

// ---------------------------------------------------------------------------
// cached_soundindex fields (m_boss2.cpp:20-24)
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

// ---------------------------------------------------------------------------
// mkframe/mkMove local builders -- see file header ("Vector arithmetic" /
// m_soldier.ts's identical helpers, duplicated per-file).
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

// ---------------------------------------------------------------------------
// MONSTERINFO_SEARCH(boss2_search) (m_boss2.cpp:26-30)
// ---------------------------------------------------------------------------

const boss2_search = RegisterMonsterinfoSearch("boss2_search", (self: EdictT): void => {
  if (frandom() < 0.5) gi.sound(self, SoundchanT.CHAN_VOICE, sound_search1.index, 1, ATTN_NONE, 0);
});

// ---------------------------------------------------------------------------
// forward-declared handlers -- see file header.
// ---------------------------------------------------------------------------

function boss2_run(self: EdictT): void {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) M_SetAnimation(self, boss2_move_stand, true);
  else M_SetAnimation(self, boss2_move_run, true);
}
RegisterMonsterinfoRun("boss2_run", boss2_run);

function boss2_dead(self: EdictT): void {
  // no blowy on deady
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_DEAD)) {
    self.deadflag = false;
    self.takedamage = true;
    return;
  }

  boss2_gib(self);
}

function boss2_attack_mg(self: EdictT): void {
  M_SetAnimation(self, SpawnFlags_has(self.spawnflags, SPAWNFLAG_BOSS2_N64) ? boss2_move_attack_hb : boss2_move_attack_mg, true);
}

function boss2_reattack_mg(self: EdictT): void {
  const enemy = self.enemy;
  if (enemy !== null && infront(self, enemy) && frandom() <= 0.7) boss2_attack_mg(self);
  else M_SetAnimation(self, boss2_move_attack_post_mg, true);
}

// ---------------------------------------------------------------------------
// Boss2PredictiveRocket / Boss2Rocket / Boss2Rocket64 (m_boss2.cpp:37-161)
// ---------------------------------------------------------------------------

const BOSS2_ROCKET_SPEED = 750;

function Boss2PredictiveRocket(self: EdictT): void {
  const forward = vec3(0, 0, 0);
  const right = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, right, null);

  const flash = monsterFlashOffset();

  // 1
  let start = M_ProjectFlashSource(self, flash[MonsterMuzzleflashIdT.MZ2_BOSS2_ROCKET_1], forward, right);
  let dir = vec3(0, 0, 0);
  PredictAim(self, self.enemy, start, BOSS2_ROCKET_SPEED, false, -0.1, dir, null);
  monster_fire_rocket(self, start, dir, 50, BOSS2_ROCKET_SPEED, MonsterMuzzleflashIdT.MZ2_BOSS2_ROCKET_1);

  // 2
  start = M_ProjectFlashSource(self, flash[MonsterMuzzleflashIdT.MZ2_BOSS2_ROCKET_2], forward, right);
  dir = vec3(0, 0, 0);
  PredictAim(self, self.enemy, start, BOSS2_ROCKET_SPEED, false, -0.05, dir, null);
  monster_fire_rocket(self, start, dir, 50, BOSS2_ROCKET_SPEED, MonsterMuzzleflashIdT.MZ2_BOSS2_ROCKET_2);

  // 3
  start = M_ProjectFlashSource(self, flash[MonsterMuzzleflashIdT.MZ2_BOSS2_ROCKET_3], forward, right);
  dir = vec3(0, 0, 0);
  PredictAim(self, self.enemy, start, BOSS2_ROCKET_SPEED, false, 0.05, dir, null);
  monster_fire_rocket(self, start, dir, 50, BOSS2_ROCKET_SPEED, MonsterMuzzleflashIdT.MZ2_BOSS2_ROCKET_3);

  // 4
  start = M_ProjectFlashSource(self, flash[MonsterMuzzleflashIdT.MZ2_BOSS2_ROCKET_4], forward, right);
  dir = vec3(0, 0, 0);
  PredictAim(self, self.enemy, start, BOSS2_ROCKET_SPEED, false, 0.1, dir, null);
  monster_fire_rocket(self, start, dir, 50, BOSS2_ROCKET_SPEED, MonsterMuzzleflashIdT.MZ2_BOSS2_ROCKET_4);
}

function Boss2Rocket(self: EdictT): void {
  const enemy = self.enemy;
  if (enemy === null) return;

  if (enemy.client !== null && frandom() < 0.9) {
    Boss2PredictiveRocket(self);
    return;
  }

  const forward = vec3(0, 0, 0);
  const right = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, right, null);
  const flash = monsterFlashOffset();

  // 1
  let start = M_ProjectFlashSource(self, flash[MonsterMuzzleflashIdT.MZ2_BOSS2_ROCKET_1], forward, right);
  let vec = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2] - 15);
  let dir = vec3_normalized(vec3_sub(vec, start));
  dir = vec3_normalized(vec3_add(dir, vec3_muls(right, 0.4)));
  monster_fire_rocket(self, start, dir, 50, 500, MonsterMuzzleflashIdT.MZ2_BOSS2_ROCKET_1);

  // 2
  start = M_ProjectFlashSource(self, flash[MonsterMuzzleflashIdT.MZ2_BOSS2_ROCKET_2], forward, right);
  vec = enemy.s.origin;
  dir = vec3_normalized(vec3_sub(vec, start));
  dir = vec3_normalized(vec3_add(dir, vec3_muls(right, 0.025)));
  monster_fire_rocket(self, start, dir, 50, 500, MonsterMuzzleflashIdT.MZ2_BOSS2_ROCKET_2);

  // 3
  start = M_ProjectFlashSource(self, flash[MonsterMuzzleflashIdT.MZ2_BOSS2_ROCKET_3], forward, right);
  vec = enemy.s.origin;
  dir = vec3_normalized(vec3_sub(vec, start));
  dir = vec3_normalized(vec3_add(dir, vec3_muls(right, -0.025)));
  monster_fire_rocket(self, start, dir, 50, 500, MonsterMuzzleflashIdT.MZ2_BOSS2_ROCKET_3);

  // 4
  start = M_ProjectFlashSource(self, flash[MonsterMuzzleflashIdT.MZ2_BOSS2_ROCKET_4], forward, right);
  vec = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2] - 15);
  dir = vec3_normalized(vec3_sub(vec, start));
  dir = vec3_normalized(vec3_add(dir, vec3_muls(right, -0.4)));
  monster_fire_rocket(self, start, dir, 50, 500, MonsterMuzzleflashIdT.MZ2_BOSS2_ROCKET_4);
}

// [Paril-KEX] n64 rocket behavior
function Boss2Rocket64(self: EdictT): void {
  const enemy = self.enemy;
  if (enemy === null) return;

  const forward = vec3(0, 0, 0);
  const right = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, right, null);
  let start = M_ProjectFlashSource(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_BOSS2_ROCKET_1], forward, right);

  const scale = self.s.scale !== 0 ? self.s.scale : 1;

  start = vec3(start[0], start[1], start[2] + 10 * scale);
  start = vec3_sub(start, vec3_muls(right, 2 * scale));
  start = vec3_sub(start, vec3_muls(right, (self.count++ % 4) * 8 * scale));

  let vec: Vec3;
  if (enemy.client !== null && frandom() < 0.9) {
    const dir = vec3_sub(enemy.s.origin, start);
    const dist = vec3_length(dir);
    const time = dist / BOSS2_ROCKET_SPEED;
    vec = vec3_add(enemy.s.origin, vec3_muls(enemy.velocity, time - 0.3));
  } else {
    vec = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2] - 15);
  }

  const dir = vec3_normalized(vec3_sub(vec, start));

  monster_fire_rocket(self, start, dir, 35, BOSS2_ROCKET_SPEED, MonsterMuzzleflashIdT.MZ2_BOSS2_ROCKET_1);
}

// ---------------------------------------------------------------------------
// boss2_firebullet_right / boss2_firebullet_left / Boss2MachineGun
// (m_boss2.cpp:163-185)
// ---------------------------------------------------------------------------

function boss2_firebullet_right(self: EdictT): void {
  const forward = vec3(0, 0, 0);
  const right = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, right, null);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_BOSS2_MACHINEGUN_R1], forward, right);
  const aimdir = vec3(0, 0, 0);
  PredictAim(self, self.enemy, start, 0, true, -0.2, aimdir, null);
  monster_fire_bullet(self, start, aimdir, 6, 4, DEFAULT_BULLET_HSPREAD * 3, DEFAULT_BULLET_VSPREAD, MonsterMuzzleflashIdT.MZ2_BOSS2_MACHINEGUN_R1);
}

function boss2_firebullet_left(self: EdictT): void {
  const forward = vec3(0, 0, 0);
  const right = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, right, null);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_BOSS2_MACHINEGUN_L1], forward, right);
  const aimdir = vec3(0, 0, 0);
  PredictAim(self, self.enemy, start, 0, true, -0.2, aimdir, null);
  monster_fire_bullet(self, start, aimdir, 6, 4, DEFAULT_BULLET_HSPREAD * 3, DEFAULT_BULLET_VSPREAD, MonsterMuzzleflashIdT.MZ2_BOSS2_MACHINEGUN_L1);
}

function Boss2MachineGun(self: EdictT): void {
  boss2_firebullet_left(self);
  boss2_firebullet_right(self);
}

// [Paril-KEX]
function Boss2HyperBlaster(self: EdictT): void {
  const enemy = self.enemy;
  if (enemy === null) return;

  const id: MonsterMuzzleflashIdT = (self.s.frame & 1) !== 0 ? MonsterMuzzleflashIdT.MZ2_BOSS2_MACHINEGUN_L2 : MonsterMuzzleflashIdT.MZ2_BOSS2_MACHINEGUN_R2;

  const forward = vec3(0, 0, 0);
  const right = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, right, null);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[id], forward, right);
  const target = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2] + enemy.viewheight);
  const dir = vec3_normalized(vec3_sub(target, start));

  monster_fire_blaster(self, start, dir, 2, 1000, id, self.s.frame % 4 !== 0 ? EffectsT.EF_NONE : EffectsT.EF_HYPERBLASTER);
}

// ---------------------------------------------------------------------------
// Frame tables (m_boss2.cpp:187-456)
// ---------------------------------------------------------------------------

const boss2_frames_stand: MframeT[] = Array.from({ length: 21 }, () => mkframe(ai_stand));
export const boss2_move_stand = RegisterMmove("boss2_move_stand", mkMove(FRAME_stand30, FRAME_stand50, boss2_frames_stand, null));

const boss2_frames_walk: MframeT[] = Array.from({ length: 20 }, () => mkframe(ai_walk, 10));
export const boss2_move_walk = RegisterMmove("boss2_move_walk", mkMove(FRAME_walk1, FRAME_walk20, boss2_frames_walk, null));

const boss2_frames_run: MframeT[] = Array.from({ length: 20 }, () => mkframe(ai_run, 10));
export const boss2_move_run = RegisterMmove("boss2_move_run", mkMove(FRAME_walk1, FRAME_walk20, boss2_frames_run, null));

const boss2_frames_attack_pre_mg: MframeT[] = [
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2, boss2_attack_mg),
];
export const boss2_move_attack_pre_mg = RegisterMmove("boss2_move_attack_pre_mg", mkMove(FRAME_attack1, FRAME_attack9, boss2_frames_attack_pre_mg, null));

// Loop this
const boss2_frames_attack_mg: MframeT[] = [
  mkframe(ai_charge, 2, Boss2MachineGun),
  mkframe(ai_charge, 2, Boss2MachineGun),
  mkframe(ai_charge, 2, Boss2MachineGun),
  mkframe(ai_charge, 2, Boss2MachineGun),
  mkframe(ai_charge, 2, Boss2MachineGun),
  mkframe(ai_charge, 2, boss2_reattack_mg),
];
export const boss2_move_attack_mg = RegisterMmove("boss2_move_attack_mg", mkMove(FRAME_attack10, FRAME_attack15, boss2_frames_attack_mg, null));

const boss2_frames_attack_hb: MframeT[] = [
  mkframe(ai_charge, 2, Boss2HyperBlaster),
  mkframe(ai_charge, 2, Boss2HyperBlaster),
  mkframe(ai_charge, 2, Boss2HyperBlaster),
  mkframe(ai_charge, 2, Boss2HyperBlaster),
  mkframe(ai_charge, 2, Boss2HyperBlaster),
  mkframe(ai_charge, 2, (self: EdictT): void => {
    Boss2HyperBlaster(self);
    boss2_reattack_mg(self);
  }),
];
export const boss2_move_attack_hb = RegisterMmove("boss2_move_attack_hb", mkMove(FRAME_attack10, FRAME_attack15, boss2_frames_attack_hb, null));

const boss2_frames_attack_post_mg: MframeT[] = [mkframe(ai_charge, 2), mkframe(ai_charge, 2), mkframe(ai_charge, 2), mkframe(ai_charge, 2)];
export const boss2_move_attack_post_mg = RegisterMmove("boss2_move_attack_post_mg", mkMove(FRAME_attack16, FRAME_attack19, boss2_frames_attack_post_mg, boss2_run));

const boss2_frames_attack_rocket: MframeT[] = [
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_move, -5, Boss2Rocket),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
];
export const boss2_move_attack_rocket = RegisterMmove("boss2_move_attack_rocket", mkMove(FRAME_attack20, FRAME_attack40, boss2_frames_attack_rocket, boss2_run));

// [Paril-KEX] n64 rocket behavior
const boss2_frames_attack_rocket2: MframeT[] = [
  mkframe(ai_charge, 2, Boss2Rocket64),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2, Boss2Rocket64),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2, Boss2Rocket64),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2, Boss2Rocket64),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2, Boss2Rocket64),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 2),
];
export const boss2_move_attack_rocket2 = RegisterMmove("boss2_move_attack_rocket2", mkMove(FRAME_attack20, FRAME_attack39, boss2_frames_attack_rocket2, boss2_run));

const boss2_frames_pain_heavy: MframeT[] = Array.from({ length: 18 }, () => mkframe(ai_move));
export const boss2_move_pain_heavy = RegisterMmove("boss2_move_pain_heavy", mkMove(FRAME_pain2, FRAME_pain19, boss2_frames_pain_heavy, boss2_run));

const boss2_frames_pain_light: MframeT[] = Array.from({ length: 4 }, () => mkframe(ai_move));
export const boss2_move_pain_light = RegisterMmove("boss2_move_pain_light", mkMove(FRAME_pain20, FRAME_pain23, boss2_frames_pain_light, boss2_run));

function boss2_shrink(self: EdictT): void {
  self.maxs[2] = 50;
  gi.linkentity(self);
}

const boss2_frames_death: MframeT[] = [
  mkframe(ai_move, 0, BossExplode),
  ...Array.from({ length: 30 }, () => mkframe(ai_move)),
  mkframe(ai_move, 0, boss2_shrink),
  ...Array.from({ length: 17 }, () => mkframe(ai_move)),
];
export const boss2_move_death = RegisterMmove("boss2_move_death", mkMove(FRAME_death2, FRAME_death50, boss2_frames_death, boss2_dead));

// ---------------------------------------------------------------------------
// MONSTERINFO_STAND / MONSTERINFO_WALK / MONSTERINFO_ATTACK (m_boss2.cpp:458-501)
// ---------------------------------------------------------------------------

export const boss2_stand = RegisterMonsterinfoStand("boss2_stand", (self: EdictT): void => {
  M_SetAnimation(self, boss2_move_stand, true);
});

export const boss2_walk = RegisterMonsterinfoWalk("boss2_walk", (self: EdictT): void => {
  M_SetAnimation(self, boss2_move_walk, true);
});

export const boss2_attack = RegisterMonsterinfoAttack("boss2_attack", (self: EdictT): void => {
  const enemy = self.enemy;
  if (enemy === null) return;

  const vec = vec3_sub(enemy.s.origin, self.s.origin);
  const range = vec3_length(vec);

  const n64 = SpawnFlags_has(self.spawnflags, SPAWNFLAG_BOSS2_N64);
  if (range <= 125 || frandom() <= 0.6) M_SetAnimation(self, n64 ? boss2_move_attack_hb : boss2_move_attack_pre_mg, true);
  else M_SetAnimation(self, n64 ? boss2_move_attack_rocket2 : boss2_move_attack_rocket, true);
});

// ---------------------------------------------------------------------------
// PAIN(boss2_pain) (m_boss2.cpp:503-527)
// ---------------------------------------------------------------------------

export const boss2_pain = RegisterPain("boss2_pain", (self: EdictT, _other: EdictT, _kick: number, damage: number, mod: ModT): void => {
  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));

  // American wanted these at no attenuation
  if (damage < 10) gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain3.index, 1, ATTN_NONE, 0);
  else if (damage < 30) gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain1.index, 1, ATTN_NONE, 0);
  else gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain2.index, 1, ATTN_NONE, 0);

  if (!M_ShouldReactToPain(self, mod)) return; // no pain anims in nightmare

  if (damage < 30) M_SetAnimation(self, boss2_move_pain_light, true);
  else M_SetAnimation(self, boss2_move_pain_heavy, true);
});

// ---------------------------------------------------------------------------
// MONSTERINFO_SETSKIN(boss2_setskin) (m_boss2.cpp:529-535)
// ---------------------------------------------------------------------------

export const boss2_setskin = RegisterMonsterinfoSetskin("boss2_setskin", (self: EdictT): void => {
  self.s.skinnum = self.health < self.max_health / 2 ? 1 : 0;
});

// ---------------------------------------------------------------------------
// boss2_gib / boss2_dead (already declared above) / DIE(boss2_die)
// (m_boss2.cpp:537-608)
// ---------------------------------------------------------------------------

function boss2_gib(self: EdictT): void {
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_EXPLOSION1_BIG);
  gi.WritePosition(self.s.origin);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PHS, false);

  self.s.sound = 0;
  self.s.skinnum = Math.trunc(self.s.skinnum / 2);

  self.gravityVector[2] = -1.0;

  const gibs: GibDefT[] = [
    { count: 2, gibname: "models/objects/gibs/sm_meat/tris.md2" },
    { count: 2, gibname: "models/objects/gibs/sm_metal/tris.md2", type: GibTypeT.GIB_METALLIC },
    { gibname: "models/monsters/boss2/gibs/chest.md2", type: GibTypeT.GIB_SKINNED },
    { count: 2, gibname: "models/monsters/boss2/gibs/chaingun.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
    { gibname: "models/monsters/boss2/gibs/cpu.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
    { gibname: "models/monsters/boss2/gibs/engine.md2", type: GibTypeT.GIB_SKINNED },
    { gibname: "models/monsters/boss2/gibs/rocket.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
    { gibname: "models/monsters/boss2/gibs/spine.md2", type: GibTypeT.GIB_SKINNED },
    { count: 2, gibname: "models/monsters/boss2/gibs/wing.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
    { gibname: "models/monsters/boss2/gibs/larm.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
    { gibname: "models/monsters/boss2/gibs/rarm.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
    { gibname: "models/monsters/boss2/gibs/larm.md2", scale: 2.0, type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
    { gibname: "models/monsters/boss2/gibs/rarm.md2", scale: 2.0, type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
    { gibname: "models/monsters/boss2/gibs/larm.md2", scale: 1.35, type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
    { gibname: "models/monsters/boss2/gibs/rarm.md2", scale: 1.35, type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
    { gibname: "models/monsters/boss2/gibs/head.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_METALLIC | GibTypeT.GIB_HEAD },
  ];
  ThrowGibs(self, 500, gibs);
}

export const boss2_die = RegisterDie("boss2_die", (self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3, mod: ModT): void => {
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_DEAD)) {
    // check for gib
    if (M_CheckGib(self, mod)) {
      boss2_gib(self);
      self.deadflag = true;
      return;
    }

    if (self.deadflag) return;
  } else {
    gi.sound(self, SoundchanT.CHAN_VOICE, sound_death.index, 1, ATTN_NONE, 0);
    self.deadflag = true;
    self.takedamage = false;
    self.count = 0;
    self.velocity = vec3(0, 0, 0);
    self.gravityVector[2] *= 0.3;
  }

  M_SetAnimation(self, boss2_move_death, true);
});

/** g_local.h:3521-3529 `inline bool M_CheckGib(edict_t *self, const mod_t &mod)`.
 *  Ported locally, verbatim -- see m_soldier.ts's own identical placement-
 *  mismatch note (m_soldier.ts's copy is not imported: no shared home for
 *  it yet, matching that file's "duplicated per-file" convention). */
function M_CheckGib(self: EdictT, mod: ModT): boolean {
  if (self.deadflag) {
    if (mod.id === ModIdT.MOD_CRUSH) return true;
  }
  return self.health <= self.gib_health;
}

// ---------------------------------------------------------------------------
// MONSTERINFO_CHECKATTACK(Boss2_CheckAttack) (m_boss2.cpp:610-614)
// ---------------------------------------------------------------------------

// [Paril-KEX] use generic function
export const Boss2_CheckAttack = RegisterMonsterinfoCheckattack("Boss2_CheckAttack", (self: EdictT): boolean => {
  return M_CheckAttack_Base(self, 0.4, 0.8, 0.8, 0.8, 0.0, 0.0);
});

// ---------------------------------------------------------------------------
// SP_monster_boss2 (m_boss2.cpp:616-685)
// ---------------------------------------------------------------------------

/*QUAKED monster_boss2 (1 .5 0) (-56 -56 0) (56 56 80) Ambush Trigger_Spawn Sight Hyperblaster
 */
export function SP_monster_boss2(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  assignSound(sound_pain1, "bosshovr/bhvpain1.wav");
  assignSound(sound_pain2, "bosshovr/bhvpain2.wav");
  assignSound(sound_pain3, "bosshovr/bhvpain3.wav");
  assignSound(sound_death, "bosshovr/bhvdeth1.wav");
  assignSound(sound_search1, "bosshovr/bhvunqv1.wav");

  gi.soundindex("tank/rocket.wav");

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_BOSS2_N64)) gi.soundindex("flyer/flyatck3.wav");
  else gi.soundindex("infantry/infatck1.wav");

  self.monsterinfo.weapon_sound = gi.soundindex("bosshovr/bhvengn1.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/boss2/tris.md2");

  gi.modelindex("models/monsters/boss2/gibs/chaingun.md2");
  gi.modelindex("models/monsters/boss2/gibs/chest.md2");
  gi.modelindex("models/monsters/boss2/gibs/cpu.md2");
  gi.modelindex("models/monsters/boss2/gibs/engine.md2");
  gi.modelindex("models/monsters/boss2/gibs/head.md2");
  gi.modelindex("models/monsters/boss2/gibs/larm.md2");
  gi.modelindex("models/monsters/boss2/gibs/rarm.md2");
  gi.modelindex("models/monsters/boss2/gibs/rocket.md2");
  gi.modelindex("models/monsters/boss2/gibs/spine.md2");
  gi.modelindex("models/monsters/boss2/gibs/wing.md2");

  self.mins = vec3(-56, -56, 0);
  self.maxs = vec3(56, 56, 80);

  self.health = Math.trunc(2000 * st.health_multiplier);
  self.gib_health = -200;
  self.mass = 1000;

  self.yaw_speed = 50;

  self.flags |= EntFlagsT.FL_IMMUNE_LASER;

  self.pain = boss2_pain;
  self.die = boss2_die;

  self.monsterinfo.stand = boss2_stand;
  self.monsterinfo.walk = boss2_walk;
  self.monsterinfo.run = boss2_run;
  self.monsterinfo.attack = boss2_attack;
  self.monsterinfo.search = boss2_search;
  self.monsterinfo.checkattack = Boss2_CheckAttack;
  self.monsterinfo.setskin = boss2_setskin;
  gi.linkentity(self);

  M_SetAnimation(self, boss2_move_stand, true);
  self.monsterinfo.scale = MODEL_SCALE;

  // [Paril-KEX]
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_IGNORE_SHOTS;

  flymonster_start(self);
}
