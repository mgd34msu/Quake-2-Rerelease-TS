// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_xatrix_monster.cpp -- xatrix (Ground Zero mission pack) monster-facing
// weapon wrappers. Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/xatrix/g_xatrix_monster.cpp (142
// lines, C++17): monster_fire_blueblaster, monster_fire_ionripper,
// monster_fire_heat, the dabeam_pierce_t piercing struct, dabeam_update,
// beam_think, and monster_fire_dabeam. Behavioral code, ported bug-for-bug
// per PORTING.md.
//
// ============================================================================
// monster_fire_heat -- RE-EXPORTED from m_supertank.ts, not redefined here
// ============================================================================
// This file's real C++ source (g_xatrix_monster.cpp:21-25) defines
// `monster_fire_heat` as a two-line wrapper (`fire_heat(...);
// monster_muzzleflash(...)`). m_supertank.ts already ports both `fire_heat`
// (its real body lives in g_xatrix_weapon.cpp, NOT this file, but its only
// caller in this whole port line is `monster_fire_heat`) and
// `monster_fire_heat` itself as real, exported, `RegisterThink`-backed logic
// -- explicitly citing this file as `monster_fire_heat`'s true C++ home and
// flagging the eventual reconciliation. Per this unit's brief ("do not
// duplicate -- import if needed"), this file re-exports that existing
// implementation instead of redefining it (which would double-register
// `RegisterThink("heat_think", ...)`'s save-registry key and throw the
// moment both modules loaded in the same process).
//
// ============================================================================
// STUB SWAP -- this file is now the real home m_brain.ts/m_guardian.ts/
// m_soldier.ts's own header comments already promised
// ============================================================================
// `dabeam_update`/`monster_fire_dabeam` (and, for m_soldier.ts,
// `monster_fire_ionripper`/`monster_fire_blueblaster`) were previously local,
// unexported, cited THROWING STUBS in m_brain.ts, m_guardian.ts, and
// m_soldier.ts, each citing this file by name as their eventual real home.
// This unit IS that landing: all four are exported for real from here, and
// each of those three files' own local stub copies is deleted and replaced
// with an import from this module (see this unit's report for the exact
// per-file diff). `guardian_fire_update`, `brain_left_eye_laser_update`/
// `brain_right_eye_laser_update`, and `soldierh_laser_update` -- the
// PRETHINK callbacks those files already ported for real "even though the
// stub means it's never scheduled today" -- become genuinely reachable the
// moment this swap lands: guardian's atk2 laser-sweep branch, brain's atk4
// dual-eye laser branch, and every xatrix-styled soldier's ("h" variant)
// laserbeam weapon all go live with zero code changes in those three files
// beyond the stub deletion/import swap itself.

import { vec3, type Vec3 } from "../shared/math";
import { vec3_add, vec3_muls } from "./q_vec3";
import { ContentsT, CvarFlagsT, EffectsT, KexMulticastT, KexTempEventT, MODELINDEX_WORLD, RenderfxT, ServerCommandT, SolidT, SvflagsT, type KexEdictT, type KexTraceT, MonsterMuzzleflashIdT } from "../kexapi/game";
import type { CvarT } from "../shared/q_shared";
import { DamageflagsT, type EdictT, EntFlagsT, MAX_PIERCE, type ModT, ModIdT, MonsterAiFlagsT, MovetypeT, type PierceArgsT, type PierceHitFn, type PrethinkFn, type ThinkFn } from "./g_local";
import { RegisterThink } from "./g_save_registry";
import { gi, g_edicts, level } from "./g_main_globals";
import { Gtime_add, Gtime_from_ms } from "./gtime";
import { G_Spawn, G_FreeEdict } from "./g_utils";
import { T_Damage } from "./g_combat";
import { SpawnFlags_from, SpawnFlags_has, type SpawnFlags } from "./spawnflags";
import { fire_blueblaster, fire_ionripper } from "./g_xatrix_weapon";
import { monster_muzzleflash } from "./g_monster";

export { monster_fire_heat } from "./m_supertank";

// ---------------------------------------------------------------------------
// small per-file helpers (see g_weapon.ts's/g_target.ts's own header:
// duplicated on purpose, per this port line's established convention for
// tiny header-only wrappers)
// ---------------------------------------------------------------------------

function modFromId(id: ModIdT): ModT {
  return { id, friendly_fire: false, no_point_loss: false };
}
function traceEdict(ent: KexEdictT | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}
function giTraceline(start: Vec3, end: Vec3, passent: EdictT | null, mask: ContentsT): KexTraceT {
  return gi.trace(start, null, null, end, passent, mask);
}
/** m_soldier.ts's/g_ai.ts's/g_phys.ts's own `cvarOrDefault` -- duplicated
 *  per-file, per this port line's established convention. */
function cvarOrDefault(name: string, defaultValue: string): CvarT {
  const c = gi.cvar(name, defaultValue, CvarFlagsT.CVAR_NOFLAGS);
  if (c === null) throw new Error(`gi.cvar(${name}) returned null`);
  return c;
}
function skillInt(): number {
  return Math.trunc(cvarOrDefault("skill", "1").value);
}

// ---------------------------------------------------------------------------
// monster_fire_blueblaster / monster_fire_ionripper (g_xatrix_monster.cpp:
// 6-18)
// ---------------------------------------------------------------------------

/** `void monster_fire_blueblaster(...)` (g_xatrix_monster.cpp:7-11). */
export function monster_fire_blueblaster(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  speed: number,
  flashtype: MonsterMuzzleflashIdT,
  effect: EffectsT,
): void {
  fire_blueblaster(self, start, dir, damage, speed, effect);
  monster_muzzleflash(self, start, flashtype);
}

/** `void monster_fire_ionripper(...)` (g_xatrix_monster.cpp:14-18). */
export function monster_fire_ionripper(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  speed: number,
  flashtype: MonsterMuzzleflashIdT,
  effect: EffectsT,
): void {
  fire_ionripper(self, start, dir, damage, speed, effect);
  monster_muzzleflash(self, start, flashtype);
}

// ---------------------------------------------------------------------------
// dabeam_pierce_t / dabeam_update / beam_think / monster_fire_dabeam
// (g_xatrix_monster.cpp:27-142)
// ---------------------------------------------------------------------------

const SPAWNFLAG_DABEAM_SECONDARY: SpawnFlags = SpawnFlags_from(1);

/** `dabeam_pierce_t::hit` (g_xatrix_monster.cpp:42-81). `self` here is the
 *  BEAM entity (the C++ `self` field of `dabeam_pierce_t`, matching
 *  `dabeam_update`'s own `self` parameter), not the owning monster. */
function makeDabeamHit(self: EdictT, damage: boolean, pierce: PierceArgsT): PierceHitFn {
  return (_mask: [ContentsT], _end: Vec3): boolean => {
    const tr = pierce.tr;
    if (tr.ent === null) return false;
    const hitEnt = traceEdict(tr.ent);

    if (damage) {
      // hurt it if we can
      if (self.dmg > 0 && hitEnt.takedamage && (hitEnt.flags & EntFlagsT.FL_IMMUNE_LASER) === 0n && hitEnt !== self.owner) {
        T_Damage(hitEnt, self, self.owner ?? self, self.movedir, tr.endpos, vec3(0, 0, 0), self.dmg, skillInt(), DamageflagsT.DAMAGE_ENERGY, modFromId(ModIdT.MOD_TARGET_LASER));
      }

      if (self.dmg < 0) {
        // healer ray: when player is at 100 health, just undo health fix, keeping fx
        if (hitEnt.health < hitEnt.max_health) hitEnt.health = Math.min(hitEnt.max_health, hitEnt.health - self.dmg);
      }
    }

    // if we hit something that's not a monster or player, we're done
    if ((hitEnt.svflags & SvflagsT.SVF_MONSTER) === 0 && hitEnt.client === null) {
      if (damage) {
        gi.WriteByte(ServerCommandT.svc_temp_entity);
        gi.WriteByte(KexTempEventT.TE_LASER_SPARKS);
        gi.WriteByte(10);
        gi.WritePosition(tr.endpos);
        gi.WriteDir(tr.plane.normal);
        gi.WriteByte(self.s.skinnum);
        gi.multicast(tr.endpos, KexMulticastT.MULTICAST_PVS, false);
      }
      return false;
    }

    if (!markPierceLocal(pierce, hitEnt)) return false;

    return true;
  };
}

// pierce_args_t::mark/::restore/pierce_trace -- duplicated locally exactly
// like g_target.ts did before g_weapon.ts's own reconciliation landed;
// importing g_weapon.ts's exported copies here would work equally well, but
// this file follows the SAME "small header-only helper, duplicated per
// file" convention g_weapon.ts's own header documents for its OWN
// `modFromId`/`giTraceline` copies, to avoid a needless cross-file coupling
// for three tiny functions.
function markPierceLocal(pierce: PierceArgsT, ent: EdictT): boolean {
  if (pierce.num_pierced === MAX_PIERCE) return false;
  pierce.pierced[pierce.num_pierced] = ent;
  pierce.pierce_solidities[pierce.num_pierced] = ent.solid;
  pierce.num_pierced++;
  ent.solid = SolidT.SOLID_NOT;
  gi.linkentity(ent);
  return true;
}
function restorePierceLocal(pierce: PierceArgsT): void {
  for (let i = 0; i < pierce.num_pierced; i++) {
    const ent = pierce.pierced[i];
    if (ent === null) continue;
    ent.solid = pierce.pierce_solidities[i];
    gi.linkentity(ent);
  }
  pierce.num_pierced = 0;
}
function pierceTraceLocal(start: Vec3, end: Vec3, ignore: EdictT | null, pierce: PierceArgsT, mask: ContentsT): void {
  let loopCount = 8192; // MAX_EDICTS
  const ownEnd = vec3(end[0], end[1], end[2]);
  const maskBox: [ContentsT] = [mask];

  while (--loopCount !== 0) {
    pierce.tr = giTraceline(start, ownEnd, ignore, maskBox[0]);
    if (pierce.tr.ent === null || pierce.tr.fraction === 1.0) return;
    if (!pierce.hit(maskBox, ownEnd)) return;
  }

  gi.Com_Print("runaway pierce_trace\n");
}

/** `void dabeam_update(edict_t*, bool)` (g_xatrix_monster.cpp:84-98). */
export function dabeam_update(self: EdictT, damage: boolean): void {
  const start = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]);
  const end = vec3_add(start, vec3_muls(self.movedir, 2048));

  const pierce: PierceArgsT = {
    pierced: new Array<EdictT | null>(MAX_PIERCE).fill(null),
    pierce_solidities: new Array<number>(MAX_PIERCE).fill(0),
    num_pierced: 0,
    tr: giTraceline(start, start, self, ContentsT.CONTENTS_SOLID),
    hit: () => false,
  };
  pierce.hit = makeDabeamHit(self, damage, pierce);

  pierceTraceLocal(start, end, self, pierce, ContentsT.CONTENTS_SOLID | ContentsT.CONTENTS_MONSTER | ContentsT.CONTENTS_PLAYER | ContentsT.CONTENTS_DEADMONSTER);

  self.s.old_origin = vec3_add(pierce.tr.endpos, vec3_muls(pierce.tr.plane.normal, 1));
  gi.linkentity(self);

  restorePierceLocal(pierce); // destructor-at-scope-exit timing, see g_weapon.ts's identical note
}

/** `THINK(beam_think)` (g_xatrix_monster.cpp:102-109). */
const beam_think: ThinkFn = RegisterThink("beam_think", (self: EdictT): void => {
  const owner = self.owner;
  if (owner !== null) {
    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_DABEAM_SECONDARY)) owner.beam2 = null;
    else owner.beam = null;
  }
  G_FreeEdict(self);
});

/** `void monster_fire_dabeam(edict_t*, int, bool, void(*)(edict_t*))`
 *  (g_xatrix_monster.cpp:112-142). */
export function monster_fire_dabeam(self: EdictT, damage: number, secondary: boolean, update_func: PrethinkFn): void {
  let beam_ptr: EdictT | null = secondary ? self.beam2 : self.beam;

  if (beam_ptr === null) {
    beam_ptr = G_Spawn();

    beam_ptr.movetype = MovetypeT.MOVETYPE_NONE;
    beam_ptr.solid = SolidT.SOLID_NOT;
    beam_ptr.s.renderfx |= RenderfxT.RF_BEAM;
    beam_ptr.s.modelindex = MODELINDEX_WORLD;
    beam_ptr.owner = self;
    beam_ptr.dmg = damage;
    beam_ptr.s.frame = 2;
    beam_ptr.spawnflags = secondary ? SPAWNFLAG_DABEAM_SECONDARY : SpawnFlags_from(0);

    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC) !== 0n) beam_ptr.s.skinnum = 0xf3f3f1f1;
    else beam_ptr.s.skinnum = 0xf2f2f0f0;

    beam_ptr.think = beam_think;
    beam_ptr.s.sound = gi.soundindex("misc/lasfly.wav");
    beam_ptr.postthink = update_func;

    if (secondary) self.beam2 = beam_ptr;
    else self.beam = beam_ptr;
  }

  beam_ptr.nextthink = Gtime_add(level.time, Gtime_from_ms(200));
  update_func(beam_ptr);
  dabeam_update(beam_ptr, true);
}
