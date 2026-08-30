// cl_fx.c -- entity effects parsing and management

import {
  type Vec3,
  vec3,
  vec3_origin,
  VectorCopy,
  VectorSubtract,
  VectorAdd,
  VectorClear,
  VectorMA,
  VectorScale,
  VectorNormalize,
  VectorLength,
  DotProduct,
  CrossProduct,
  AngleVectors,
} from "../shared/math";
import { frand, crand } from "../qcommon/common";
import {
  type EntityStateT,
  MAX_QPATH,
  EntityEventT,
  MZ_SILENCED,
  MZ_BLASTER,
  MZ_BLUEHYPERBLASTER,
  MZ_HYPERBLASTER,
  MZ_MACHINEGUN,
  MZ_SHOTGUN,
  MZ_SSHOTGUN,
  MZ_CHAINGUN1,
  MZ_CHAINGUN2,
  MZ_CHAINGUN3,
  MZ_RAILGUN,
  MZ_ROCKET,
  MZ_GRENADE,
  MZ_BFG,
  MZ_LOGIN,
  MZ_LOGOUT,
  MZ_RESPAWN,
  MZ_PHALANX,
  MZ_IONRIPPER,
  MZ_ETF_RIFLE,
  MZ_SHOTGUN2,
  MZ_HEATBEAM,
  MZ_BLASTER2,
  MZ_TRACKER,
  MZ_NUKE1,
  MZ_NUKE2,
  MZ_NUKE4,
  MZ_NUKE8,
  MZ2_INFANTRY_MACHINEGUN_1,
  MZ2_INFANTRY_MACHINEGUN_2,
  MZ2_INFANTRY_MACHINEGUN_3,
  MZ2_INFANTRY_MACHINEGUN_4,
  MZ2_INFANTRY_MACHINEGUN_5,
  MZ2_INFANTRY_MACHINEGUN_6,
  MZ2_INFANTRY_MACHINEGUN_7,
  MZ2_INFANTRY_MACHINEGUN_8,
  MZ2_INFANTRY_MACHINEGUN_9,
  MZ2_INFANTRY_MACHINEGUN_10,
  MZ2_INFANTRY_MACHINEGUN_11,
  MZ2_INFANTRY_MACHINEGUN_12,
  MZ2_INFANTRY_MACHINEGUN_13,
  MZ2_SOLDIER_MACHINEGUN_1,
  MZ2_SOLDIER_MACHINEGUN_2,
  MZ2_SOLDIER_MACHINEGUN_3,
  MZ2_SOLDIER_MACHINEGUN_4,
  MZ2_SOLDIER_MACHINEGUN_5,
  MZ2_SOLDIER_MACHINEGUN_6,
  MZ2_SOLDIER_MACHINEGUN_7,
  MZ2_SOLDIER_MACHINEGUN_8,
  MZ2_GUNNER_MACHINEGUN_1,
  MZ2_GUNNER_MACHINEGUN_2,
  MZ2_GUNNER_MACHINEGUN_3,
  MZ2_GUNNER_MACHINEGUN_4,
  MZ2_GUNNER_MACHINEGUN_5,
  MZ2_GUNNER_MACHINEGUN_6,
  MZ2_GUNNER_MACHINEGUN_7,
  MZ2_GUNNER_MACHINEGUN_8,
  MZ2_ACTOR_MACHINEGUN_1,
  MZ2_SUPERTANK_MACHINEGUN_1,
  MZ2_SUPERTANK_MACHINEGUN_2,
  MZ2_SUPERTANK_MACHINEGUN_3,
  MZ2_SUPERTANK_MACHINEGUN_4,
  MZ2_SUPERTANK_MACHINEGUN_5,
  MZ2_SUPERTANK_MACHINEGUN_6,
  MZ2_TURRET_MACHINEGUN,
  MZ2_BOSS2_MACHINEGUN_L1,
  MZ2_BOSS2_MACHINEGUN_L2,
  MZ2_BOSS2_MACHINEGUN_L3,
  MZ2_BOSS2_MACHINEGUN_L4,
  MZ2_BOSS2_MACHINEGUN_L5,
  MZ2_CARRIER_MACHINEGUN_L1,
  MZ2_CARRIER_MACHINEGUN_L2,
  MZ2_SOLDIER_BLASTER_1,
  MZ2_SOLDIER_BLASTER_2,
  MZ2_SOLDIER_BLASTER_3,
  MZ2_SOLDIER_BLASTER_4,
  MZ2_SOLDIER_BLASTER_5,
  MZ2_SOLDIER_BLASTER_6,
  MZ2_SOLDIER_BLASTER_7,
  MZ2_SOLDIER_BLASTER_8,
  MZ2_TURRET_BLASTER,
  MZ2_FLYER_BLASTER_1,
  MZ2_FLYER_BLASTER_2,
  MZ2_MEDIC_BLASTER_1,
  MZ2_HOVER_BLASTER_1,
  MZ2_FLOAT_BLASTER_1,
  MZ2_SOLDIER_SHOTGUN_1,
  MZ2_SOLDIER_SHOTGUN_2,
  MZ2_SOLDIER_SHOTGUN_3,
  MZ2_SOLDIER_SHOTGUN_4,
  MZ2_SOLDIER_SHOTGUN_5,
  MZ2_SOLDIER_SHOTGUN_6,
  MZ2_SOLDIER_SHOTGUN_7,
  MZ2_SOLDIER_SHOTGUN_8,
  MZ2_TANK_BLASTER_1,
  MZ2_TANK_BLASTER_2,
  MZ2_TANK_BLASTER_3,
  MZ2_TANK_MACHINEGUN_1,
  MZ2_TANK_MACHINEGUN_2,
  MZ2_TANK_MACHINEGUN_3,
  MZ2_TANK_MACHINEGUN_4,
  MZ2_TANK_MACHINEGUN_5,
  MZ2_TANK_MACHINEGUN_6,
  MZ2_TANK_MACHINEGUN_7,
  MZ2_TANK_MACHINEGUN_8,
  MZ2_TANK_MACHINEGUN_9,
  MZ2_TANK_MACHINEGUN_10,
  MZ2_TANK_MACHINEGUN_11,
  MZ2_TANK_MACHINEGUN_12,
  MZ2_TANK_MACHINEGUN_13,
  MZ2_TANK_MACHINEGUN_14,
  MZ2_TANK_MACHINEGUN_15,
  MZ2_TANK_MACHINEGUN_16,
  MZ2_TANK_MACHINEGUN_17,
  MZ2_TANK_MACHINEGUN_18,
  MZ2_TANK_MACHINEGUN_19,
  MZ2_CHICK_ROCKET_1,
  MZ2_TURRET_ROCKET,
  MZ2_TANK_ROCKET_1,
  MZ2_TANK_ROCKET_2,
  MZ2_TANK_ROCKET_3,
  MZ2_SUPERTANK_ROCKET_1,
  MZ2_SUPERTANK_ROCKET_2,
  MZ2_SUPERTANK_ROCKET_3,
  MZ2_BOSS2_ROCKET_1,
  MZ2_BOSS2_ROCKET_2,
  MZ2_BOSS2_ROCKET_3,
  MZ2_BOSS2_ROCKET_4,
  MZ2_CARRIER_ROCKET_1,
  MZ2_GUNNER_GRENADE_1,
  MZ2_GUNNER_GRENADE_2,
  MZ2_GUNNER_GRENADE_3,
  MZ2_GUNNER_GRENADE_4,
  MZ2_GLADIATOR_RAILGUN_1,
  MZ2_CARRIER_RAILGUN,
  MZ2_WIDOW_RAIL,
  MZ2_MAKRON_BFG,
  MZ2_MAKRON_BLASTER_1,
  MZ2_MAKRON_BLASTER_2,
  MZ2_MAKRON_BLASTER_3,
  MZ2_MAKRON_BLASTER_4,
  MZ2_MAKRON_BLASTER_5,
  MZ2_MAKRON_BLASTER_6,
  MZ2_MAKRON_BLASTER_7,
  MZ2_MAKRON_BLASTER_8,
  MZ2_MAKRON_BLASTER_9,
  MZ2_MAKRON_BLASTER_10,
  MZ2_MAKRON_BLASTER_11,
  MZ2_MAKRON_BLASTER_12,
  MZ2_MAKRON_BLASTER_13,
  MZ2_MAKRON_BLASTER_14,
  MZ2_MAKRON_BLASTER_15,
  MZ2_MAKRON_BLASTER_16,
  MZ2_MAKRON_BLASTER_17,
  MZ2_JORG_MACHINEGUN_L1,
  MZ2_JORG_MACHINEGUN_L2,
  MZ2_JORG_MACHINEGUN_L3,
  MZ2_JORG_MACHINEGUN_L4,
  MZ2_JORG_MACHINEGUN_L5,
  MZ2_JORG_MACHINEGUN_L6,
  MZ2_JORG_MACHINEGUN_R1,
  MZ2_JORG_MACHINEGUN_R2,
  MZ2_JORG_MACHINEGUN_R3,
  MZ2_JORG_MACHINEGUN_R4,
  MZ2_JORG_MACHINEGUN_R5,
  MZ2_JORG_MACHINEGUN_R6,
  MZ2_JORG_BFG_1,
  MZ2_BOSS2_MACHINEGUN_R1,
  MZ2_BOSS2_MACHINEGUN_R2,
  MZ2_BOSS2_MACHINEGUN_R3,
  MZ2_BOSS2_MACHINEGUN_R4,
  MZ2_BOSS2_MACHINEGUN_R5,
  MZ2_CARRIER_MACHINEGUN_R1,
  MZ2_CARRIER_MACHINEGUN_R2,
  MZ2_STALKER_BLASTER,
  MZ2_DAEDALUS_BLASTER,
  MZ2_MEDIC_BLASTER_2,
  MZ2_WIDOW_BLASTER,
  MZ2_WIDOW_BLASTER_SWEEP1,
  MZ2_WIDOW_BLASTER_SWEEP2,
  MZ2_WIDOW_BLASTER_SWEEP3,
  MZ2_WIDOW_BLASTER_SWEEP4,
  MZ2_WIDOW_BLASTER_SWEEP5,
  MZ2_WIDOW_BLASTER_SWEEP6,
  MZ2_WIDOW_BLASTER_SWEEP7,
  MZ2_WIDOW_BLASTER_SWEEP8,
  MZ2_WIDOW_BLASTER_SWEEP9,
  MZ2_WIDOW_BLASTER_100,
  MZ2_WIDOW_BLASTER_90,
  MZ2_WIDOW_BLASTER_80,
  MZ2_WIDOW_BLASTER_70,
  MZ2_WIDOW_BLASTER_60,
  MZ2_WIDOW_BLASTER_50,
  MZ2_WIDOW_BLASTER_40,
  MZ2_WIDOW_BLASTER_30,
  MZ2_WIDOW_BLASTER_20,
  MZ2_WIDOW_BLASTER_10,
  MZ2_WIDOW_BLASTER_0,
  MZ2_WIDOW_BLASTER_10L,
  MZ2_WIDOW_BLASTER_20L,
  MZ2_WIDOW_BLASTER_30L,
  MZ2_WIDOW_BLASTER_40L,
  MZ2_WIDOW_BLASTER_50L,
  MZ2_WIDOW_BLASTER_60L,
  MZ2_WIDOW_BLASTER_70L,
  MZ2_WIDOW_RUN_1,
  MZ2_WIDOW_RUN_2,
  MZ2_WIDOW_RUN_3,
  MZ2_WIDOW_RUN_4,
  MZ2_WIDOW_RUN_5,
  MZ2_WIDOW_RUN_6,
  MZ2_WIDOW_RUN_7,
  MZ2_WIDOW_RUN_8,
  MZ2_WIDOW_DISRUPTOR,
  MZ2_WIDOW_PLASMABEAM,
  MZ2_WIDOW2_BEAMER_1,
  MZ2_WIDOW2_BEAMER_2,
  MZ2_WIDOW2_BEAMER_3,
  MZ2_WIDOW2_BEAMER_4,
  MZ2_WIDOW2_BEAMER_5,
  MZ2_WIDOW2_BEAM_SWEEP_1,
  MZ2_WIDOW2_BEAM_SWEEP_2,
  MZ2_WIDOW2_BEAM_SWEEP_3,
  MZ2_WIDOW2_BEAM_SWEEP_4,
  MZ2_WIDOW2_BEAM_SWEEP_5,
  MZ2_WIDOW2_BEAM_SWEEP_6,
  MZ2_WIDOW2_BEAM_SWEEP_7,
  MZ2_WIDOW2_BEAM_SWEEP_8,
  MZ2_WIDOW2_BEAM_SWEEP_9,
  MZ2_WIDOW2_BEAM_SWEEP_10,
  MZ2_WIDOW2_BEAM_SWEEP_11,
  EF_GIB,
  EF_GREENGIB,
  EF_ROCKET,
  CHAN_WEAPON,
  CHAN_AUTO,
  CHAN_BODY,
  ATTN_NORM,
  ATTN_IDLE,
  ATTN_NONE,
  Com_sprintf,
} from "../shared/q_shared";
import { NUMVERTEXNORMALS, bytedirs } from "../qcommon/anorms";
import {
  cl,
  cls,
  cl_entities,
  cl_dlights,
  clCvars,
  net_message,
  CparticleT,
  PARTICLE_GRAVITY,
  INSTANT_PARTICLE,
  re,
  type CdlightT,
  type CentityT,
  type ShadowLightT,
} from "./client";
import { MAX_PARTICLES, MAX_LIGHTSTYLES, type EntityT } from "./ref";
import { V_AddParticle, V_AddLight, V_AddLightStyle, V_AddLightEx } from "./cl_view";
import { S_StartSound, S_RegisterSound } from "./snd_dma";
import { ComError } from "../qcommon/qcommon";
import { ERR_DROP, MAX_EDICTS } from "../shared/q_shared";
import { MSG_ReadShort, MSG_ReadByte } from "../qcommon/sizebuf";
// Family-aware muzzleflash offset table: game/m_flash.ts's own header
// comment ("this file is included in both the game dll and quake2, the
// game needs it to source shot locations, the client needs it to position
// muzzle flashes") is the documented precedent for a client file importing
// this table directly rather than going through a server-round-trip or a
// game-side accessor -- kexgame/m_flash.ts carries the identical
// both-game-and-client comment, so importing it here the same way is that
// same precedent extended to the second family, not a new leak.
import { monsterFlashOffset as classicMonsterFlashOffset } from "../game/m_flash";
import { monsterFlashOffset as kexMonsterFlashOffset } from "../kexgame/m_flash";
import { CS_REMAP_RERELEASE } from "../shared/cs_remap";
import { CL_SmokeAndFlash, cl_sfx_footsteps } from "./cl_tent";
import { fixedLength } from "../shared/fixed";

// Which monster_flash_offset table CL_ParseMuzzleFlash2 resolves `flash_number`
// through. Keyed off cls.csr (set by cl_parse.ts's CL_ParseServerData from the
// connection's negotiated protocol -- CS_REMAP_RERELEASE for the kex family,
// CS_REMAP_OLD otherwise), the same signal cl_parse.ts already uses right next
// to it for CG_SetActiveCgameKind. Not routed through CG_GetActiveCgameKind
// (host.ts): that seam exists for HUD/cgame-export selection, and coupling
// this unrelated data-table lookup to it would trade one direct, already-
// precedented import (see above) for a dependency on the cgame subsystem.
function activeMonsterFlashOffset(): readonly Vec3[] {
  return cls.csr === CS_REMAP_RERELEASE ? kexMonsterFlashOffset() : classicMonsterFlashOffset();
}

// C's raw rand() (0..0x7fff), used directly (rather than through frand()/
// crand()) all over cl_fx.c/cl_newfx.c/cl_tent.c for its bit-masking idiom
// (`rand()&7`, `rand()%360`, etc). PORTING.md routes rand()/random() to
// src/shared/math.ts, but that file is outside this unit's SCOPE; ported
// here instead and re-exported for cl_newfx.ts/cl_tent.ts to share --
// reported deviation.
export function rand(): number {
  return Math.floor(Math.random() * 32768) & 0x7fff;
}

//==============================================================
//
// LIGHT STYLE MANAGEMENT
//
//==============================================================

export class ClightstyleT {
  length = 0;
  value: Vec3 = vec3();
  map: Float32Array = new Float32Array(MAX_QPATH);
}

export const cl_lightstyle: ClightstyleT[] = Array.from({ length: MAX_LIGHTSTYLES }, () => new ClightstyleT());
let lastofs = 0;

export function CL_ClearLightStyles(): void {
  for (const ls of cl_lightstyle) {
    ls.length = 0;
    ls.value = vec3();
    ls.map = new Float32Array(MAX_QPATH);
  }
  lastofs = -1;
}

export function CL_RunLightStyles(): void {
  const ofs = (cl.time / 100) | 0;
  if (ofs === lastofs) return;
  lastofs = ofs;

  for (let i = 0; i < MAX_LIGHTSTYLES; i++) {
    const ls = cl_lightstyle[i];
    if (!ls.length) {
      ls.value[0] = ls.value[1] = ls.value[2] = 1.0;
      continue;
    }
    if (ls.length === 1) {
      ls.value[0] = ls.value[1] = ls.value[2] = ls.map[0];
    } else {
      ls.value[0] = ls.value[1] = ls.value[2] = ls.map[ofs % ls.length];
    }
  }
}

export function CL_SetLightstyle(i: number): void {
  const s = cl.configstrings[i + cls.csr.lights];

  const j = s.length;
  if (j >= MAX_QPATH) {
    throw new ComError(ERR_DROP, `svc_lightstyle length=${j}`);
  }

  cl_lightstyle[i].length = j;

  for (let k = 0; k < j; k++) {
    cl_lightstyle[i].map[k] = (s.charCodeAt(k) - "a".charCodeAt(0)) / ("m".charCodeAt(0) - "a".charCodeAt(0));
  }
}

/*
=================
CL_ParseShadowLightConfigstring

q2repro src/client/precache.c's CS_LoadShadowLight -- task #25 (v1.1.0).
Wire format (kexgame/g_misc.ts's GetShadowLightData writer, matching
q2repro's own G_Fmt call byte-for-byte): 12 semicolon-separated fields --
entity number, is-cone flag, radius, resolution, intensity, fade_start,
fade_end, lightstyle, coneangle, conedirection xyz. A malformed string (not
exactly 12 fields, q2repro's "n !== 11" semicolon count) is silently
dropped, matching the original's `return;` on that same check.
=================
*/
export function CL_ParseShadowLightConfigstring(index: number, s: string): void {
  const parts = s.split(";");
  if (parts.length !== 12) return;

  const def = cl.shadowdefs[index];
  if (def === undefined) return;

  def.number = parseInt(parts[0] ?? "0", 10);
  const isCone = parseInt(parts[1] ?? "0", 10) !== 0;
  def.light.radius = parseFloat(parts[2] ?? "0");
  def.light.resolution = parseInt(parts[3] ?? "0", 10);
  def.light.intensity = parseFloat(parts[4] ?? "0");
  def.light.fade_start = parseFloat(parts[5] ?? "0");
  def.light.fade_end = parseFloat(parts[6] ?? "0");
  def.light.lightstyle = parseInt(parts[7] ?? "0", 10);
  def.light.coneangle = isCone ? parseFloat(parts[8] ?? "0") : 0;
  def.light.conedirection[0] = parseFloat(parts[9] ?? "0");
  def.light.conedirection[1] = parseFloat(parts[10] ?? "0");
  def.light.conedirection[2] = parseFloat(parts[11] ?? "0");
}

// q2repro src/client/effects.c's CL_AddShadowLights -- task #25 (v1.1.0).
// Re-evaluates every active shadowdefs[] slot against the entity it's
// attached to (by entity number, per this frame's cl_entities[] snapshot)
// and hands the result to V_AddLightEx. No-op unless both cl_shadowlights
// and the renderer's per-pixel shader path are active -- a shadow light is
// otherwise pointless to evaluate (the fixed-function path has nothing
// that consumes its per-pixel fields).
export function CL_AddShadowLights(): void {
  if (!clCvars.cl_shadowlights?.value) return;
  if (!re?.SupportsPerPixelLighting()) return;

  for (let i = 0; i < cls.csr.max_shadowlights; i++) {
    if (!cl.configstrings[cls.csr.shadowlights + i]) continue;

    const def = cl.shadowdefs[i];
    if (def === undefined) continue;

    const ent = cl_entities[def.number];
    if (ent === undefined || ent.serverframe !== cl.frame.serverframe) continue;

    // technically we should be lerping, but these lights never move in the
    // game (even though they can) -- same comment as q2repro's own source
    unpackShadowLightColor(ent.current.skinnum, def.light);
    def.light.origin[0] = ent.current.origin[0];
    def.light.origin[1] = ent.current.origin[1];
    def.light.origin[2] = ent.current.origin[2];

    V_AddLightEx(def.light);
  }
}

// q2repro's `color.u32 = BigLong(ent->current.skinnum);` unpacked as
// little-endian RGBA bytes (color_t's in-memory layout); skinnum===0 means
// COLOR_WHITE, matching CL_AddShadowLights' own `!ent->current.skinnum`
// check.
function unpackShadowLightColor(skinnum: number, light: ShadowLightT): void {
  if (!skinnum) {
    light.color[0] = 1;
    light.color[1] = 1;
    light.color[2] = 1;
    return;
  }
  const u = skinnum >>> 0;
  light.color[0] = (u & 0xff) / 255;
  light.color[1] = ((u >>> 8) & 0xff) / 255;
  light.color[2] = ((u >>> 16) & 0xff) / 255;
}

export function CL_AddLightStyles(): void {
  for (let i = 0; i < MAX_LIGHTSTYLES; i++) {
    const ls = cl_lightstyle[i];
    V_AddLightStyle(i, ls.value[0], ls.value[1], ls.value[2]);
  }
}

//==============================================================
//
// DLIGHT MANAGEMENT
//
//==============================================================

function clearDlight(dl: CdlightT): void {
  dl.key = 0;
  dl.color = vec3();
  dl.origin = vec3();
  dl.radius = 0;
  dl.die = 0;
  dl.decay = 0;
  dl.minlight = 0;
}

export function CL_ClearDlights(): void {
  for (const dl of cl_dlights) clearDlight(dl);
}

export function CL_AllocDlight(key: number): CdlightT {
  // first look for an exact key match
  if (key) {
    for (const dl of cl_dlights) {
      if (dl.key === key) {
        clearDlight(dl);
        dl.key = key;
        return dl;
      }
    }
  }

  // then look for anything else
  for (const dl of cl_dlights) {
    if (dl.die < cl.time) {
      clearDlight(dl);
      dl.key = key;
      return dl;
    }
  }

  const dl = cl_dlights[0];
  clearDlight(dl);
  dl.key = key;
  return dl;
}

export function CL_NewDlight(key: number, x: number, y: number, z: number, radius: number, time: number): void {
  const dl = CL_AllocDlight(key);
  dl.origin[0] = x;
  dl.origin[1] = y;
  dl.origin[2] = z;
  dl.radius = radius;
  dl.die = cl.time + time;
}

export function CL_RunDLights(): void {
  for (const dl of cl_dlights) {
    if (!dl.radius) continue;

    if (dl.die < cl.time) {
      dl.radius = 0;
      return;
    }
    dl.radius -= cls.frametime * dl.decay;
    if (dl.radius < 0) dl.radius = 0;
  }
}

export function CL_ParseMuzzleFlash(): void {
  const i = MSG_ReadShort(net_message);
  if (i < 1 || i >= MAX_EDICTS) {
    throw new ComError(ERR_DROP, "CL_ParseMuzzleFlash: bad entity");
  }

  let weapon = MSG_ReadByte(net_message);
  const silenced = weapon & MZ_SILENCED;
  weapon &= ~MZ_SILENCED;

  const pl = cl_entities[i];

  const dl = CL_AllocDlight(i);
  VectorCopy(pl.current.origin, dl.origin);
  const fv = vec3();
  const rv = vec3();
  AngleVectors(pl.current.angles, fv, rv, null);
  VectorMA(dl.origin, 18, fv, dl.origin);
  VectorMA(dl.origin, 16, rv, dl.origin);
  if (silenced) dl.radius = 100 + (rand() & 31);
  else dl.radius = 200 + (rand() & 31);
  dl.minlight = 32;
  dl.die = cl.time; // + 0.1;

  const volume = silenced ? 0.2 : 1;

  switch (weapon) {
    case MZ_BLASTER:
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound("weapons/blastf1a.wav"), volume, ATTN_NORM, 0);
      break;
    case MZ_BLUEHYPERBLASTER:
      dl.color[0] = 0;
      dl.color[1] = 0;
      dl.color[2] = 1;
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound("weapons/hyprbf1a.wav"), volume, ATTN_NORM, 0);
      break;
    case MZ_HYPERBLASTER:
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound("weapons/hyprbf1a.wav"), volume, ATTN_NORM, 0);
      break;
    case MZ_MACHINEGUN:
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound(Com_sprintf("weapons/machgf%ib.wav", (rand() % 5) + 1)), volume, ATTN_NORM, 0);
      break;
    case MZ_SHOTGUN:
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound("weapons/shotgf1b.wav"), volume, ATTN_NORM, 0);
      S_StartSound(null, i, CHAN_AUTO, S_RegisterSound("weapons/shotgr1b.wav"), volume, ATTN_NORM, 0.1);
      break;
    case MZ_SSHOTGUN:
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound("weapons/sshotf1b.wav"), volume, ATTN_NORM, 0);
      break;
    case MZ_CHAINGUN1:
      dl.radius = 200 + (rand() & 31);
      dl.color[0] = 1;
      dl.color[1] = 0.25;
      dl.color[2] = 0;
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound(Com_sprintf("weapons/machgf%ib.wav", (rand() % 5) + 1)), volume, ATTN_NORM, 0);
      break;
    case MZ_CHAINGUN2:
      dl.radius = 225 + (rand() & 31);
      dl.color[0] = 1;
      dl.color[1] = 0.5;
      dl.color[2] = 0;
      dl.die = cl.time + 0.1; // long delay
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound(Com_sprintf("weapons/machgf%ib.wav", (rand() % 5) + 1)), volume, ATTN_NORM, 0);
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound(Com_sprintf("weapons/machgf%ib.wav", (rand() % 5) + 1)), volume, ATTN_NORM, 0.05);
      break;
    case MZ_CHAINGUN3:
      dl.radius = 250 + (rand() & 31);
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      dl.die = cl.time + 0.1; // long delay
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound(Com_sprintf("weapons/machgf%ib.wav", (rand() % 5) + 1)), volume, ATTN_NORM, 0);
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound(Com_sprintf("weapons/machgf%ib.wav", (rand() % 5) + 1)), volume, ATTN_NORM, 0.033);
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound(Com_sprintf("weapons/machgf%ib.wav", (rand() % 5) + 1)), volume, ATTN_NORM, 0.066);
      break;
    case MZ_RAILGUN:
      dl.color[0] = 0.5;
      dl.color[1] = 0.5;
      dl.color[2] = 1.0;
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound("weapons/railgf1a.wav"), volume, ATTN_NORM, 0);
      break;
    case MZ_ROCKET:
      dl.color[0] = 1;
      dl.color[1] = 0.5;
      dl.color[2] = 0.2;
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound("weapons/rocklf1a.wav"), volume, ATTN_NORM, 0);
      S_StartSound(null, i, CHAN_AUTO, S_RegisterSound("weapons/rocklr1b.wav"), volume, ATTN_NORM, 0.1);
      break;
    case MZ_GRENADE:
      dl.color[0] = 1;
      dl.color[1] = 0.5;
      dl.color[2] = 0;
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound("weapons/grenlf1a.wav"), volume, ATTN_NORM, 0);
      S_StartSound(null, i, CHAN_AUTO, S_RegisterSound("weapons/grenlr1b.wav"), volume, ATTN_NORM, 0.1);
      break;
    case MZ_BFG:
      dl.color[0] = 0;
      dl.color[1] = 1;
      dl.color[2] = 0;
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound("weapons/bfg__f1y.wav"), volume, ATTN_NORM, 0);
      break;

    case MZ_LOGIN:
      dl.color[0] = 0;
      dl.color[1] = 1;
      dl.color[2] = 0;
      dl.die = cl.time + 1.0;
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound("weapons/grenlf1a.wav"), 1, ATTN_NORM, 0);
      CL_LogoutEffect(pl.current.origin, weapon);
      break;
    case MZ_LOGOUT:
      dl.color[0] = 1;
      dl.color[1] = 0;
      dl.color[2] = 0;
      dl.die = cl.time + 1.0;
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound("weapons/grenlf1a.wav"), 1, ATTN_NORM, 0);
      CL_LogoutEffect(pl.current.origin, weapon);
      break;
    case MZ_RESPAWN:
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      dl.die = cl.time + 1.0;
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound("weapons/grenlf1a.wav"), 1, ATTN_NORM, 0);
      CL_LogoutEffect(pl.current.origin, weapon);
      break;
    // RAFAEL
    case MZ_PHALANX:
      dl.color[0] = 1;
      dl.color[1] = 0.5;
      dl.color[2] = 0.5;
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound("weapons/plasshot.wav"), volume, ATTN_NORM, 0);
      break;
    // RAFAEL
    case MZ_IONRIPPER:
      dl.color[0] = 1;
      dl.color[1] = 0.5;
      dl.color[2] = 0.5;
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound("weapons/rippfire.wav"), volume, ATTN_NORM, 0);
      break;

    // ======================
    // PGM
    case MZ_ETF_RIFLE:
      dl.color[0] = 0.9;
      dl.color[1] = 0.7;
      dl.color[2] = 0;
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound("weapons/nail1.wav"), volume, ATTN_NORM, 0);
      break;
    case MZ_SHOTGUN2:
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound("weapons/shotg2.wav"), volume, ATTN_NORM, 0);
      break;
    case MZ_HEATBEAM:
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      dl.die = cl.time + 100;
      break;
    case MZ_BLASTER2:
      dl.color[0] = 0;
      dl.color[1] = 1;
      dl.color[2] = 0;
      // FIXME - different sound for blaster2 ??
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound("weapons/blastf1a.wav"), volume, ATTN_NORM, 0);
      break;
    case MZ_TRACKER:
      // negative flashes handled the same in gl/soft until CL_AddDLights
      dl.color[0] = -1;
      dl.color[1] = -1;
      dl.color[2] = -1;
      S_StartSound(null, i, CHAN_WEAPON, S_RegisterSound("weapons/disint2.wav"), volume, ATTN_NORM, 0);
      break;
    case MZ_NUKE1:
      dl.color[0] = 1;
      dl.color[1] = 0;
      dl.color[2] = 0;
      dl.die = cl.time + 100;
      break;
    case MZ_NUKE2:
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      dl.die = cl.time + 100;
      break;
    case MZ_NUKE4:
      dl.color[0] = 0;
      dl.color[1] = 0;
      dl.color[2] = 1;
      dl.die = cl.time + 100;
      break;
    case MZ_NUKE8:
      dl.color[0] = 0;
      dl.color[1] = 1;
      dl.color[2] = 1;
      dl.die = cl.time + 100;
      break;
    // PGM
    // ======================
  }
}

export function CL_ParseMuzzleFlash2(): void {
  const ent = MSG_ReadShort(net_message);
  if (ent < 1 || ent >= MAX_EDICTS) {
    throw new ComError(ERR_DROP, "CL_ParseMuzzleFlash2: bad entity");
  }

  const flash_number = MSG_ReadByte(net_message);

  // locate the origin
  const forward = vec3();
  const right = vec3();
  AngleVectors(cl_entities[ent].current.angles, forward, right, null);
  // activeMonsterFlashOffset() picks the classic 212-entry table (src/game/
  // m_flash.ts, baseq2 + rogue/xatrix mission-pack additions) or the kex
  // 290-entry table (src/kexgame/m_flash.ts, MZ2_UNUSED_0..MZ2_LAST) by
  // connection family -- see the selector's own doc comment above. The kex
  // table's range (0..289) already covers every value `flash_number` (a
  // single byte, 0..255) can hold, so under the kex family this lookup is
  // always defined; the `?? vec3(0,0,0)` fallback below is now a genuine
  // out-of-range guard for the CLASSIC family only, where a `flash_number`
  // of 212..255 has no table entry (matches the original engine indexing a
  // fixed-size array with no bounds check -- out of range there is
  // undefined behavior, not a defined zero; this fallback is a deliberate,
  // documented deviation, not a faithfully-ported crash). Previously this
  // guard was also standing in for the whole missing kex table (found via a
  // real retail KEX-format demo file crashing playback on an unmapped
  // `flash_number` -- KEX demo playback unit's own task report); now that
  // the kex table is ported in full, that reason no longer applies. Falling
  // back to a zero offset only affects the exact visual/light POSITION of
  // an unrecognized flash type; every other effect this function drives off
  // `flash_number` (sound, particle color, etc., in the switch below) is
  // unaffected and still runs for real.
  const offset = activeMonsterFlashOffset()[flash_number] ?? vec3(0, 0, 0);
  const origin = vec3();
  origin[0] = cl_entities[ent].current.origin[0] + forward[0] * offset[0] + right[0] * offset[1];
  origin[1] = cl_entities[ent].current.origin[1] + forward[1] * offset[0] + right[1] * offset[1];
  origin[2] = cl_entities[ent].current.origin[2] + forward[2] * offset[0] + right[2] * offset[1] + offset[2];

  const dl = CL_AllocDlight(ent);
  VectorCopy(origin, dl.origin);
  dl.radius = 200 + (rand() & 31);
  dl.minlight = 32;
  dl.die = cl.time; // + 0.1;

  switch (flash_number) {
    case MZ2_INFANTRY_MACHINEGUN_1:
    case MZ2_INFANTRY_MACHINEGUN_2:
    case MZ2_INFANTRY_MACHINEGUN_3:
    case MZ2_INFANTRY_MACHINEGUN_4:
    case MZ2_INFANTRY_MACHINEGUN_5:
    case MZ2_INFANTRY_MACHINEGUN_6:
    case MZ2_INFANTRY_MACHINEGUN_7:
    case MZ2_INFANTRY_MACHINEGUN_8:
    case MZ2_INFANTRY_MACHINEGUN_9:
    case MZ2_INFANTRY_MACHINEGUN_10:
    case MZ2_INFANTRY_MACHINEGUN_11:
    case MZ2_INFANTRY_MACHINEGUN_12:
    case MZ2_INFANTRY_MACHINEGUN_13:
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      CL_ParticleEffect(origin, vec3_origin, 0, 40);
      CL_SmokeAndFlash(origin);
      S_StartSound(null, ent, CHAN_WEAPON, S_RegisterSound("infantry/infatck1.wav"), 1, ATTN_NORM, 0);
      break;

    case MZ2_SOLDIER_MACHINEGUN_1:
    case MZ2_SOLDIER_MACHINEGUN_2:
    case MZ2_SOLDIER_MACHINEGUN_3:
    case MZ2_SOLDIER_MACHINEGUN_4:
    case MZ2_SOLDIER_MACHINEGUN_5:
    case MZ2_SOLDIER_MACHINEGUN_6:
    case MZ2_SOLDIER_MACHINEGUN_7:
    case MZ2_SOLDIER_MACHINEGUN_8:
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      CL_ParticleEffect(origin, vec3_origin, 0, 40);
      CL_SmokeAndFlash(origin);
      S_StartSound(null, ent, CHAN_WEAPON, S_RegisterSound("soldier/solatck3.wav"), 1, ATTN_NORM, 0);
      break;

    case MZ2_GUNNER_MACHINEGUN_1:
    case MZ2_GUNNER_MACHINEGUN_2:
    case MZ2_GUNNER_MACHINEGUN_3:
    case MZ2_GUNNER_MACHINEGUN_4:
    case MZ2_GUNNER_MACHINEGUN_5:
    case MZ2_GUNNER_MACHINEGUN_6:
    case MZ2_GUNNER_MACHINEGUN_7:
    case MZ2_GUNNER_MACHINEGUN_8:
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      CL_ParticleEffect(origin, vec3_origin, 0, 40);
      CL_SmokeAndFlash(origin);
      S_StartSound(null, ent, CHAN_WEAPON, S_RegisterSound("gunner/gunatck2.wav"), 1, ATTN_NORM, 0);
      break;

    case MZ2_ACTOR_MACHINEGUN_1:
    case MZ2_SUPERTANK_MACHINEGUN_1:
    case MZ2_SUPERTANK_MACHINEGUN_2:
    case MZ2_SUPERTANK_MACHINEGUN_3:
    case MZ2_SUPERTANK_MACHINEGUN_4:
    case MZ2_SUPERTANK_MACHINEGUN_5:
    case MZ2_SUPERTANK_MACHINEGUN_6:
    case MZ2_TURRET_MACHINEGUN: // PGM
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;

      CL_ParticleEffect(origin, vec3_origin, 0, 40);
      CL_SmokeAndFlash(origin);
      S_StartSound(null, ent, CHAN_WEAPON, S_RegisterSound("infantry/infatck1.wav"), 1, ATTN_NORM, 0);
      break;

    case MZ2_BOSS2_MACHINEGUN_L1:
    case MZ2_BOSS2_MACHINEGUN_L2:
    case MZ2_BOSS2_MACHINEGUN_L3:
    case MZ2_BOSS2_MACHINEGUN_L4:
    case MZ2_BOSS2_MACHINEGUN_L5:
    case MZ2_CARRIER_MACHINEGUN_L1: // PMM
    case MZ2_CARRIER_MACHINEGUN_L2: // PMM
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;

      CL_ParticleEffect(origin, vec3_origin, 0, 40);
      CL_SmokeAndFlash(origin);
      S_StartSound(null, ent, CHAN_WEAPON, S_RegisterSound("infantry/infatck1.wav"), 1, ATTN_NONE, 0);
      break;

    case MZ2_SOLDIER_BLASTER_1:
    case MZ2_SOLDIER_BLASTER_2:
    case MZ2_SOLDIER_BLASTER_3:
    case MZ2_SOLDIER_BLASTER_4:
    case MZ2_SOLDIER_BLASTER_5:
    case MZ2_SOLDIER_BLASTER_6:
    case MZ2_SOLDIER_BLASTER_7:
    case MZ2_SOLDIER_BLASTER_8:
    case MZ2_TURRET_BLASTER: // PGM
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      S_StartSound(null, ent, CHAN_WEAPON, S_RegisterSound("soldier/solatck2.wav"), 1, ATTN_NORM, 0);
      break;

    case MZ2_FLYER_BLASTER_1:
    case MZ2_FLYER_BLASTER_2:
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      S_StartSound(null, ent, CHAN_WEAPON, S_RegisterSound("flyer/flyatck3.wav"), 1, ATTN_NORM, 0);
      break;

    case MZ2_MEDIC_BLASTER_1:
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      S_StartSound(null, ent, CHAN_WEAPON, S_RegisterSound("medic/medatck1.wav"), 1, ATTN_NORM, 0);
      break;

    case MZ2_HOVER_BLASTER_1:
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      S_StartSound(null, ent, CHAN_WEAPON, S_RegisterSound("hover/hovatck1.wav"), 1, ATTN_NORM, 0);
      break;

    case MZ2_FLOAT_BLASTER_1:
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      S_StartSound(null, ent, CHAN_WEAPON, S_RegisterSound("floater/fltatck1.wav"), 1, ATTN_NORM, 0);
      break;

    case MZ2_SOLDIER_SHOTGUN_1:
    case MZ2_SOLDIER_SHOTGUN_2:
    case MZ2_SOLDIER_SHOTGUN_3:
    case MZ2_SOLDIER_SHOTGUN_4:
    case MZ2_SOLDIER_SHOTGUN_5:
    case MZ2_SOLDIER_SHOTGUN_6:
    case MZ2_SOLDIER_SHOTGUN_7:
    case MZ2_SOLDIER_SHOTGUN_8:
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      CL_SmokeAndFlash(origin);
      S_StartSound(null, ent, CHAN_WEAPON, S_RegisterSound("soldier/solatck1.wav"), 1, ATTN_NORM, 0);
      break;

    case MZ2_TANK_BLASTER_1:
    case MZ2_TANK_BLASTER_2:
    case MZ2_TANK_BLASTER_3:
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      S_StartSound(null, ent, CHAN_WEAPON, S_RegisterSound("tank/tnkatck3.wav"), 1, ATTN_NORM, 0);
      break;

    case MZ2_TANK_MACHINEGUN_1:
    case MZ2_TANK_MACHINEGUN_2:
    case MZ2_TANK_MACHINEGUN_3:
    case MZ2_TANK_MACHINEGUN_4:
    case MZ2_TANK_MACHINEGUN_5:
    case MZ2_TANK_MACHINEGUN_6:
    case MZ2_TANK_MACHINEGUN_7:
    case MZ2_TANK_MACHINEGUN_8:
    case MZ2_TANK_MACHINEGUN_9:
    case MZ2_TANK_MACHINEGUN_10:
    case MZ2_TANK_MACHINEGUN_11:
    case MZ2_TANK_MACHINEGUN_12:
    case MZ2_TANK_MACHINEGUN_13:
    case MZ2_TANK_MACHINEGUN_14:
    case MZ2_TANK_MACHINEGUN_15:
    case MZ2_TANK_MACHINEGUN_16:
    case MZ2_TANK_MACHINEGUN_17:
    case MZ2_TANK_MACHINEGUN_18:
    case MZ2_TANK_MACHINEGUN_19:
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      CL_ParticleEffect(origin, vec3_origin, 0, 40);
      CL_SmokeAndFlash(origin);
      S_StartSound(
        null,
        ent,
        CHAN_WEAPON,
        S_RegisterSound(Com_sprintf("tank/tnkatk2%c.wav", String.fromCharCode("a".charCodeAt(0) + (rand() % 5)))),
        1,
        ATTN_NORM,
        0,
      );
      break;

    case MZ2_CHICK_ROCKET_1:
    case MZ2_TURRET_ROCKET: // PGM
      dl.color[0] = 1;
      dl.color[1] = 0.5;
      dl.color[2] = 0.2;
      S_StartSound(null, ent, CHAN_WEAPON, S_RegisterSound("chick/chkatck2.wav"), 1, ATTN_NORM, 0);
      break;

    case MZ2_TANK_ROCKET_1:
    case MZ2_TANK_ROCKET_2:
    case MZ2_TANK_ROCKET_3:
      dl.color[0] = 1;
      dl.color[1] = 0.5;
      dl.color[2] = 0.2;
      S_StartSound(null, ent, CHAN_WEAPON, S_RegisterSound("tank/tnkatck1.wav"), 1, ATTN_NORM, 0);
      break;

    case MZ2_SUPERTANK_ROCKET_1:
    case MZ2_SUPERTANK_ROCKET_2:
    case MZ2_SUPERTANK_ROCKET_3:
    case MZ2_BOSS2_ROCKET_1:
    case MZ2_BOSS2_ROCKET_2:
    case MZ2_BOSS2_ROCKET_3:
    case MZ2_BOSS2_ROCKET_4:
    case MZ2_CARRIER_ROCKET_1:
      dl.color[0] = 1;
      dl.color[1] = 0.5;
      dl.color[2] = 0.2;
      S_StartSound(null, ent, CHAN_WEAPON, S_RegisterSound("tank/rocket.wav"), 1, ATTN_NORM, 0);
      break;

    case MZ2_GUNNER_GRENADE_1:
    case MZ2_GUNNER_GRENADE_2:
    case MZ2_GUNNER_GRENADE_3:
    case MZ2_GUNNER_GRENADE_4:
      dl.color[0] = 1;
      dl.color[1] = 0.5;
      dl.color[2] = 0;
      S_StartSound(null, ent, CHAN_WEAPON, S_RegisterSound("gunner/gunatck3.wav"), 1, ATTN_NORM, 0);
      break;

    case MZ2_GLADIATOR_RAILGUN_1:
    // PMM
    case MZ2_CARRIER_RAILGUN:
    case MZ2_WIDOW_RAIL:
      // pmm
      dl.color[0] = 0.5;
      dl.color[1] = 0.5;
      dl.color[2] = 1.0;
      break;

    // --- Xian's shit starts ---
    case MZ2_MAKRON_BFG:
      dl.color[0] = 0.5;
      dl.color[1] = 1;
      dl.color[2] = 0.5;
      break;

    case MZ2_MAKRON_BLASTER_1:
    case MZ2_MAKRON_BLASTER_2:
    case MZ2_MAKRON_BLASTER_3:
    case MZ2_MAKRON_BLASTER_4:
    case MZ2_MAKRON_BLASTER_5:
    case MZ2_MAKRON_BLASTER_6:
    case MZ2_MAKRON_BLASTER_7:
    case MZ2_MAKRON_BLASTER_8:
    case MZ2_MAKRON_BLASTER_9:
    case MZ2_MAKRON_BLASTER_10:
    case MZ2_MAKRON_BLASTER_11:
    case MZ2_MAKRON_BLASTER_12:
    case MZ2_MAKRON_BLASTER_13:
    case MZ2_MAKRON_BLASTER_14:
    case MZ2_MAKRON_BLASTER_15:
    case MZ2_MAKRON_BLASTER_16:
    case MZ2_MAKRON_BLASTER_17:
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      S_StartSound(null, ent, CHAN_WEAPON, S_RegisterSound("makron/blaster.wav"), 1, ATTN_NORM, 0);
      break;

    case MZ2_JORG_MACHINEGUN_L1:
    case MZ2_JORG_MACHINEGUN_L2:
    case MZ2_JORG_MACHINEGUN_L3:
    case MZ2_JORG_MACHINEGUN_L4:
    case MZ2_JORG_MACHINEGUN_L5:
    case MZ2_JORG_MACHINEGUN_L6:
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      CL_ParticleEffect(origin, vec3_origin, 0, 40);
      CL_SmokeAndFlash(origin);
      S_StartSound(null, ent, CHAN_WEAPON, S_RegisterSound("boss3/xfire.wav"), 1, ATTN_NORM, 0);
      break;

    case MZ2_JORG_MACHINEGUN_R1:
    case MZ2_JORG_MACHINEGUN_R2:
    case MZ2_JORG_MACHINEGUN_R3:
    case MZ2_JORG_MACHINEGUN_R4:
    case MZ2_JORG_MACHINEGUN_R5:
    case MZ2_JORG_MACHINEGUN_R6:
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      CL_ParticleEffect(origin, vec3_origin, 0, 40);
      CL_SmokeAndFlash(origin);
      break;

    case MZ2_JORG_BFG_1:
      dl.color[0] = 0.5;
      dl.color[1] = 1;
      dl.color[2] = 0.5;
      break;

    case MZ2_BOSS2_MACHINEGUN_R1:
    case MZ2_BOSS2_MACHINEGUN_R2:
    case MZ2_BOSS2_MACHINEGUN_R3:
    case MZ2_BOSS2_MACHINEGUN_R4:
    case MZ2_BOSS2_MACHINEGUN_R5:
    case MZ2_CARRIER_MACHINEGUN_R1: // PMM
    case MZ2_CARRIER_MACHINEGUN_R2: // PMM
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;

      CL_ParticleEffect(origin, vec3_origin, 0, 40);
      CL_SmokeAndFlash(origin);
      break;

    // ======
    // ROGUE
    case MZ2_STALKER_BLASTER:
    case MZ2_DAEDALUS_BLASTER:
    case MZ2_MEDIC_BLASTER_2:
    case MZ2_WIDOW_BLASTER:
    case MZ2_WIDOW_BLASTER_SWEEP1:
    case MZ2_WIDOW_BLASTER_SWEEP2:
    case MZ2_WIDOW_BLASTER_SWEEP3:
    case MZ2_WIDOW_BLASTER_SWEEP4:
    case MZ2_WIDOW_BLASTER_SWEEP5:
    case MZ2_WIDOW_BLASTER_SWEEP6:
    case MZ2_WIDOW_BLASTER_SWEEP7:
    case MZ2_WIDOW_BLASTER_SWEEP8:
    case MZ2_WIDOW_BLASTER_SWEEP9:
    case MZ2_WIDOW_BLASTER_100:
    case MZ2_WIDOW_BLASTER_90:
    case MZ2_WIDOW_BLASTER_80:
    case MZ2_WIDOW_BLASTER_70:
    case MZ2_WIDOW_BLASTER_60:
    case MZ2_WIDOW_BLASTER_50:
    case MZ2_WIDOW_BLASTER_40:
    case MZ2_WIDOW_BLASTER_30:
    case MZ2_WIDOW_BLASTER_20:
    case MZ2_WIDOW_BLASTER_10:
    case MZ2_WIDOW_BLASTER_0:
    case MZ2_WIDOW_BLASTER_10L:
    case MZ2_WIDOW_BLASTER_20L:
    case MZ2_WIDOW_BLASTER_30L:
    case MZ2_WIDOW_BLASTER_40L:
    case MZ2_WIDOW_BLASTER_50L:
    case MZ2_WIDOW_BLASTER_60L:
    case MZ2_WIDOW_BLASTER_70L:
    case MZ2_WIDOW_RUN_1:
    case MZ2_WIDOW_RUN_2:
    case MZ2_WIDOW_RUN_3:
    case MZ2_WIDOW_RUN_4:
    case MZ2_WIDOW_RUN_5:
    case MZ2_WIDOW_RUN_6:
    case MZ2_WIDOW_RUN_7:
    case MZ2_WIDOW_RUN_8:
      dl.color[0] = 0;
      dl.color[1] = 1;
      dl.color[2] = 0;
      S_StartSound(null, ent, CHAN_WEAPON, S_RegisterSound("tank/tnkatck3.wav"), 1, ATTN_NORM, 0);
      break;

    case MZ2_WIDOW_DISRUPTOR:
      dl.color[0] = -1;
      dl.color[1] = -1;
      dl.color[2] = -1;
      S_StartSound(null, ent, CHAN_WEAPON, S_RegisterSound("weapons/disint2.wav"), 1, ATTN_NORM, 0);
      break;

    case MZ2_WIDOW_PLASMABEAM:
    case MZ2_WIDOW2_BEAMER_1:
    case MZ2_WIDOW2_BEAMER_2:
    case MZ2_WIDOW2_BEAMER_3:
    case MZ2_WIDOW2_BEAMER_4:
    case MZ2_WIDOW2_BEAMER_5:
    case MZ2_WIDOW2_BEAM_SWEEP_1:
    case MZ2_WIDOW2_BEAM_SWEEP_2:
    case MZ2_WIDOW2_BEAM_SWEEP_3:
    case MZ2_WIDOW2_BEAM_SWEEP_4:
    case MZ2_WIDOW2_BEAM_SWEEP_5:
    case MZ2_WIDOW2_BEAM_SWEEP_6:
    case MZ2_WIDOW2_BEAM_SWEEP_7:
    case MZ2_WIDOW2_BEAM_SWEEP_8:
    case MZ2_WIDOW2_BEAM_SWEEP_9:
    case MZ2_WIDOW2_BEAM_SWEEP_10:
    case MZ2_WIDOW2_BEAM_SWEEP_11:
      dl.radius = 300 + (rand() & 100);
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 0;
      dl.die = cl.time + 200;
      break;
    // ROGUE
    // ======

    // --- Xian's shit ends ---
  }
}

export function CL_AddDLights(): void {
  // PORTING.md drops the ref_gl branch (ref_gl/ is not ported); the
  // software-renderer branch (negative-color clamp) is the one faithful
  // path left, matching the `else` arm of `if (vidref_val == VIDREF_GL)`.
  // Reported deviation: `vidref_val`/VIDREF_GL selection dropped since no
  // GL renderer exists to select in this port.
  for (const dl of cl_dlights) {
    if (!dl.radius) continue;

    // negative light in software. only black allowed
    if (dl.color[0] < 0 || dl.color[1] < 0 || dl.color[2] < 0) {
      dl.radius = -dl.radius;
      dl.color[0] = 1;
      dl.color[1] = 1;
      dl.color[2] = 1;
    }
    V_AddLight(dl.origin, dl.radius, dl.color[0], dl.color[1], dl.color[2]);
  }
}

//==============================================================
//
// PARTICLE MANAGEMENT
//
//==============================================================

const particles: CparticleT[] = Array.from({ length: MAX_PARTICLES }, () => new CparticleT());
const cl_numparticles = MAX_PARTICLES;

// C's particleList.active/particleList.free have external linkage (not `static`),
// so cl_newfx.c and cl_tent.c splice nodes into/out of these same lists via
// `extern cparticle_t *particleList.active, *particleList.free;`. A plain `let`
// export would only expose a snapshot (ES module bindings can't be
// reassigned by importers), so the pair is grouped into a holder object per
// PORTING.md's "C globals that are reassigned pointers... become fields on
// their owning singleton or a small exported holder object" -- mirrors
// `g_edicts`/`currentmove`'s treatment.
class ParticleListT {
  free: CparticleT | null = null;
  active: CparticleT | null = null;
}
export const particleList = new ParticleListT();

export function CL_ClearParticles(): void {
  particleList.free = particles[0];
  particleList.active = null;

  for (let i = 0; i < cl_numparticles; i++) {
    particles[i].next = i + 1 < cl_numparticles ? particles[i + 1] : null;
  }
  particles[cl_numparticles - 1].next = null;
}

export function CL_ParticleEffect(org: Vec3, dir: Vec3, color: number, count: number): void {
  for (let i = 0; i < count; i++) {
    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    p.time = cl.time;
    p.color = color + (rand() & 7);

    const d = rand() & 31;
    for (let j = 0; j < 3; j++) {
      p.org[j] = org[j] + ((rand() & 7) - 4) + d * dir[j];
      p.vel[j] = crand() * 20;
    }

    p.accel[0] = p.accel[1] = 0;
    p.accel[2] = -PARTICLE_GRAVITY;
    p.alpha = 1.0;

    p.alphavel = -1.0 / (0.5 + frand() * 0.3);
  }
}

export function CL_ParticleEffect2(org: Vec3, dir: Vec3, color: number, count: number): void {
  for (let i = 0; i < count; i++) {
    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    p.time = cl.time;
    p.color = color;

    const d = rand() & 7;
    for (let j = 0; j < 3; j++) {
      p.org[j] = org[j] + ((rand() & 7) - 4) + d * dir[j];
      p.vel[j] = crand() * 20;
    }

    p.accel[0] = p.accel[1] = 0;
    p.accel[2] = -PARTICLE_GRAVITY;
    p.alpha = 1.0;

    p.alphavel = -1.0 / (0.5 + frand() * 0.3);
  }
}

// RAFAEL
export function CL_ParticleEffect3(org: Vec3, dir: Vec3, color: number, count: number): void {
  for (let i = 0; i < count; i++) {
    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    p.time = cl.time;
    p.color = color;

    const d = rand() & 7;
    for (let j = 0; j < 3; j++) {
      p.org[j] = org[j] + ((rand() & 7) - 4) + d * dir[j];
      p.vel[j] = crand() * 20;
    }

    p.accel[0] = p.accel[1] = 0;
    p.accel[2] = PARTICLE_GRAVITY;
    p.alpha = 1.0;

    p.alphavel = -1.0 / (0.5 + frand() * 0.3);
  }
}

export function CL_TeleporterParticles(ent: EntityStateT): void {
  for (let i = 0; i < 8; i++) {
    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    p.time = cl.time;
    p.color = 0xdb;

    for (let j = 0; j < 2; j++) {
      p.org[j] = ent.origin[j] - 16 + (rand() & 31);
      p.vel[j] = crand() * 14;
    }

    p.org[2] = ent.origin[2] - 8 + (rand() & 7);
    p.vel[2] = 80 + (rand() & 7);

    p.accel[0] = p.accel[1] = 0;
    p.accel[2] = -PARTICLE_GRAVITY;
    p.alpha = 1.0;

    p.alphavel = -0.5;
  }
}

export function CL_LogoutEffect(org: Vec3, type: number): void {
  for (let i = 0; i < 500; i++) {
    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    p.time = cl.time;

    if (type === MZ_LOGIN) p.color = 0xd0 + (rand() & 7); // green
    else if (type === MZ_LOGOUT) p.color = 0x40 + (rand() & 7); // red
    else p.color = 0xe0 + (rand() & 7); // yellow

    p.org[0] = org[0] - 16 + frand() * 32;
    p.org[1] = org[1] - 16 + frand() * 32;
    p.org[2] = org[2] - 24 + frand() * 56;

    for (let j = 0; j < 3; j++) p.vel[j] = crand() * 20;

    p.accel[0] = p.accel[1] = 0;
    p.accel[2] = -PARTICLE_GRAVITY;
    p.alpha = 1.0;

    p.alphavel = -1.0 / (1.0 + frand() * 0.3);
  }
}

export function CL_ItemRespawnParticles(org: Vec3): void {
  for (let i = 0; i < 64; i++) {
    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    p.time = cl.time;

    p.color = 0xd4 + (rand() & 3); // green

    p.org[0] = org[0] + crand() * 8;
    p.org[1] = org[1] + crand() * 8;
    p.org[2] = org[2] + crand() * 8;

    for (let j = 0; j < 3; j++) p.vel[j] = crand() * 8;

    p.accel[0] = p.accel[1] = 0;
    p.accel[2] = -PARTICLE_GRAVITY * 0.2;
    p.alpha = 1.0;

    p.alphavel = -1.0 / (1.0 + frand() * 0.3);
  }
}

export function CL_ExplosionParticles(org: Vec3): void {
  for (let i = 0; i < 256; i++) {
    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    p.time = cl.time;
    p.color = 0xe0 + (rand() & 7);

    for (let j = 0; j < 3; j++) {
      p.org[j] = org[j] + ((rand() % 32) - 16);
      p.vel[j] = (rand() % 384) - 192;
    }

    p.accel[0] = p.accel[1] = 0;
    p.accel[2] = -PARTICLE_GRAVITY;
    p.alpha = 1.0;

    p.alphavel = -0.8 / (0.5 + frand() * 0.3);
  }
}

const bigTeleportColortable = fixedLength("bigTeleportColortable", 4, [2 * 8, 13 * 8, 21 * 8, 18 * 8]);

export function CL_BigTeleportParticles(org: Vec3): void {
  for (let i = 0; i < 4096; i++) {
    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    p.time = cl.time;

    p.color = bigTeleportColortable[rand() & 3];

    const angle = Math.PI * 2 * ((rand() & 1023) / 1023.0);
    const dist = rand() & 31;
    p.org[0] = org[0] + Math.cos(angle) * dist;
    p.vel[0] = Math.cos(angle) * (70 + (rand() & 63));
    p.accel[0] = -Math.cos(angle) * 100;

    p.org[1] = org[1] + Math.sin(angle) * dist;
    p.vel[1] = Math.sin(angle) * (70 + (rand() & 63));
    p.accel[1] = -Math.sin(angle) * 100;

    p.org[2] = org[2] + 8 + (rand() % 90);
    p.vel[2] = -100 + (rand() & 31);
    p.accel[2] = PARTICLE_GRAVITY * 4;
    p.alpha = 1.0;

    p.alphavel = -0.3 / (0.5 + frand() * 0.3);
  }
}

export function CL_BlasterParticles(org: Vec3, dir: Vec3): void {
  const count = 40;
  for (let i = 0; i < count; i++) {
    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    p.time = cl.time;
    p.color = 0xe0 + (rand() & 7);

    const d = rand() & 15;
    for (let j = 0; j < 3; j++) {
      p.org[j] = org[j] + ((rand() & 7) - 4) + d * dir[j];
      p.vel[j] = dir[j] * 30 + crand() * 40;
    }

    p.accel[0] = p.accel[1] = 0;
    p.accel[2] = -PARTICLE_GRAVITY;
    p.alpha = 1.0;

    p.alphavel = -1.0 / (0.5 + frand() * 0.3);
  }
}

export function CL_BlasterTrail(start: Vec3, end: Vec3): void {
  const move = vec3();
  VectorCopy(start, move);
  const vec = vec3();
  VectorSubtract(end, start, vec);
  let len = VectorNormalize(vec);

  const dec = 5;
  VectorScale(vec, 5, vec);

  // FIXME: this is a really silly way to have a loop
  while (len > 0) {
    len -= dec;

    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;
    VectorClear(p.accel);

    p.time = cl.time;

    p.alpha = 1.0;
    p.alphavel = -1.0 / (0.3 + frand() * 0.2);
    p.color = 0xe0;
    for (let j = 0; j < 3; j++) {
      p.org[j] = move[j] + crand();
      p.vel[j] = crand() * 5;
      p.accel[j] = 0;
    }

    VectorAdd(move, vec, move);
  }
}

export function CL_QuadTrail(start: Vec3, end: Vec3): void {
  const move = vec3();
  VectorCopy(start, move);
  const vec = vec3();
  VectorSubtract(end, start, vec);
  let len = VectorNormalize(vec);

  const dec = 5;
  VectorScale(vec, 5, vec);

  while (len > 0) {
    len -= dec;

    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;
    VectorClear(p.accel);

    p.time = cl.time;

    p.alpha = 1.0;
    p.alphavel = -1.0 / (0.8 + frand() * 0.2);
    p.color = 115;
    for (let j = 0; j < 3; j++) {
      p.org[j] = move[j] + crand() * 16;
      p.vel[j] = crand() * 5;
      p.accel[j] = 0;
    }

    VectorAdd(move, vec, move);
  }
}

export function CL_FlagTrail(start: Vec3, end: Vec3, color: number): void {
  const move = vec3();
  VectorCopy(start, move);
  const vec = vec3();
  VectorSubtract(end, start, vec);
  let len = VectorNormalize(vec);

  const dec = 5;
  VectorScale(vec, 5, vec);

  while (len > 0) {
    len -= dec;

    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;
    VectorClear(p.accel);

    p.time = cl.time;

    p.alpha = 1.0;
    p.alphavel = -1.0 / (0.8 + frand() * 0.2);
    p.color = color;
    for (let j = 0; j < 3; j++) {
      p.org[j] = move[j] + crand() * 16;
      p.vel[j] = crand() * 5;
      p.accel[j] = 0;
    }

    VectorAdd(move, vec, move);
  }
}

export function CL_DiminishingTrail(start: Vec3, end: Vec3, old: CentityT, flags: number): void {
  const move = vec3();
  VectorCopy(start, move);
  const vec = vec3();
  VectorSubtract(end, start, vec);
  let len = VectorNormalize(vec);

  const dec = 0.5;
  VectorScale(vec, dec, vec);

  let orgscale: number;
  let velscale: number;
  if (old.trailcount > 900) {
    orgscale = 4;
    velscale = 15;
  } else if (old.trailcount > 800) {
    orgscale = 2;
    velscale = 10;
  } else {
    orgscale = 1;
    velscale = 5;
  }

  while (len > 0) {
    len -= dec;

    if (!particleList.free) return;

    // drop less particles as it flies
    if ((rand() & 1023) < old.trailcount) {
      const p = particleList.free;
      particleList.free = p.next;
      p.next = particleList.active;
      particleList.active = p;
      VectorClear(p.accel);

      p.time = cl.time;

      if (flags & EF_GIB) {
        p.alpha = 1.0;
        p.alphavel = -1.0 / (1 + frand() * 0.4);
        p.color = 0xe8 + (rand() & 7);
        for (let j = 0; j < 3; j++) {
          p.org[j] = move[j] + crand() * orgscale;
          p.vel[j] = crand() * velscale;
          p.accel[j] = 0;
        }
        p.vel[2] -= PARTICLE_GRAVITY;
      } else if (flags & EF_GREENGIB) {
        p.alpha = 1.0;
        p.alphavel = -1.0 / (1 + frand() * 0.4);
        p.color = 0xdb + (rand() & 7);
        for (let j = 0; j < 3; j++) {
          p.org[j] = move[j] + crand() * orgscale;
          p.vel[j] = crand() * velscale;
          p.accel[j] = 0;
        }
        p.vel[2] -= PARTICLE_GRAVITY;
      } else {
        p.alpha = 1.0;
        p.alphavel = -1.0 / (1 + frand() * 0.2);
        p.color = 4 + (rand() & 7);
        for (let j = 0; j < 3; j++) {
          p.org[j] = move[j] + crand() * orgscale;
          p.vel[j] = crand() * velscale;
        }
        p.accel[2] = 20;
      }
    }

    old.trailcount -= 5;
    if (old.trailcount < 100) old.trailcount = 100;
    VectorAdd(move, vec, move);
  }
}

export function MakeNormalVectors(forward: Vec3, right: Vec3, up: Vec3): void {
  // this rotate and negat guarantees a vector
  // not colinear with the original
  right[1] = -forward[0];
  right[2] = forward[1];
  right[0] = forward[2];

  const d = DotProduct(right, forward);
  VectorMA(right, -d, forward, right);
  VectorNormalize(right);
  CrossProduct(right, forward, up);
}

export function CL_RocketTrail(start: Vec3, end: Vec3, old: CentityT): void {
  // smoke
  CL_DiminishingTrail(start, end, old, EF_ROCKET);

  // fire
  const move = vec3();
  VectorCopy(start, move);
  const vec = vec3();
  VectorSubtract(end, start, vec);
  let len = VectorNormalize(vec);

  const dec = 1;
  VectorScale(vec, dec, vec);

  while (len > 0) {
    len -= dec;

    if (!particleList.free) return;

    if ((rand() & 7) === 0) {
      const p = particleList.free;
      particleList.free = p.next;
      p.next = particleList.active;
      particleList.active = p;

      VectorClear(p.accel);
      p.time = cl.time;

      p.alpha = 1.0;
      p.alphavel = -1.0 / (1 + frand() * 0.2);
      p.color = 0xdc + (rand() & 3);
      for (let j = 0; j < 3; j++) {
        p.org[j] = move[j] + crand() * 5;
        p.vel[j] = crand() * 20;
      }
      p.accel[2] = -PARTICLE_GRAVITY;
    }
    VectorAdd(move, vec, move);
  }
}

export function CL_RailTrail(start: Vec3, end: Vec3): void {
  const move = vec3();
  VectorCopy(start, move);
  const vec = vec3();
  VectorSubtract(end, start, vec);
  const len = VectorNormalize(vec);

  const right = vec3();
  const up = vec3();
  MakeNormalVectors(vec, right, up);

  const clr = 0x74;

  for (let i = 0; i < len; i++) {
    if (!particleList.free) return;

    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    p.time = cl.time;
    VectorClear(p.accel);

    const d = i * 0.1;
    const c = Math.cos(d);
    const s = Math.sin(d);

    const dir = vec3();
    VectorScale(right, c, dir);
    VectorMA(dir, s, up, dir);

    p.alpha = 1.0;
    p.alphavel = -1.0 / (1 + frand() * 0.2);
    p.color = clr + (rand() & 7);
    for (let j = 0; j < 3; j++) {
      p.org[j] = move[j] + dir[j] * 3;
      p.vel[j] = dir[j] * 6;
    }

    VectorAdd(move, vec, move);
  }

  const dec = 0.75;
  VectorScale(vec, dec, vec);
  VectorCopy(start, move);

  let remaining = len;
  while (remaining > 0) {
    remaining -= dec;

    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    p.time = cl.time;
    VectorClear(p.accel);

    p.alpha = 1.0;
    p.alphavel = -1.0 / (0.6 + frand() * 0.2);
    p.color = 0x0 + (rand() & 15);

    for (let j = 0; j < 3; j++) {
      p.org[j] = move[j] + crand() * 3;
      p.vel[j] = crand() * 3;
      p.accel[j] = 0;
    }

    VectorAdd(move, vec, move);
  }
}

// RAFAEL
export function CL_IonripperTrail(start: Vec3, ent: Vec3): void {
  const move = vec3();
  VectorCopy(start, move);
  const vec = vec3();
  VectorSubtract(ent, start, vec);
  let len = VectorNormalize(vec);

  const dec = 5;
  VectorScale(vec, 5, vec);

  let left = 0;

  while (len > 0) {
    len -= dec;

    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;
    VectorClear(p.accel);

    p.time = cl.time;
    p.alpha = 0.5;
    p.alphavel = -1.0 / (0.3 + frand() * 0.2);
    p.color = 0xe4 + (rand() & 3);

    for (let j = 0; j < 3; j++) {
      p.org[j] = move[j];
      p.accel[j] = 0;
    }
    if (left) {
      left = 0;
      p.vel[0] = 10;
    } else {
      left = 1;
      p.vel[0] = -10;
    }

    p.vel[1] = 0;
    p.vel[2] = 0;

    VectorAdd(move, vec, move);
  }
}

export function CL_BubbleTrail(start: Vec3, end: Vec3): void {
  const move = vec3();
  VectorCopy(start, move);
  const vec = vec3();
  VectorSubtract(end, start, vec);
  const len = VectorNormalize(vec);

  const dec = 32;
  VectorScale(vec, dec, vec);

  for (let i = 0; i < len; i += dec) {
    if (!particleList.free) return;

    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    VectorClear(p.accel);
    p.time = cl.time;

    p.alpha = 1.0;
    p.alphavel = -1.0 / (1 + frand() * 0.2);
    p.color = 4 + (rand() & 7);
    for (let j = 0; j < 3; j++) {
      p.org[j] = move[j] + crand() * 2;
      p.vel[j] = crand() * 5;
    }
    p.vel[2] += 6;

    VectorAdd(move, vec, move);
  }
}

const BEAMLENGTH = 16;
const avelocities: Vec3[] = Array.from({ length: NUMVERTEXNORMALS }, () => vec3());

export function CL_FlyParticles(origin: Vec3, countIn: number): void {
  let count = countIn;
  if (count > NUMVERTEXNORMALS) count = NUMVERTEXNORMALS;

  if (!avelocities[0][0]) {
    for (let i = 0; i < NUMVERTEXNORMALS; i++) {
      for (let k = 0; k < 3; k++) avelocities[i][k] = (rand() & 255) * 0.01;
    }
  }

  const ltime = cl.time / 1000.0;
  for (let i = 0; i < count; i += 2) {
    let angle = ltime * avelocities[i][0];
    const sy = Math.sin(angle);
    const cy = Math.cos(angle);
    angle = ltime * avelocities[i][1];
    const sp = Math.sin(angle);
    const cp = Math.cos(angle);

    const forward = vec3();
    forward[0] = cp * cy;
    forward[1] = cp * sy;
    forward[2] = -sp;

    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    p.time = cl.time;

    const dist = Math.sin(ltime + i) * 64;
    p.org[0] = origin[0] + bytedirs[i][0] * dist + forward[0] * BEAMLENGTH;
    p.org[1] = origin[1] + bytedirs[i][1] * dist + forward[1] * BEAMLENGTH;
    p.org[2] = origin[2] + bytedirs[i][2] * dist + forward[2] * BEAMLENGTH;

    VectorClear(p.vel);
    VectorClear(p.accel);

    p.color = 0;
    p.colorvel = 0;

    p.alpha = 1;
    p.alphavel = -100;
  }
}

export function CL_FlyEffect(ent: CentityT, origin: Vec3): void {
  let starttime: number;
  if (ent.fly_stoptime < cl.time) {
    starttime = cl.time;
    ent.fly_stoptime = cl.time + 60000;
  } else {
    starttime = ent.fly_stoptime - 60000;
  }

  let n = cl.time - starttime;
  let count: number;
  if (n < 20000) {
    count = (n * 162) / 20000.0;
  } else {
    n = ent.fly_stoptime - cl.time;
    if (n < 20000) count = (n * 162) / 20000.0;
    else count = 162;
  }

  CL_FlyParticles(origin, count);
}

export function CL_BfgParticles(ent: EntityT): void {
  if (!avelocities[0][0]) {
    for (let i = 0; i < NUMVERTEXNORMALS; i++) {
      for (let k = 0; k < 3; k++) avelocities[i][k] = (rand() & 255) * 0.01;
    }
  }

  const ltime = cl.time / 1000.0;
  for (let i = 0; i < NUMVERTEXNORMALS; i++) {
    let angle = ltime * avelocities[i][0];
    const sy = Math.sin(angle);
    const cy = Math.cos(angle);
    angle = ltime * avelocities[i][1];
    const sp = Math.sin(angle);
    const cp = Math.cos(angle);

    const forward = vec3();
    forward[0] = cp * cy;
    forward[1] = cp * sy;
    forward[2] = -sp;

    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    p.time = cl.time;

    let dist = Math.sin(ltime + i) * 64;
    p.org[0] = ent.origin[0] + bytedirs[i][0] * dist + forward[0] * BEAMLENGTH;
    p.org[1] = ent.origin[1] + bytedirs[i][1] * dist + forward[1] * BEAMLENGTH;
    p.org[2] = ent.origin[2] + bytedirs[i][2] * dist + forward[2] * BEAMLENGTH;

    VectorClear(p.vel);
    VectorClear(p.accel);

    const v = vec3();
    VectorSubtract(p.org, ent.origin, v);
    dist = VectorLength(v) / 90.0;
    p.color = Math.floor(0xd0 + dist * 7);
    p.colorvel = 0;

    p.alpha = 1.0 - dist;
    p.alphavel = -100;
  }
}

// RAFAEL
export function CL_TrapParticles(ent: EntityT): void {
  ent.origin[2] -= 14;
  const start = vec3();
  VectorCopy(ent.origin, start);
  const end = vec3();
  VectorCopy(ent.origin, end);
  end[2] += 64;

  const move = vec3();
  VectorCopy(start, move);
  const vec = vec3();
  VectorSubtract(end, start, vec);
  let len = VectorNormalize(vec);

  const dec = 5;
  VectorScale(vec, 5, vec);

  // FIXME: this is a really silly way to have a loop
  while (len > 0) {
    len -= dec;

    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;
    VectorClear(p.accel);

    p.time = cl.time;

    p.alpha = 1.0;
    p.alphavel = -1.0 / (0.3 + frand() * 0.2);
    p.color = 0xe0;
    for (let j = 0; j < 3; j++) {
      p.org[j] = move[j] + crand();
      p.vel[j] = crand() * 15;
      p.accel[j] = 0;
    }
    p.accel[2] = PARTICLE_GRAVITY;

    VectorAdd(move, vec, move);
  }

  ent.origin[2] += 14;
  const org = vec3();
  VectorCopy(ent.origin, org);

  for (let i = -2; i <= 2; i += 4) {
    for (let j = -2; j <= 2; j += 4) {
      for (let k = -2; k <= 4; k += 4) {
        if (!particleList.free) return;
        const p = particleList.free;
        particleList.free = p.next;
        p.next = particleList.active;
        particleList.active = p;

        p.time = cl.time;
        p.color = 0xe0 + (rand() & 3);

        p.alpha = 1.0;
        p.alphavel = -1.0 / (0.3 + (rand() & 7) * 0.02);

        p.org[0] = org[0] + i + (rand() & 23) * crand();
        p.org[1] = org[1] + j + (rand() & 23) * crand();
        p.org[2] = org[2] + k + (rand() & 23) * crand();

        const dir = vec3();
        dir[0] = j * 8;
        dir[1] = i * 8;
        dir[2] = k * 8;

        VectorNormalize(dir);
        const vel = 50 + (rand() & 63);
        VectorScale(dir, vel, p.vel);

        p.accel[0] = p.accel[1] = 0;
        p.accel[2] = -PARTICLE_GRAVITY;
      }
    }
  }
}

// FIXME combined with CL_ExplosionParticles
export function CL_BFGExplosionParticles(org: Vec3): void {
  for (let i = 0; i < 256; i++) {
    if (!particleList.free) return;
    const p = particleList.free;
    particleList.free = p.next;
    p.next = particleList.active;
    particleList.active = p;

    p.time = cl.time;
    p.color = 0xd0 + (rand() & 7);

    for (let j = 0; j < 3; j++) {
      p.org[j] = org[j] + ((rand() % 32) - 16);
      p.vel[j] = (rand() % 384) - 192;
    }

    p.accel[0] = p.accel[1] = 0;
    p.accel[2] = -PARTICLE_GRAVITY;
    p.alpha = 1.0;

    p.alphavel = -0.8 / (0.5 + frand() * 0.3);
  }
}

export function CL_TeleportParticles(org: Vec3): void {
  for (let i = -16; i <= 16; i += 4) {
    for (let j = -16; j <= 16; j += 4) {
      for (let k = -16; k <= 32; k += 4) {
        if (!particleList.free) return;
        const p = particleList.free;
        particleList.free = p.next;
        p.next = particleList.active;
        particleList.active = p;

        p.time = cl.time;
        p.color = 7 + (rand() & 7);

        p.alpha = 1.0;
        p.alphavel = -1.0 / (0.3 + (rand() & 7) * 0.02);

        p.org[0] = org[0] + i + (rand() & 3);
        p.org[1] = org[1] + j + (rand() & 3);
        p.org[2] = org[2] + k + (rand() & 3);

        const dir = vec3();
        dir[0] = j * 8;
        dir[1] = i * 8;
        dir[2] = k * 8;

        VectorNormalize(dir);
        const vel = 50 + (rand() & 63);
        VectorScale(dir, vel, p.vel);

        p.accel[0] = p.accel[1] = 0;
        p.accel[2] = -PARTICLE_GRAVITY;
      }
    }
  }
}

export function CL_AddParticles(): void {
  let active: CparticleT | null = null;
  let tail: CparticleT | null = null;

  let p = particleList.active;
  while (p) {
    const next = p.next;

    let alpha: number;
    let time = 0;

    // PMM - added INSTANT_PARTICLE handling for heat beam
    if (p.alphavel !== INSTANT_PARTICLE) {
      time = (cl.time - p.time) * 0.001;
      alpha = p.alpha + time * p.alphavel;
      if (alpha <= 0) {
        // faded out
        p.next = particleList.free;
        particleList.free = p;
        p = next;
        continue;
      }
    } else {
      alpha = p.alpha;
    }

    p.next = null;
    if (!tail) {
      active = tail = p;
    } else {
      tail.next = p;
      tail = p;
    }

    if (alpha > 1.0) alpha = 1;
    const color = p.color;

    const time2 = time * time;

    const org = vec3();
    org[0] = p.org[0] + p.vel[0] * time + p.accel[0] * time2;
    org[1] = p.org[1] + p.vel[1] * time + p.accel[1] * time2;
    org[2] = p.org[2] + p.vel[2] * time + p.accel[2] * time2;

    V_AddParticle(org, color, alpha);
    // PMM
    if (p.alphavel === INSTANT_PARTICLE) {
      p.alphavel = 0.0;
      p.alpha = 0.0;
    }

    p = next;
  }

  particleList.active = active;
}

export function CL_EntityEvent(ent: EntityStateT): void {
  switch (ent.event) {
    case EntityEventT.EV_ITEM_RESPAWN:
      S_StartSound(null, ent.number, CHAN_WEAPON, S_RegisterSound("items/respawn1.wav"), 1, ATTN_IDLE, 0);
      CL_ItemRespawnParticles(ent.origin);
      break;
    case EntityEventT.EV_PLAYER_TELEPORT:
      S_StartSound(null, ent.number, CHAN_WEAPON, S_RegisterSound("misc/tele1.wav"), 1, ATTN_IDLE, 0);
      CL_TeleportParticles(ent.origin);
      break;
    case EntityEventT.EV_FOOTSTEP:
      if (clCvars.cl_footsteps && clCvars.cl_footsteps.value) {
        S_StartSound(null, ent.number, CHAN_BODY, cl_sfx_footsteps[rand() & 3], 1, ATTN_NORM, 0);
      }
      break;
    case EntityEventT.EV_FALLSHORT:
      S_StartSound(null, ent.number, CHAN_AUTO, S_RegisterSound("player/land1.wav"), 1, ATTN_NORM, 0);
      break;
    case EntityEventT.EV_FALL:
      S_StartSound(null, ent.number, CHAN_AUTO, S_RegisterSound("*fall2.wav"), 1, ATTN_NORM, 0);
      break;
    case EntityEventT.EV_FALLFAR:
      S_StartSound(null, ent.number, CHAN_AUTO, S_RegisterSound("*fall1.wav"), 1, ATTN_NORM, 0);
      break;
  }
}

export function CL_ClearEffects(): void {
  CL_ClearParticles();
  CL_ClearDlights();
  CL_ClearLightStyles();
}

