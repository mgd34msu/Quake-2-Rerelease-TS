// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_rogue_utils.c -- the ROGUE mission pack's `findradius2` (2023 Quake II
// re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/rogue/g_rogue_utils.cpp
// (47 lines, C++17) in full. One function: `findradius2`, a `findradius`
// variant tuned for the tesla-zap-area code path (g_rogue_newweap.cpp) --
// unlike `findradius` (g_utils.ts), it additionally requires `takedamage`
// and `FL_DAMAGEABLE`, so it only ever returns entities that can actually be
// hurt by the caller's follow-up `T_Damage`.
//
// Mirrors g_utils.ts's own `findradius` idiom exactly (iteration by index
// from `g_edicts.indexOf(from) + 1` rather than raw pointer arithmetic,
// `vec3()` scratch for the per-axis center-distance computation).

import { vec3, type Vec3 } from "../../shared/math";
import { vec3_length } from "../q_vec3";
import { type EdictT, EntFlagsT } from "../g_local";
import { SolidT } from "../../kexapi/game";
import { g_edicts, globals } from "../g_main_globals";

/**
 * rogue/g_rogue_utils.cpp:19-47 `edict_t *findradius2(edict_t *from, const
 * vec3_t &org, float rad)`. Only returns entities that are `takedamage` and
 * `FL_DAMAGEABLE` (a `findradius` narrowing for tesla-style area damage).
 */
export function findradius2(from: EdictT | null, org: Vec3, rad: number): EdictT | null {
  const start = from === null ? 0 : g_edicts.indexOf(from) + 1;
  const eorg = vec3();

  for (let i = start; i < globals.num_edicts; i++) {
    const candidate = g_edicts[i];
    if (candidate === undefined || !candidate.inuse) continue;
    if (candidate.solid === SolidT.SOLID_NOT) continue;
    if (!candidate.takedamage) continue;
    if ((candidate.flags & EntFlagsT.FL_DAMAGEABLE) === 0n) continue;
    for (let j = 0; j < 3; j++) {
      eorg[j] = org[j] - (candidate.s.origin[j] + (candidate.mins[j] + candidate.maxs[j]) * 0.5);
    }
    if (vec3_length(eorg) > rad) continue;
    return candidate;
  }

  return null;
}
