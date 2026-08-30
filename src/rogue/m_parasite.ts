/*
Copyright (c) ZeniMax Media Inc.
Licensed under the GNU General Public License 2.0.
Ported from rogue/m_parasite.c.

rogue/m_parasite.c vs baseq2/m_parasite.c (ported at src/game/m_parasite.ts):
  - `parasite_drain_attack_ok` loses its `static` (m_parasite.c:280-281,
    "//static ... \n qboolean parasite_drain_attack_ok") and gains a
    forward-declared external-linkage prototype in g_newai.c (RG-systems'
    SCOPE) at g_newai.c:31 -- g_newai.c's `blocked_checkshot` special-cases
    `monster_parasite` and calls straight into this function. It is
    `export`ed here (not module-private, unlike the base port) so
    src/rogue/g_newai.ts can `import { parasite_drain_attack_ok } from
    "./m_parasite"` -- reported cross-unit dependency, see FINAL REPORT.
  - New ROGUE-only jump attack: parasite_jump_down/parasite_jump_up/
    parasite_jump_wait_land/parasite_move_jump_down/parasite_move_jump_up/
    parasite_jump (m_parasite.c:426-473), using the pack's shared
    monster_jump_start/monster_jump_finished helpers (g_newai.c, RG-systems'
    SCOPE) and the new FRAME_jump01..08 frames.
  - New parasite_blocked (m_parasite.c:505-518) and parasite_checkattack
    (m_parasite.c:523-562), wired to monsterinfo.blocked/checkattack in
    SP_monster_parasite (m_parasite.c:667-668). Both use the pack's
    blocked_checkshot/blocked_checkjump/blocked_checkplat helpers (g_newai.c,
    RG-systems' SCOPE).

Deviations (bug-for-bug fidelity, PORTING.md/type-discipline rule #3):
  - parasite_blocked (m_parasite.c:505-518) falls off the end of the
    function with no `return` statement when none of the three
    blocked_check* calls matched -- undefined behavior in C (the compiler
    warns "control reaches end of non-void function"; the returned qboolean
    is whatever garbage was left in the return register). TypeScript has no
    equivalent hole to reproduce; ported as `return false` ("not blocked"),
    matching the function's only other implicit meaning.
  - parasite_checkattack (m_parasite.c:523-562) has the identical bug: it
    falls off the end with no return when the drain-attack trace line to
    the enemy IS clear (`tr.ent == self->enemy`, i.e. the `if` at
    m_parasite.c:551 is false). Ported as `return true`, since `retval` was
    already true at that point and every other path either explicitly
    returns false (bad shot) or true (blocked shot handled) -- the clear-shot
    fallthrough is the "yes, attack is fine" case.
*/
/*
==============================================================================

parasite

==============================================================================
*/
// m_parasite.c

import {
  AngleVectors,
  vec3,
  vec3_origin,
  type Vec3,
  VectorLength,
  VectorMA,
  VectorSet,
  VectorSubtract,
} from "../shared/math";
import {
  ATTN_IDLE,
  ATTN_NORM,
  CHAN_AUTO,
  CHAN_VOICE,
  CHAN_WEAPON,
  MASK_SHOT,
  MulticastT,
  TempEventT,
} from "../shared/q_shared";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk, M_CheckAttack } from "./g_ai";
import { T_Damage } from "./g_combat";
import {
  AI_BLOCKED,
  AI_STAND_GROUND,
  DamageT,
  DAMAGE_NO_KNOCKBACK,
  DEAD_DEAD,
  type EdictT,
  g_edicts,
  GIB_ORGANIC,
  gameCvars,
  gi,
  level,
  MOD_UNKNOWN,
  MframeT,
  MmoveT,
  MovetypeT,
  svc_temp_entity,
} from "./g_local";
import { ThrowGib, ThrowHead } from "./g_misc";
import { walkmonster_start } from "./g_monster";
import {
  blocked_checkjump,
  blocked_checkplat,
  blocked_checkshot,
  monster_jump_finished,
  monster_jump_start,
} from "./g_newai";
import { G_FreeEdict, G_ProjectSource, vectoangles } from "./g_utils";
import { type Edict, SolidT, SVF_DEADMONSTER } from "./game";
import {
  FRAME_death101,
  FRAME_death107,
  FRAME_drain01,
  FRAME_drain03,
  FRAME_drain04,
  FRAME_drain18,
  FRAME_jump01,
  FRAME_jump08,
  FRAME_pain101,
  FRAME_pain111,
  FRAME_run01,
  FRAME_run02,
  FRAME_run03,
  FRAME_run09,
  FRAME_run10,
  FRAME_run15,
  FRAME_stand01,
  FRAME_stand17,
  FRAME_stand18,
  FRAME_stand21,
  FRAME_stand22,
  FRAME_stand27,
  FRAME_stand28,
  FRAME_stand35,
  FRAME_break01,
  FRAME_break32,
  MODEL_SCALE,
} from "./m_parasite_frames";

// Per-file local mirroring g_items.ts's own cvarNum (module-local there too,
// so not exported).
function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

// Local struct-literal sugar standing in for C's `{aifunc, dist, thinkfunc}`
// mframe_t initializers.
function mframe(
  aifunc: MframeT["aifunc"],
  dist: number,
  thinkfunc: MframeT["thinkfunc"] = null,
): MframeT {
  const f = new MframeT();
  f.aifunc = aifunc;
  f.dist = dist;
  f.thinkfunc = thinkfunc;
  return f;
}

function mmove(firstframe: number, lastframe: number, frame: MframeT[], endfunc: MmoveT["endfunc"] = null): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.frame = frame;
  m.endfunc = endfunc;
  return m;
}

// Recovers the game-private EdictT from a trace's game-visible `Edict`, per
// PORTING.md's EDICT_NUM idiom (`g_edicts[ent.s.number]`, never a cast); NULL
// falls back to the world edict the same way g_weapon.ts's traceEdict does.
function traceEdict(ent: Edict | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_die = 0;
let sound_launch = 0;
let sound_impact = 0;
let sound_suck = 0;
let sound_reelin = 0;
let sound_sight = 0;
let sound_tap = 0;
let sound_scratch = 0;
let sound_search = 0;

// Forward references below rely on `function` hoisting -- every callback
// referenced inside a move table exists by the time this module finishes
// evaluating, regardless of textual order.

function parasite_launch(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_launch, 1, ATTN_NORM, 0);
}

function parasite_reel_in(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_reelin, 1, ATTN_NORM, 0);
}

function parasite_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_sight, 1, ATTN_NORM, 0);
}

function parasite_tap(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_tap, 1, ATTN_IDLE, 0);
}

function parasite_scratch(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_scratch, 1, ATTN_IDLE, 0);
}

function parasite_search(_self: EdictT): void {
  // C: `gi.sound (self, CHAN_WEAPON, sound_search, 1, ATTN_IDLE, 0);` --
  // never assigned to monsterinfo.search in SP_monster_parasite, so it is
  // dead code in the original too; kept for fidelity, unreferenced.
}

const parasite_frames_start_fidget: MframeT[] = [
  mframe(ai_stand, 0),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0),
];
const parasite_move_start_fidget = mmove(FRAME_stand18, FRAME_stand21, parasite_frames_start_fidget, parasite_do_fidget);

const parasite_frames_fidget: MframeT[] = [
  mframe(ai_stand, 0, parasite_scratch),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0, parasite_scratch),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0),
];
const parasite_move_fidget = mmove(FRAME_stand22, FRAME_stand27, parasite_frames_fidget, parasite_refidget);

const parasite_frames_end_fidget: MframeT[] = [
  mframe(ai_stand, 0, parasite_scratch),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0),
];
const parasite_move_end_fidget = mmove(FRAME_stand28, FRAME_stand35, parasite_frames_end_fidget, parasite_stand);

function parasite_end_fidget(self: EdictT): void {
  self.monsterinfo.currentmove = parasite_move_end_fidget;
}

function parasite_do_fidget(self: EdictT): void {
  self.monsterinfo.currentmove = parasite_move_fidget;
}

function parasite_refidget(self: EdictT): void {
  // C: `if (random() <= 0.8)` -- Quake's own random(), not raw rand().
  if (Math.random() <= 0.8) self.monsterinfo.currentmove = parasite_move_fidget;
  else self.monsterinfo.currentmove = parasite_move_end_fidget;
}

function parasite_idle(self: EdictT): void {
  self.monsterinfo.currentmove = parasite_move_start_fidget;
}

const parasite_frames_stand: MframeT[] = [
  mframe(ai_stand, 0),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0, parasite_tap),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0, parasite_tap),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0, parasite_tap),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0, parasite_tap),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0, parasite_tap),
  mframe(ai_stand, 0),
  mframe(ai_stand, 0, parasite_tap),
];
const parasite_move_stand = mmove(FRAME_stand01, FRAME_stand17, parasite_frames_stand, parasite_stand);

function parasite_stand(self: EdictT): void {
  self.monsterinfo.currentmove = parasite_move_stand;
}

const parasite_frames_run: MframeT[] = [
  mframe(ai_run, 30),
  mframe(ai_run, 30),
  mframe(ai_run, 22),
  mframe(ai_run, 19),
  mframe(ai_run, 24),
  mframe(ai_run, 28),
  mframe(ai_run, 25),
];
const parasite_move_run = mmove(FRAME_run03, FRAME_run09, parasite_frames_run, null);

const parasite_frames_start_run: MframeT[] = [mframe(ai_run, 0), mframe(ai_run, 30)];
const parasite_move_start_run = mmove(FRAME_run01, FRAME_run02, parasite_frames_start_run, parasite_run);

const parasite_frames_stop_run: MframeT[] = [
  mframe(ai_run, 20),
  mframe(ai_run, 20),
  mframe(ai_run, 12),
  mframe(ai_run, 10),
  mframe(ai_run, 0),
  mframe(ai_run, 0),
];
const parasite_move_stop_run = mmove(FRAME_run10, FRAME_run15, parasite_frames_stop_run, null);

function parasite_start_run(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = parasite_move_stand;
  else self.monsterinfo.currentmove = parasite_move_start_run;
}

function parasite_run(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = parasite_move_stand;
  else self.monsterinfo.currentmove = parasite_move_run;
}

const parasite_frames_walk: MframeT[] = [
  mframe(ai_walk, 30),
  mframe(ai_walk, 30),
  mframe(ai_walk, 22),
  mframe(ai_walk, 19),
  mframe(ai_walk, 24),
  mframe(ai_walk, 28),
  mframe(ai_walk, 25),
];
const parasite_move_walk = mmove(FRAME_run03, FRAME_run09, parasite_frames_walk, parasite_walk);

const parasite_frames_start_walk: MframeT[] = [mframe(ai_walk, 0), mframe(ai_walk, 30, parasite_walk)];
const parasite_move_start_walk = mmove(FRAME_run01, FRAME_run02, parasite_frames_start_walk, null);

const parasite_frames_stop_walk: MframeT[] = [
  mframe(ai_walk, 20),
  mframe(ai_walk, 20),
  mframe(ai_walk, 12),
  mframe(ai_walk, 10),
  mframe(ai_walk, 0),
  mframe(ai_walk, 0),
];
const parasite_move_stop_walk = mmove(FRAME_run10, FRAME_run15, parasite_frames_stop_walk, null);

function parasite_start_walk(self: EdictT): void {
  self.monsterinfo.currentmove = parasite_move_start_walk;
}

function parasite_walk(self: EdictT): void {
  self.monsterinfo.currentmove = parasite_move_walk;
}

const parasite_frames_pain1: MframeT[] = [
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 6),
  mframe(ai_move, 16),
  mframe(ai_move, -6),
  mframe(ai_move, -7),
  mframe(ai_move, 0),
];
const parasite_move_pain1 = mmove(FRAME_pain101, FRAME_pain111, parasite_frames_pain1, parasite_start_run);

function parasite_pain(self: EdictT, _other: EdictT, _kick: number, _damage: number): void {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 3;

  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  // C: `if (random() < 0.5)` -- Quake's own random(), a plain [0,1) draw.
  if (Math.random() < 0.5) gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);

  self.monsterinfo.currentmove = parasite_move_pain1;
}

// Exported (unlike the base port's module-private version): rogue's
// g_newai.c drops `static` from this function (m_parasite.c:280-281) and
// blocked_checkshot's monster_parasite special case (g_newai.c:31,62-68)
// calls straight into it, so src/rogue/g_newai.ts needs it importable from
// here.
export function parasite_drain_attack_ok(start: Vec3, end: Vec3): boolean {
  const dir = vec3();
  const angles = vec3();

  // check for max distance
  VectorSubtract(start, end, dir);
  if (VectorLength(dir) > 256) return false;

  // check for min/max pitch
  vectoangles(dir, angles);
  if (angles[0] < -180) angles[0] += 360;
  if (Math.abs(angles[0]) > 30) return false;

  return true;
}

function parasite_drain_attack(self: EdictT): void {
  const enemy = self.enemy;
  if (enemy === null) {
    throw new Error("parasite_drain_attack: self.enemy is null (C dereferences self->enemy unconditionally)");
  }

  const offset = vec3(24, 0, 6);
  const start = vec3();
  const f = vec3();
  const r = vec3();
  let end = vec3();

  AngleVectors(self.s.angles, f, r, null);
  G_ProjectSource(self.s.origin, offset, f, r, start);

  end = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2]);
  if (!parasite_drain_attack_ok(start, end)) {
    end[2] = enemy.s.origin[2] + enemy.maxs[2] - 8;
    if (!parasite_drain_attack_ok(start, end)) {
      end[2] = enemy.s.origin[2] + enemy.mins[2] + 8;
      if (!parasite_drain_attack_ok(start, end)) return;
    }
  }
  end = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2]);

  const tr = gi.trace(start, null, null, end, self, MASK_SHOT);
  if (traceEdict(tr.ent) !== enemy) return;

  let damage: number;
  if (self.s.frame === FRAME_drain03) {
    damage = 5;
    gi.sound(enemy, CHAN_AUTO, sound_impact, 1, ATTN_NORM, 0);
  } else {
    if (self.s.frame === FRAME_drain04) gi.sound(self, CHAN_WEAPON, sound_suck, 1, ATTN_NORM, 0);
    damage = 2;
  }

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_PARASITE_ATTACK);
  gi.WriteShort(self.s.number);
  gi.WritePosition(start);
  gi.WritePosition(end);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);

  const dir = vec3();
  VectorSubtract(start, end, dir);
  T_Damage(enemy, self, self, dir, enemy.s.origin, vec3_origin, damage, 0, DAMAGE_NO_KNOCKBACK, MOD_UNKNOWN);
}

const parasite_frames_drain: MframeT[] = [
  mframe(ai_charge, 0, parasite_launch),
  mframe(ai_charge, 0),
  mframe(ai_charge, 15, parasite_drain_attack), // Target hits
  mframe(ai_charge, 0, parasite_drain_attack), // drain
  mframe(ai_charge, 0, parasite_drain_attack), // drain
  mframe(ai_charge, 0, parasite_drain_attack), // drain
  mframe(ai_charge, 0, parasite_drain_attack), // drain
  mframe(ai_charge, -2, parasite_drain_attack), // drain
  mframe(ai_charge, -2, parasite_drain_attack), // drain
  mframe(ai_charge, -3, parasite_drain_attack), // drain
  mframe(ai_charge, -2, parasite_drain_attack), // drain
  mframe(ai_charge, 0, parasite_drain_attack), // drain
  mframe(ai_charge, -1, parasite_drain_attack), // drain
  mframe(ai_charge, 0, parasite_reel_in), // let go
  mframe(ai_charge, -2),
  mframe(ai_charge, -2),
  mframe(ai_charge, -3),
  mframe(ai_charge, 0),
];
const parasite_move_drain = mmove(FRAME_drain01, FRAME_drain18, parasite_frames_drain, parasite_start_run);

const parasite_frames_break: MframeT[] = [
  mframe(ai_charge, 0),
  mframe(ai_charge, -3),
  mframe(ai_charge, 1),
  mframe(ai_charge, 2),
  mframe(ai_charge, -3),
  mframe(ai_charge, 1),
  mframe(ai_charge, 1),
  mframe(ai_charge, 3),
  mframe(ai_charge, 0),
  mframe(ai_charge, -18),
  mframe(ai_charge, 3),
  mframe(ai_charge, 9),
  mframe(ai_charge, 6),
  mframe(ai_charge, 0),
  mframe(ai_charge, -18),
  mframe(ai_charge, 0),
  mframe(ai_charge, 8),
  mframe(ai_charge, 9),
  mframe(ai_charge, 0),
  mframe(ai_charge, -18),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0), // airborne
  mframe(ai_charge, 0), // airborne
  mframe(ai_charge, 0), // slides
  mframe(ai_charge, 0), // slides
  mframe(ai_charge, 0), // slides
  mframe(ai_charge, 0), // slides
  mframe(ai_charge, 4),
  mframe(ai_charge, 11),
  mframe(ai_charge, -2),
  mframe(ai_charge, -5),
  mframe(ai_charge, 1),
];
const parasite_move_break = mmove(FRAME_break01, FRAME_break32, parasite_frames_break, parasite_start_run);

/*
===
Break Stuff Ends
===
*/

function parasite_attack(self: EdictT): void {
  // C: the `random() <= 0.2` branch to parasite_move_break is commented out
  // in the original source; the drain attack is the only reachable move.
  self.monsterinfo.currentmove = parasite_move_drain;
}

//================
// ROGUE
const parasite_frames_jump_up: MframeT[] = [
  mframe(ai_move, -8),
  mframe(ai_move, -8),
  mframe(ai_move, -8),
  mframe(ai_move, -8, parasite_jump_up),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0, parasite_jump_wait_land),
  mframe(ai_move, 0),
];
const parasite_move_jump_up = mmove(FRAME_jump01, FRAME_jump08, parasite_frames_jump_up, parasite_run);

const parasite_frames_jump_down: MframeT[] = [
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0, parasite_jump_down),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0, parasite_jump_wait_land),
  mframe(ai_move, 0),
];
const parasite_move_jump_down = mmove(FRAME_jump01, FRAME_jump08, parasite_frames_jump_down, parasite_run);

function parasite_jump_down(self: EdictT): void {
  const forward = vec3();
  const up = vec3();

  monster_jump_start(self);

  AngleVectors(self.s.angles, forward, null, up);
  VectorMA(self.velocity, 100, forward, self.velocity);
  VectorMA(self.velocity, 300, up, self.velocity);
}

function parasite_jump_up(self: EdictT): void {
  const forward = vec3();
  const up = vec3();

  monster_jump_start(self);

  AngleVectors(self.s.angles, forward, null, up);
  VectorMA(self.velocity, 200, forward, self.velocity);
  VectorMA(self.velocity, 450, up, self.velocity);
}

function parasite_jump_wait_land(self: EdictT): void {
  if (self.groundentity === null) {
    self.monsterinfo.nextframe = self.s.frame;

    if (monster_jump_finished(self)) self.monsterinfo.nextframe = self.s.frame + 1;
  } else {
    self.monsterinfo.nextframe = self.s.frame + 1;
  }
}

function parasite_jump(self: EdictT): void {
  if (!self.enemy) return;

  if (self.enemy.s.origin[2] > self.s.origin[2]) self.monsterinfo.currentmove = parasite_move_jump_up;
  else self.monsterinfo.currentmove = parasite_move_jump_down;
}

/*
===
Blocked
===
*/
function parasite_blocked(self: EdictT, dist: number): boolean {
  if (blocked_checkshot(self, 0.25 + 0.05 * cvarNum(gameCvars.skill))) return true;

  if (blocked_checkjump(self, dist, 256, 68)) {
    parasite_jump(self);
    return true;
  }

  if (blocked_checkplat(self, dist)) return true;

  // C falls off the end here with no return statement -- see the header
  // comment's "Deviations" section (m_parasite.c:505-518).
  return false;
}
// ROGUE
//================

function parasite_checkattack(self: EdictT): boolean {
  const retval = M_CheckAttack(self);

  if (!retval) return false;

  const enemy = self.enemy;
  if (enemy === null) {
    throw new Error("parasite_checkattack: self.enemy is null (C dereferences self->enemy unconditionally)");
  }

  const f = vec3();
  const r = vec3();
  const offset = vec3(24, 0, 6);
  const start = vec3();
  let end = vec3();

  AngleVectors(self.s.angles, f, r, null);
  G_ProjectSource(self.s.origin, offset, f, r, start);

  end = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2]);
  if (!parasite_drain_attack_ok(start, end)) {
    end[2] = enemy.s.origin[2] + enemy.maxs[2] - 8;
    if (!parasite_drain_attack_ok(start, end)) {
      end[2] = enemy.s.origin[2] + enemy.mins[2] + 8;
      if (!parasite_drain_attack_ok(start, end)) return false;
    }
  }
  end = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2]);

  const tr = gi.trace(start, null, null, end, self, MASK_SHOT);
  if (traceEdict(tr.ent) !== enemy) {
    self.monsterinfo.aiflags |= AI_BLOCKED;

    if (self.monsterinfo.attack) self.monsterinfo.attack(self);

    self.monsterinfo.aiflags &= ~AI_BLOCKED;
    return true;
  }

  // C falls off the end here with no return statement when the shot IS
  // clear -- see the header comment's "Deviations" section
  // (m_parasite.c:523-562).
  return true;
}

/*
===
Death Stuff Starts
===
*/

function parasite_dead(self: EdictT): void {
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, -8);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

const parasite_frames_death: MframeT[] = [
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
];
const parasite_move_death = mmove(FRAME_death101, FRAME_death107, parasite_frames_death, parasite_dead);

function parasite_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3): void {
  // check for gib
  if (self.health <= self.gib_health) {
    gi.sound(self, CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
    for (let n = 0; n < 2; n++) ThrowGib(self, "models/objects/gibs/bone/tris.md2", damage, GIB_ORGANIC);
    for (let n = 0; n < 4; n++) ThrowGib(self, "models/objects/gibs/sm_meat/tris.md2", damage, GIB_ORGANIC);
    ThrowHead(self, "models/objects/gibs/head2/tris.md2", damage, GIB_ORGANIC);
    self.deadflag = DEAD_DEAD;
    return;
  }

  if (self.deadflag === DEAD_DEAD) return;

  // regular death
  gi.sound(self, CHAN_VOICE, sound_die, 1, ATTN_NORM, 0);
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_YES;
  self.monsterinfo.currentmove = parasite_move_death;
}

/*
===
End Death Stuff
===
*/

/*QUAKED monster_parasite (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
*/
export function SP_monster_parasite(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  sound_pain1 = gi.soundindex("parasite/parpain1.wav");
  sound_pain2 = gi.soundindex("parasite/parpain2.wav");
  sound_die = gi.soundindex("parasite/pardeth1.wav");
  sound_launch = gi.soundindex("parasite/paratck1.wav");
  sound_impact = gi.soundindex("parasite/paratck2.wav");
  sound_suck = gi.soundindex("parasite/paratck3.wav");
  sound_reelin = gi.soundindex("parasite/paratck4.wav");
  sound_sight = gi.soundindex("parasite/parsght1.wav");
  sound_tap = gi.soundindex("parasite/paridle1.wav");
  sound_scratch = gi.soundindex("parasite/paridle2.wav");
  sound_search = gi.soundindex("parasite/parsrch1.wav");

  self.s.modelindex = gi.modelindex("models/monsters/parasite/tris.md2");
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, 24);
  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;

  self.health = 175;
  self.gib_health = -50;
  self.mass = 250;

  self.pain = parasite_pain;
  self.die = parasite_die;

  self.monsterinfo.stand = parasite_stand;
  self.monsterinfo.walk = parasite_start_walk;
  self.monsterinfo.run = parasite_start_run;
  self.monsterinfo.attack = parasite_attack;
  self.monsterinfo.sight = parasite_sight;
  self.monsterinfo.idle = parasite_idle;
  self.monsterinfo.blocked = parasite_blocked; // PGM
  self.monsterinfo.checkattack = parasite_checkattack;

  gi.linkentity(self);

  self.monsterinfo.currentmove = parasite_move_stand;
  self.monsterinfo.scale = MODEL_SCALE;

  walkmonster_start(self);
}

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- so a save containing an entity that
// references one of these callbacks or move tables restores a real
// think/touch/use/pain/die/blocked function or monsterinfo.currentmove
// object instead of null (see g_save.ts's registerSaveFunction/
// registerSaveMmove name registry).
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("m_parasite:parasite_pain", parasite_pain);
registerSaveFunction("m_parasite:parasite_die", parasite_die);
registerSaveFunction("m_parasite:parasite_stand", parasite_stand);
registerSaveFunction("m_parasite:parasite_start_walk", parasite_start_walk);
registerSaveFunction("m_parasite:parasite_start_run", parasite_start_run);
registerSaveFunction("m_parasite:parasite_attack", parasite_attack);
registerSaveFunction("m_parasite:parasite_sight", parasite_sight);
registerSaveFunction("m_parasite:parasite_idle", parasite_idle);
registerSaveFunction("m_parasite:parasite_blocked", parasite_blocked);
registerSaveFunction("m_parasite:parasite_checkattack", parasite_checkattack);
registerSaveMmove("m_parasite:parasite_move_start_fidget", parasite_move_start_fidget);
registerSaveMmove("m_parasite:parasite_move_fidget", parasite_move_fidget);
registerSaveMmove("m_parasite:parasite_move_end_fidget", parasite_move_end_fidget);
registerSaveMmove("m_parasite:parasite_move_stand", parasite_move_stand);
registerSaveMmove("m_parasite:parasite_move_run", parasite_move_run);
registerSaveMmove("m_parasite:parasite_move_start_run", parasite_move_start_run);
registerSaveMmove("m_parasite:parasite_move_stop_run", parasite_move_stop_run);
registerSaveMmove("m_parasite:parasite_move_walk", parasite_move_walk);
registerSaveMmove("m_parasite:parasite_move_start_walk", parasite_move_start_walk);
registerSaveMmove("m_parasite:parasite_move_stop_walk", parasite_move_stop_walk);
registerSaveMmove("m_parasite:parasite_move_pain1", parasite_move_pain1);
registerSaveMmove("m_parasite:parasite_move_drain", parasite_move_drain);
registerSaveMmove("m_parasite:parasite_move_break", parasite_move_break);
registerSaveMmove("m_parasite:parasite_move_death", parasite_move_death);
registerSaveMmove("m_parasite:parasite_move_jump_up", parasite_move_jump_up);
registerSaveMmove("m_parasite:parasite_move_jump_down", parasite_move_jump_down);
