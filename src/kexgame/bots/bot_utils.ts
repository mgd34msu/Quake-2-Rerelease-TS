// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// bot_utils.cpp (529 lines, 2023 Quake II re-release / "KEX" engine), ported
// from ~/Projects/quake2-rerelease-dll/rerelease/bots/bot_utils.cpp: the
// PORTION of that file not already covered by src/kexgame/g_main.ts.
//
// ============================================================================
// SCOPE -- what g_main.ts already took, what lands here
// ============================================================================
// g_main.ts's own file header ("Entity_UpdateState family -- REAL port,
// despite living in bots/bot_utils.cpp") documents that
// Player_UpdateState/Monster_UpdateState/Item_UpdateState/Trap_UpdateState/
// Edict_UpdateState/Entity_UpdateState (bot_utils.cpp:1-380) already landed
// there, because G_RunFrame_ calls Entity_UpdateState unconditionally every
// frame -- a call site squarely inside that unit's own scope. This file is
// the rest of bot_utils.cpp (lines 382-529): `info_nav_lock_use`/
// `SP_info_nav_lock` (the one remaining registered stub in g_spawn.ts's
// spawn table -- see that file's own updated header) and the four debug/AI
// query helpers `FindLocalPlayer`/`FindFirstBot`/`FindFirstMonster`/
// `FindActorUnderCrosshair`, consumed by bot_debug.ts (this same directory).
// RULING: this unit's brief asked whether to move the Entity_UpdateState
// family here (their true C++ file-location home) now that this directory
// exists -- NOT moved; see g_main.ts's own updated header for the full
// evidence (short version: their only call site is G_RunFrame_, inside
// g_main.ts, and nothing in this directory needs to call them).
//
// ============================================================================
// edictFmt -- local copy of fmt::formatter<edict_t>, not shared
// ============================================================================
// g_local.h:3534-3549's `fmt::formatter<edict_t>` ("{}" prints "classname @
// midpoint-or-origin") backs every `gi.Com_PrintFmt("{} ...", *self)` call
// in this file. Per this port line's established convention (g_misc.ts/
// g_items.ts/g_func.ts/m_actor.ts each carry their OWN unexported copy
// rather than sharing one -- see those files' own headers), this file keeps
// its own local `edictFmt`. m_actor.ts's identical two-and-one-edict
// `Com_Print` call shapes (`"{}: bad target {}\n"` / `"{}: no targetname\n"`)
// are the closest analog and are followed exactly here.
//
// ============================================================================
// FindLocalPlayer / FindFirstBot / FindFirstMonster / FindActorUnderCrosshair
// ============================================================================
// Pure `g_edicts[0..globals.num_edicts)` linear scans (or, for
// FindActorUnderCrosshair, a single `gi.trace` cast from the given player's
// eye position) -- ported verbatim, no deviations. Each returns
// `EdictT | null` (this port's `null` for C++'s `nullptr`), not `KexEdictT`,
// since these are internal bots/-subsystem helpers with no KexGameExports
// slot of their own -- callers needing the engine-facing shape resolve it
// themselves at whatever export boundary they sit behind (see bot_debug.ts).
//
// ============================================================================
// DEVIATIONS
// ============================================================================
// - `gi.traceline(start, end, passent, mask)` (a convenience wrapper the
//   real kex `game_import_t` exposes): this port's `gi` only has the full
//   `gi.trace(start, mins, maxs, end, passent, mask)` -- ported as a local
//   `giTraceline(start, end, passent, mask)` helper calling
//   `gi.trace(start, null, null, end, passent, mask)`, the exact precedent
//   g_monster.ts's own `giTraceline` already established.

import { vec3, type Vec3 } from "../../shared/math";
import { type KexTraceT, SvflagsT, ContentsT, MASK_PROJECTILE } from "../../kexapi/game";
import { type EdictT, type UseFn, EntFlagsT } from "../g_local";
import { gi, globals, g_edicts } from "../g_main_globals";
import { G_FreeEdict, G_FindByString } from "../g_utils";
import { AngleVectors, vec3_add, vec3_muls } from "../q_vec3";

// ---------------------------------------------------------------------------
// edictFmt -- see file header
// ---------------------------------------------------------------------------

function edictFmt(ent: EdictT): string {
  const p = ent.linked ? vec3_muls(vec3_add(ent.absmax, ent.absmin), 0.5) : ent.s.origin;
  return `${ent.classname} @ (${p[0]} ${p[1]} ${p[2]})`;
}

// ---------------------------------------------------------------------------
// giTraceline -- see file header
// ---------------------------------------------------------------------------

function giTraceline(start: Vec3, end: Vec3, passent: EdictT | null, mask: ContentsT): KexTraceT {
  return gi.trace(start, null, null, end, passent, mask);
}

// ---------------------------------------------------------------------------
// info_nav_lock -- bot_utils.cpp:382-413
// ---------------------------------------------------------------------------

/** bot_utils.cpp:382-393: `USE(info_nav_lock_use)(edict_t*, edict_t*, edict_t*)`. */
const info_nav_lock_use: UseFn = (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  let n: EdictT | null = null;

  while ((n = G_FindByString(n, "targetname", self.target ?? "")) !== null) {
    if ((n.svflags & SvflagsT.SVF_DOOR) === 0) {
      gi.Com_Print(`${edictFmt(self)} tried targeting ${edictFmt(n)}, a non-SVF_DOOR\n`);
      continue;
    }

    n.flags ^= EntFlagsT.FL_LOCKED;
  }
};

/**
 * bot_utils.cpp:395-413:
 * `/*QUAKED info_nav_lock (1.0 1.0 0.0) (-16 -16 0) (16 16 32)
 * toggle locked state on linked entity `.
 */
export function SP_info_nav_lock(self: EdictT): void {
  if (self.targetname === null) {
    gi.Com_Print(`${edictFmt(self)} missing targetname\n`);
    G_FreeEdict(self);
    return;
  }

  if (self.target === null) {
    gi.Com_Print(`${edictFmt(self)} missing target\n`);
    G_FreeEdict(self);
    return;
  }

  self.svflags |= SvflagsT.SVF_NOCLIENT;
  self.use = info_nav_lock_use;
}

// ---------------------------------------------------------------------------
// debug/AI query helpers -- bot_utils.cpp:415-529
// ---------------------------------------------------------------------------

/** bot_utils.cpp:420-438: `const edict_t * FindLocalPlayer()`. */
export function FindLocalPlayer(): EdictT | null {
  let localPlayer: EdictT | null = null;

  for (let i = 0; i < globals.num_edicts; i++) {
    const ent = g_edicts[i];
    if (!ent.inuse || (ent.svflags & SvflagsT.SVF_PLAYER) === 0) continue;
    if (ent.health <= 0) continue;

    localPlayer = ent;
    break;
  }

  return localPlayer;
}

/** bot_utils.cpp:440-467: `const edict_t * FindFirstBot()`. */
export function FindFirstBot(): EdictT | null {
  let firstBot: EdictT | null = null;

  for (let i = 0; i < globals.num_edicts; i++) {
    const ent = g_edicts[i];
    if (!ent.inuse || (ent.svflags & SvflagsT.SVF_PLAYER) === 0) continue;
    if (ent.health <= 0) continue;
    if ((ent.svflags & SvflagsT.SVF_BOT) === 0) continue;

    firstBot = ent;
    break;
  }

  return firstBot;
}

/** bot_utils.cpp:469-492: `const edict_t * FindFirstMonster()`. */
export function FindFirstMonster(): EdictT | null {
  let firstMonster: EdictT | null = null;

  for (let i = 0; i < globals.num_edicts; i++) {
    const ent = g_edicts[i];
    if (!ent.inuse || (ent.svflags & SvflagsT.SVF_MONSTER) === 0) continue;
    if (ent.health <= 0) continue;

    firstMonster = ent;
    break;
  }

  return firstMonster;
}

/**
 * bot_utils.cpp:494-529: `const edict_t * FindActorUnderCrosshair(const
 * edict_t * player)`. "Actors" are either players or monsters -- i.e.
 * something alive and thinking.
 */
export function FindActorUnderCrosshair(player: EdictT | null): EdictT | null {
  if (player === null || !player.inuse) return null;
  if (player.client === null) throw new Error("FindActorUnderCrosshair: player.client is null (invariant violated)");

  const forward = vec3();
  AngleVectors(player.client.v_angle, forward, null, null);

  const eye_position = vec3_add(player.s.origin, vec3(0, 0, player.viewheight));
  const end = vec3_add(eye_position, vec3_muls(forward, 8192.0));
  const mask: ContentsT = MASK_PROJECTILE & ~ContentsT.CONTENTS_DEADMONSTER;

  const tr = giTraceline(eye_position, end, player, mask);

  if (tr.ent === null) return null;
  const traceEnt = g_edicts[tr.ent.s.number];
  if (traceEnt === undefined || !traceEnt.inuse) return null;

  if ((traceEnt.svflags & SvflagsT.SVF_PLAYER) === 0 && (traceEnt.svflags & SvflagsT.SVF_MONSTER) === 0) return null;

  if (traceEnt.health <= 0) return null;

  return traceEnt;
}
