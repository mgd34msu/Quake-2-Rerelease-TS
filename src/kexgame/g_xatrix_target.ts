// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_xatrix_target.cpp -- xatrix (Ground Zero mission pack) `target_mal_laser`
// (Mal's scripted laser, a self-cycling variant of the base game's
// `target_laser`). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/xatrix/g_xatrix_target.cpp (99
// lines, C++17). Behavioral code, ported bug-for-bug per PORTING.md.
//
// Reuses g_target.ts's own real, exported `target_laser_off`/
// `target_laser_think` verbatim (the C++ does the same:
// `target_mal_laser_on` calls `target_laser_think`-adjacent state directly,
// and `target_mal_laser_use`'s "off" branch calls the SAME
// `target_laser_off` the base `target_laser` entity uses). The
// SPAWNFLAG_LASER_* family is declared LOCALLY here (not imported), matching
// g_target.ts's own file-local, unexported declaration of the identical
// constants -- see this port line's established "duplicate a small
// unexported helper/constant per file" convention (g_guncmdr.ts's
// `blocked_checkplat` precedent is the canonical citation for this).

import { vec3 } from "../shared/math";
import { RenderfxT, SolidT, SvflagsT, MODELINDEX_WORLD } from "../kexapi/game";
import { type EdictT, type ThinkFn, type UseFn, EntFlagsT, MovetypeT } from "./g_local";
import { RegisterThink, RegisterUse } from "./g_save_registry";
import { gi, level } from "./g_main_globals";
import { Gtime_add, Gtime_from_sec, Gtime_from_ms } from "./gtime";
import { G_SetMovedir } from "./g_utils";
import { SpawnFlags_from, SpawnFlags_has, SpawnFlags_or, type SpawnFlags } from "./spawnflags";
import { target_laser_off, target_laser_think } from "./g_target";

// ---------------------------------------------------------------------------
// SPAWNFLAG_LASER_* -- duplicated locally, see file header
// ---------------------------------------------------------------------------

const SPAWNFLAG_LASER_ON: SpawnFlags = SpawnFlags_from(0x0001);
const SPAWNFLAG_LASER_RED: SpawnFlags = SpawnFlags_from(0x0002);
const SPAWNFLAG_LASER_GREEN: SpawnFlags = SpawnFlags_from(0x0004);
const SPAWNFLAG_LASER_BLUE: SpawnFlags = SpawnFlags_from(0x0008);
const SPAWNFLAG_LASER_YELLOW: SpawnFlags = SpawnFlags_from(0x0010);
const SPAWNFLAG_LASER_ORANGE: SpawnFlags = SpawnFlags_from(0x0020);
const SPAWNFLAG_LASER_FAT: SpawnFlags = SpawnFlags_from(0x0040);
const SPAWNFLAG_LASER_ZAP: SpawnFlags = SpawnFlags_from(0x80000000);

// ---------------------------------------------------------------------------
// target_mal_laser (g_xatrix_target.cpp:6-99)
// ---------------------------------------------------------------------------

/** `void target_mal_laser_on(edict_t *self)` (g_xatrix_target.cpp:9-18). */
function target_mal_laser_on(self: EdictT): void {
  if (self.activator === null) self.activator = self;
  self.spawnflags = SpawnFlags_from(self.spawnflags | SPAWNFLAG_LASER_ZAP | SPAWNFLAG_LASER_ON);
  self.svflags &= ~SvflagsT.SVF_NOCLIENT;
  self.flags |= EntFlagsT.FL_TRAP;
  // target_laser_think(self); -- commented out in the shipped source, preserved
  self.nextthink = Gtime_add(level.time, Gtime_from_sec(self.wait + self.delay));
}

/** `USE(target_mal_laser_use)` (g_xatrix_target.cpp:20-27). */
const target_mal_laser_use: UseFn = RegisterUse("target_mal_laser_use", (self: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
  self.activator = activator;
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_LASER_ON)) target_laser_off(self);
  else target_mal_laser_on(self);
});

/** `THINK(mal_laser_think2)` (g_xatrix_target.cpp:31-37). */
const mal_laser_think2: ThinkFn = RegisterThink("mal_laser_think2", (self: EdictT): void => {
  self.svflags |= SvflagsT.SVF_NOCLIENT;
  self.think = mal_laser_think;
  self.nextthink = Gtime_add(level.time, Gtime_from_sec(self.wait));
  self.spawnflags = SpawnFlags_from(self.spawnflags | SPAWNFLAG_LASER_ZAP);
});

/** `THINK(mal_laser_think)` (g_xatrix_target.cpp:39-45). Mutually recursive
 *  with `mal_laser_think2` above: `mal_laser_think2`'s closure reads
 *  `mal_laser_think` (declared below it), but only at CALL time, once the
 *  module has fully finished loading -- no TDZ hazard, matching
 *  g_misc.ts's/g_func.ts's own identical cross-`const` mutual-reference
 *  precedent for `train_use`/`func_train_find`. */
const mal_laser_think: ThinkFn = RegisterThink("mal_laser_think", (self: EdictT): void => {
  self.svflags &= ~SvflagsT.SVF_NOCLIENT;
  target_laser_think(self);
  self.think = mal_laser_think2;
  self.nextthink = Gtime_add(level.time, Gtime_from_ms(100));
});

/**
 * QUAKED target_mal_laser (1 0 0) (-4 -4 -4) (4 4 4) START_ON RED GREEN BLUE
 * YELLOW ORANGE FAT
 * `void SP_target_mal_laser(edict_t *self)` (g_xatrix_target.cpp:47-98).
 */
export function SP_target_mal_laser(self: EdictT): void {
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.solid = SolidT.SOLID_NOT;
  self.s.renderfx |= RenderfxT.RF_BEAM;
  self.s.modelindex = MODELINDEX_WORLD; // must be non-zero
  self.flags |= EntFlagsT.FL_TRAP_LASER_FIELD;

  // set the beam diameter
  self.s.frame = SpawnFlags_has(self.spawnflags, SPAWNFLAG_LASER_FAT) ? 16 : 4;

  // set the color
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_LASER_RED)) self.s.skinnum = 0xf2f2f0f0;
  else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_LASER_GREEN)) self.s.skinnum = 0xd0d1d2d3;
  else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_LASER_BLUE)) self.s.skinnum = 0xf3f3f1f1;
  else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_LASER_YELLOW)) self.s.skinnum = 0xdcdddedf;
  else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_LASER_ORANGE)) self.s.skinnum = 0xe0e1e2e3;

  G_SetMovedir(self.s.angles, self.movedir);

  if (!self.delay) self.delay = 0.1;
  if (!self.wait) self.wait = 0.1;
  if (!self.dmg) self.dmg = 5;

  self.mins = vec3(-8, -8, -8);
  self.maxs = vec3(8, 8, 8);

  self.nextthink = Gtime_add(level.time, Gtime_from_sec(self.delay));
  self.think = mal_laser_think;

  self.use = target_mal_laser_use;

  gi.linkentity(self);

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_LASER_ON)) target_mal_laser_on(self);
  else target_laser_off(self);
}
