// cl_tent.c -- client side temporary entities

import { fixedLength } from "../shared/fixed";
import {
  type Vec3,
  vec3,
  vec3_origin,
  VectorCopy,
  VectorSubtract,
  VectorAdd,
  VectorMA,
  VectorScale,
  VectorNormalize,
  VectorLength,
  VectorCompare,
  AngleVectors,
} from "../shared/math";
import { frand, crand } from "../qcommon/common";
import {
  TempEventT,
  SPLASH_SPARKS,
  RF_TRANSLUCENT,
  RF_FULLBRIGHT,
  RF_NOSHADOW,
  RF_BEAM,
  CHAN_WEAPON,
  CHAN_FOOTSTEP,
  ATTN_NORM,
  ATTN_NONE,
  ATTN_IDLE,
  ATTN_STATIC,
  ERR_DROP,
  Q_stricmp,
  MASK_SOLID,
  MASK_WATER,
  type CvarT,
} from "../shared/q_shared";
import { Com_Printf } from "../qcommon/common";
import { ComError, UPDATE_MASK } from "../qcommon/qcommon";
import { MSG_ReadByte, MSG_ReadShort, MSG_ReadLong, MSG_ReadPos, MSG_ReadDir } from "../qcommon/sizebuf";
import { cl, net_message, re, cl_entities, clCvars, ClSustainT, MAX_SUSTAINS } from "./client";
import { type ModelS, type ImageS, EntityT, MAX_ENTITIES } from "./ref";
import { V_AddEntity, V_AddLight } from "./cl_view";
import { S_StartSound, S_RegisterSound } from "./snd_dma";
import type { SfxT } from "./snd_loc";
import { CM_BoxTrace, CM_NumTexinfo, CM_TexinfoMaterial } from "../qcommon/cmodel";
import { FS_FOpenFile, FS_FCloseFile } from "../qcommon/files";
import {
  CL_Flashlight,
  CL_ColorFlash,
  CL_ForceWall,
  CL_ParticleSteamEffect,
  CL_ParticleSteamEffect2,
  CL_BubbleTrail2,
  CL_Heatbeam,
  CL_MonsterPlasma_Shell,
  CL_ColorExplosionParticles,
  CL_ParticleSmokeEffect,
  CL_BlasterParticles2,
  CL_Widowbeamout,
  CL_Nukeblast,
  CL_WidowSplash,
  CL_DebugTrail,
} from "./cl_newfx";

// cl_fx.ts and cl_tent.ts close a value cycle (cl_fx.c's CL_ParseMuzzleFlash2
// calls cl_tent.c's CL_SmokeAndFlash; cl_tent.c's CL_ParseTEnt calls cl_fx.c's
// particle-effect family). Per PORTING.md's import-cycle rule, the module on
// the less-fundamental side (this one -- cl_tent.c orchestrates temp-entity
// parsing on top of cl_fx.c's lower-level particle system) drops the static
// import and resolves lazily via Bun's synchronous require().
import type * as ClFxModule from "./cl_fx";
function clFxMod(): typeof ClFxModule {
  return require("./cl_fx");
}

const {
  TE_BLOOD,
  TE_GUNSHOT,
  TE_SPARKS,
  TE_BULLET_SPARKS,
  TE_SCREEN_SPARKS,
  TE_SHIELD_SPARKS,
  TE_SHOTGUN,
  TE_SPLASH,
  TE_LASER_SPARKS,
  TE_BLUEHYPERBLASTER,
  TE_BLASTER,
  TE_RAILTRAIL,
  TE_EXPLOSION2,
  TE_GRENADE_EXPLOSION,
  TE_GRENADE_EXPLOSION_WATER,
  TE_PLASMA_EXPLOSION,
  TE_EXPLOSION1,
  TE_EXPLOSION1_BIG,
  TE_ROCKET_EXPLOSION,
  TE_ROCKET_EXPLOSION_WATER,
  TE_EXPLOSION1_NP,
  TE_BFG_EXPLOSION,
  TE_BFG_BIGEXPLOSION,
  TE_BFG_LASER,
  TE_BUBBLETRAIL,
  TE_PARASITE_ATTACK,
  TE_MEDIC_CABLE_ATTACK,
  TE_BOSSTPORT,
  TE_GRAPPLE_CABLE,
  TE_WELDING_SPARKS,
  TE_GREENBLOOD,
  TE_TUNNEL_SPARKS,
  TE_BLASTER2,
  TE_FLECHETTE,
  TE_LIGHTNING,
  TE_DEBUGTRAIL,
  TE_PLAIN_EXPLOSION,
  TE_FLASHLIGHT,
  TE_FORCEWALL,
  TE_HEATBEAM,
  TE_MONSTER_HEATBEAM,
  TE_HEATBEAM_SPARKS,
  TE_HEATBEAM_STEAM,
  TE_STEAM,
  TE_BUBBLETRAIL2,
  TE_MOREBLOOD,
  TE_CHAINFIST_SMOKE,
  TE_ELECTRIC_SPARKS,
  TE_TRACKER_EXPLOSION,
  TE_TELEPORT_EFFECT,
  TE_DBALL_GOAL,
  TE_WIDOWBEAMOUT,
  TE_NUKEBLAST,
  TE_WIDOWSPLASH,
} = TempEventT;

export enum ExptypeT {
  ex_free,
  ex_explosion,
  ex_misc,
  ex_flash,
  ex_mflash,
  ex_poly,
  ex_poly2,
}

export class ExplosionT {
  type: ExptypeT = ExptypeT.ex_free;
  ent: EntityT = new EntityT();

  frames = 0;
  light = 0;
  lightcolor: Vec3 = vec3();
  start = 0;
  baseframe = 0;
}

const MAX_EXPLOSIONS = 32;
export const cl_explosions: ExplosionT[] = Array.from({ length: MAX_EXPLOSIONS }, () => new ExplosionT());

class BeamT {
  entity = 0;
  dest_entity = 0;
  model: ModelS | null = null;
  endtime = 0;
  offset: Vec3 = vec3();
  start: Vec3 = vec3();
  end: Vec3 = vec3();
}

const MAX_BEAMS = 32;
const cl_beams: BeamT[] = Array.from({ length: MAX_BEAMS }, () => new BeamT());
// PMM - added this for player-linked beams.  Currently only used by the plasma beam
const cl_playerbeams: BeamT[] = Array.from({ length: MAX_BEAMS }, () => new BeamT());

class LaserT {
  ent: EntityT = new EntityT();
  endtime = 0;
}

const MAX_LASERS = 32;
const cl_lasers: LaserT[] = Array.from({ length: MAX_LASERS }, () => new LaserT());

// ROGUE
const cl_sustains: ClSustainT[] = Array.from({ length: MAX_SUSTAINS }, () => new ClSustainT());
// ROGUE

export let cl_sfx_ric1: SfxT | null = null;
export let cl_sfx_ric2: SfxT | null = null;
export let cl_sfx_ric3: SfxT | null = null;
export let cl_sfx_lashit: SfxT | null = null;
export let cl_sfx_spark5: SfxT | null = null;
export let cl_sfx_spark6: SfxT | null = null;
export let cl_sfx_spark7: SfxT | null = null;
export let cl_sfx_railg: SfxT | null = null;
export let cl_sfx_rockexp: SfxT | null = null;
export let cl_sfx_grenexp: SfxT | null = null;
export let cl_sfx_watrexp: SfxT | null = null;
// RAFAEL
export let cl_sfx_plasexp: SfxT | null = null;
// [Paril-KEX] q2repro's tent.c drops the classic 4-slot cl_sfx_footsteps
// array entirely -- CL_RegisterTEntSounds (below) no longer registers
// "player/step%i.wav" directly; the material-based footstep system
// (CL_RegisterFootsteps, further down) subsumes it, registering the same
// "#sound/player/step%i.wav" set (up to MAX_FOOTSTEP_SFX, retail ships 4)
// under FOOTSTEP_ID_DEFAULT instead. EV_FOOTSTEP (cl_fx.ts's
// CL_EntityEvent) now resolves through CL_PlayFootstepSfx, matching
// entities.c:255-257 exactly.

export let cl_mod_explode: ModelS | null = null;
export let cl_mod_smoke: ModelS | null = null;
export let cl_mod_flash: ModelS | null = null;
export let cl_mod_parasite_segment: ModelS | null = null;
export let cl_mod_grapple_cable: ModelS | null = null;
export let cl_mod_parasite_tip: ModelS | null = null;
export let cl_mod_explo4: ModelS | null = null;
export let cl_mod_bfg_explo: ModelS | null = null;
export let cl_mod_powerscreen: ModelS | null = null;
// RAFAEL
export let cl_mod_plasmaexplo: ModelS | null = null;

// ROGUE
export let cl_sfx_lightning: SfxT | null = null;
export let cl_sfx_disrexp: SfxT | null = null;
export let cl_mod_lightning: ModelS | null = null;
export let cl_mod_heatbeam: ModelS | null = null;
export let cl_mod_monster_heatbeam: ModelS | null = null;
export let cl_mod_explo4_big: ModelS | null = null;
// ROGUE

// [Sam-KEX] q2repro src/client/tent.c:51 `qhandle_t cl_img_flare` -- the
// default misc_flare billboard image (baseq2/pak0.pak's misc/flare.tga),
// used by cl_ents.ts's RF_FLARE branch for every flare that does not carry
// its own RF_CUSTOMSKIN image. Registered in CL_RegisterTEntModels below,
// exactly where tent.c:322 registers it.
export let cl_img_flare: ImageS | null = null;

// [Paril-KEX] q2repro src/client/client.h:956-970's cl_muzzlefx_t -- which
// retail models/weapons/v_*/flash/tris.md2 model a given weapon's
// muzzle-flash uses. Order matches muzzlenames below exactly (both are
// read by index).
export enum MuzzlefxT {
  MFLASH_MACHN,
  MFLASH_SHOTG2,
  MFLASH_SHOTG,
  MFLASH_ROCKET,
  MFLASH_RAIL,
  MFLASH_LAUNCH,
  MFLASH_ETF_RIFLE,
  MFLASH_DIST,
  MFLASH_BOOMER,
  MFLASH_BLAST, // 0 = orange, 1 = blue, 2 = green
  MFLASH_BFG,
  MFLASH_BEAMER,
  MFLASH_TOTAL,
}
const {
  MFLASH_MACHN,
  MFLASH_SHOTG2,
  MFLASH_SHOTG,
  MFLASH_ROCKET,
  MFLASH_RAIL,
  MFLASH_LAUNCH,
  MFLASH_ETF_RIFLE,
  MFLASH_DIST,
  MFLASH_BOOMER,
  MFLASH_BLAST,
  MFLASH_BFG,
  MFLASH_BEAMER,
  MFLASH_TOTAL,
} = MuzzlefxT;

// q2repro tent.c:278-291's muzzlenames -- directory component of
// "models/weapons/%s/flash/tris.md2", indexed by MuzzlefxT.
export const muzzlenames: readonly string[] = [
  "v_machn",
  "v_shotg2",
  "v_shotg",
  "v_rocket",
  "v_rail",
  "v_launch",
  "v_etf_rifle",
  "v_dist",
  "v_boomer",
  "v_blast",
  "v_bfg",
  "v_beamer",
];

export const cl_mod_muzzles: (ModelS | null)[] = new Array(MFLASH_TOTAL).fill(null);

// [Paril-KEX] q2repro tent.c:38-73's material-based footstep system.
// FOOTSTEP_ID_DEFAULT/LADDER are reserved step_ids that never come from a
// BSP material (inc/common/bsp.h:40-44); every other id is allocated
// per-unique-material by CL_RegisterFootsteps below.
export const FOOTSTEP_ID_DEFAULT = 0;
export const FOOTSTEP_ID_LADDER = 1;
export const FOOTSTEP_RESERVED_COUNT = 2;
const MAX_FOOTSTEP_SFX = 16;
// q_shared.h's STEPSIZE -- redeclared locally, matching this codebase's
// existing per-module convention (see e.g. qcommon/pmove.ts, game/m_move.ts).
const STEPSIZE = 18;

class FootstepSfxT {
  sfx: (SfxT | null)[] = new Array(MAX_FOOTSTEP_SFX).fill(null);
  num_sfx = 0;
}

let cl_footstep_sfx: FootstepSfxT[] = [];
let cl_last_footstep: SfxT | null = null;

// `extern cvar_t *hand;` -- a client-side "which hand holds the weapon"
// cvar. Not registered anywhere in this port yet (only the game-side
// userinfo key of the same name exists, in src/game/p_client.ts, a
// different value entirely). Declared locally as a not-yet-registered
// extern, matching cl_fx.ts's `vidref_val` treatment -- reported deviation.
const hand: CvarT | null = null;

// material string -> allocated step_id, built fresh by CL_RegisterFootsteps
// every map load. Not exported: CL_FindFootstepSurface below is the only
// reader.
let cl_material_step_ids: Map<string, number> = new Map();

// resolveMaterialStepId is the read path only (used by
// CL_FindFootstepSurface); it never allocates. CL_RegisterFootsteps below
// does the one-time allocation pass over every map texinfo material.
function resolveMaterialStepId(material: string): number {
  if (!material || Q_stricmp(material, "default") === 0) return FOOTSTEP_ID_DEFAULT;
  if (Q_stricmp(material, "ladder") === 0) return FOOTSTEP_ID_LADDER;
  return cl_material_step_ids.get(material.toLowerCase()) ?? FOOTSTEP_ID_DEFAULT;
}

// Test-support accessors, same rationale as cmodel.ts's CM_NumTexinfo/
// CM_TexinfoMaterial (added purely so tests can assert on
// CL_RegisterFootsteps' result without reaching into module-private
// state): no production caller needs these, only test/cl_tent_footsteps.
export function CL_MaterialStepId(material: string): number {
  return resolveMaterialStepId(material);
}
export function CL_NumFootstepMaterials(): number {
  return cl_footstep_sfx.length;
}
export function CL_FootstepSfxCount(stepId: number): number {
  return cl_footstep_sfx[stepId]?.num_sfx ?? 0;
}

/*
=================
CL_FindFootstepSurface

[Paril-KEX] q2repro tent.c:82-148. Traces downward from the entity's
lerped origin to find which BSP surface (and therefore which material) is
underfoot, returning the step_id CL_RegisterFootsteps assigned it.

DEVIATION: q2repro's centity_t carries per-entity vec3_t mins/maxs
(decoded from the wire's packed solid bounds by entities.c's
parse_entity_update), used here as the trace's box half-extents so the
sweep covers the entity's own X/Y footprint. This port's CentityT
(client.ts) has no mins/maxs field -- decoding packed solid bounds into
per-entity state is entity-delta-parsing plumbing (cl_ents.ts, out of this
unit's territory), a real, cited gap. This trace therefore always uses a
zero-size (point) box and the C's "cover every monster" -66 fallback
offset, which is EXACTLY what the C itself does for any entity whose
solid isn't a real bbox (VectorClear(ent->mins); VectorClear(ent->maxs);
trace_end[2] -= 66) -- same code path, same result, just taken
unconditionally instead of solid-gated. The only behavioral difference
from a full port is at material BOUNDARIES under a wide entity, where a
point trace can resolve a different (adjacent) material than a box sweep
would; the common case (uniform material underfoot) is unaffected.
=================
*/
function CL_FindFootstepSurface(entnum: number): number {
  const footstep_id_default = FOOTSTEP_ID_DEFAULT;
  const cent = cl_entities[entnum];

  // skip if no materials loaded
  if (cl_footstep_sfx.length <= FOOTSTEP_RESERVED_COUNT) return footstep_id_default;

  // not in our frame so don't bother doing calculations
  if (cent.serverframe !== cl.frame.serverframe) return footstep_id_default;

  // allow custom footsteps to be disabled
  if (clCvars.cl_footsteps && clCvars.cl_footsteps.value >= 2) return footstep_id_default;

  const trace_mins = vec3(0, 0, 0);
  const trace_maxs = vec3(0, 0, 0);

  const trace_start = vec3();
  trace_start[0] = cent.prev.origin[0] + (cent.current.origin[0] - cent.prev.origin[0]) * cl.lerpfrac;
  trace_start[1] = cent.prev.origin[1] + (cent.current.origin[1] - cent.prev.origin[1]) * cl.lerpfrac;
  trace_start[2] = cent.prev.origin[2] + (cent.current.origin[2] - cent.prev.origin[2]) * cl.lerpfrac;
  trace_start[2] += 1;

  const trace_end = vec3();
  VectorCopy(trace_start, trace_end);
  trace_end[2] -= STEPSIZE / 2;
  // DEVIATION (see header comment): no per-entity mins/maxs to branch on,
  // so this always takes the C's non-bbox "cover every monster" fallback.
  trace_end[2] -= 66;

  let tr = CM_BoxTrace(trace_start, trace_end, trace_mins, trace_maxs, 0, MASK_SOLID);

  if (tr.fraction === 1.0) return footstep_id_default;

  let footstep_id = footstep_id_default;
  if (tr.surface) {
    footstep_id = resolveMaterialStepId(tr.surface.material);

    const new_end = vec3();
    VectorCopy(tr.endpos, new_end);
    new_end[2] += 1;

    tr = CM_BoxTrace(trace_start, new_end, trace_mins, trace_maxs, 0, MASK_SOLID | MASK_WATER);
    if (tr.surface) footstep_id = resolveMaterialStepId(tr.surface.material);
  }

  return footstep_id;
}

/*
=================
CL_PlayFootstepSfx

[Paril-KEX] q2repro tent.c:152-183.
=================
*/
export function CL_PlayFootstepSfx(stepIdOrNegativeOne: number, entnum: number, volume: number, attenuation: number): void {
  if (cl_footstep_sfx.length === 0) return; // should not really happen

  const step_id = stepIdOrNegativeOne === -1 ? CL_FindFootstepSurface(entnum) : stepIdOrNegativeOne;

  let sfx = cl_footstep_sfx[step_id];
  if (!sfx || !sfx.num_sfx) sfx = cl_footstep_sfx[FOOTSTEP_ID_DEFAULT] ?? null;
  if (!sfx || !sfx.num_sfx) return; // no footsteps, not even fallbacks

  // pick a random footstep sound, but avoid playing the same one twice in a row
  let sfx_num = Math.floor(clFxMod().rand() % sfx.num_sfx);
  let footstep_sfx = sfx.sfx[sfx_num];
  if (footstep_sfx === cl_last_footstep) {
    sfx_num = (sfx_num + 1) % sfx.num_sfx;
    footstep_sfx = sfx.sfx[sfx_num];
  }
  if (!footstep_sfx) return;

  S_StartSound(null, entnum, CHAN_FOOTSTEP, footstep_sfx, volume, attenuation, 0);
  cl_last_footstep = footstep_sfx;
}

/*
=================
CL_RegisterFootstep

[Paril-KEX] q2repro tent.c:187-210. Probes for up to MAX_FOOTSTEP_SFX
numbered sound files ("#sound/player/steps/<material><i>.wav", or
"#sound/player/step<i>.wav" for the default/null material), stopping at
the first missing file, matching retail's own numbering exactly (the
default set ships 4 files; most material sets ship 4-5).
=================
*/
function CL_RegisterFootstep(sfx: FootstepSfxT, material: string | null): void {
  let i = 0;
  for (; i < MAX_FOOTSTEP_SFX; i++) {
    const name = material ? `#sound/player/steps/${material}${i + 1}.wav` : `#sound/player/step${i + 1}.wav`;
    const open = FS_FOpenFile(name.slice(1));
    if (!open) break;
    FS_FCloseFile(open.handle);
    sfx.sfx[i] = S_RegisterSound(name);
  }
  sfx.num_sfx = i;
}

/*
=================
CL_RegisterFootsteps

[Paril-KEX] q2repro tent.c:214-247, driven by this port's own material
resolution (CM_TexinfoMaterial, ../qcommon/cmodel.ts's CMod_LoadMaterials
-- see that function's header comment for why this port resolves BSP
materials over the SERVER's collision model instead of a separate
client-side cl.bsp) instead of a second, client-side BSP_LoadMaterials
pass. CM_NumTexinfo() > 0 stands in for the C's `if (!cl.bsp)` check: this
port has no separate "is a map currently loaded" flag to read, but every
real BSP has at least one texinfo, so an empty/never-loaded state and a
zero-texinfo state are indistinguishable in practice.
=================
*/
export function CL_RegisterFootsteps(): void {
  cl_last_footstep = null;
  cl_footstep_sfx = [];
  cl_material_step_ids = new Map();

  const numtexinfo = CM_NumTexinfo();
  if (numtexinfo <= 0) return;

  // reserved footsteps
  const defaultSfx = new FootstepSfxT();
  const ladderSfx = new FootstepSfxT();
  cl_footstep_sfx[FOOTSTEP_ID_DEFAULT] = defaultSfx;
  cl_footstep_sfx[FOOTSTEP_ID_LADDER] = ladderSfx;
  CL_RegisterFootstep(defaultSfx, null);
  CL_RegisterFootstep(ladderSfx, "ladder");

  // load the rest -- one CL_RegisterFootstep call per unique material
  // string this map's texinfo actually uses (bsp.c's own backward-scan
  // "already allocated?" check, expressed as a map lookup instead of an
  // O(numtexinfo^2) scan; same final id assignment either way, since both
  // approaches key strictly off the material STRING).
  for (let i = 0; i < numtexinfo; i++) {
    const material = CM_TexinfoMaterial(i);
    if (!material || Q_stricmp(material, "default") === 0) continue;
    if (Q_stricmp(material, "ladder") === 0) continue;

    const key = material.toLowerCase();
    if (cl_material_step_ids.has(key)) continue;

    const step_id = cl_footstep_sfx.length;
    cl_material_step_ids.set(key, step_id);
    const sfx = new FootstepSfxT();
    cl_footstep_sfx[step_id] = sfx;
    CL_RegisterFootstep(sfx, material);
  }
}

/*
=================
CL_RegisterTEntSounds
=================
*/
export function CL_RegisterTEntSounds(): void {
  cl_sfx_ric1 = S_RegisterSound("world/ric1.wav");
  cl_sfx_ric2 = S_RegisterSound("world/ric2.wav");
  cl_sfx_ric3 = S_RegisterSound("world/ric3.wav");
  cl_sfx_lashit = S_RegisterSound("weapons/lashit.wav");
  cl_sfx_spark5 = S_RegisterSound("world/spark5.wav");
  cl_sfx_spark6 = S_RegisterSound("world/spark6.wav");
  cl_sfx_spark7 = S_RegisterSound("world/spark7.wav");
  cl_sfx_railg = S_RegisterSound("weapons/railgf1a.wav");
  cl_sfx_rockexp = S_RegisterSound("weapons/rocklx1a.wav");
  cl_sfx_grenexp = S_RegisterSound("weapons/grenlx1a.wav");
  cl_sfx_watrexp = S_RegisterSound("weapons/xpld_wat.wav");
  // RAFAEL
  // cl_sfx_plasexp = S_RegisterSound ("weapons/plasexpl.wav");
  S_RegisterSound("player/land1.wav");

  S_RegisterSound("player/fall2.wav");
  S_RegisterSound("player/fall1.wav");

  CL_RegisterFootsteps();

  // PGM
  cl_sfx_lightning = S_RegisterSound("weapons/tesla.wav");
  cl_sfx_disrexp = S_RegisterSound("weapons/disrupthit.wav");
  // version stuff -- id's original computes this string and never uses it
  // (dead code preserved faithfully; see cl_tent.c's CL_RegisterTEntSounds)
  let name = `weapons/sound${1278}.wav`;
  if (name[0] === "w") name = "W" + name.slice(1);
  // PGM
}

/*
=================
CL_RegisterTEntModels
=================
*/
export function CL_RegisterTEntModels(): void {
  // ref_gl/ is not ported (PORTING.md); `re` stays null with no GL renderer
  // constructed, so this early-outs instead of null-derefing -- reported
  // deviation from the C, which never null-checks `re`.
  if (!re) return;

  cl_mod_explode = re.RegisterModel("models/objects/explode/tris.md2");
  cl_mod_smoke = re.RegisterModel("models/objects/smoke/tris.md2");
  cl_mod_flash = re.RegisterModel("models/objects/flash/tris.md2");
  cl_mod_parasite_segment = re.RegisterModel("models/monsters/parasite/segment/tris.md2");
  cl_mod_grapple_cable = re.RegisterModel("models/ctf/segment/tris.md2");
  cl_mod_parasite_tip = re.RegisterModel("models/monsters/parasite/tip/tris.md2");
  cl_mod_explo4 = re.RegisterModel("models/objects/r_explode/tris.md2");
  cl_mod_bfg_explo = re.RegisterModel("sprites/s_bfg2.sp2");
  cl_mod_powerscreen = re.RegisterModel("models/items/armor/effect/tris.md2");

  re.RegisterModel("models/objects/laser/tris.md2");
  re.RegisterModel("models/objects/grenade2/tris.md2");
  re.RegisterModel("models/weapons/v_machn/tris.md2");
  re.RegisterModel("models/weapons/v_handgr/tris.md2");
  re.RegisterModel("models/weapons/v_shotg2/tris.md2");
  re.RegisterModel("models/objects/gibs/bone/tris.md2");
  re.RegisterModel("models/objects/gibs/sm_meat/tris.md2");
  re.RegisterModel("models/objects/gibs/bone2/tris.md2");
  // RAFAEL
  // re.RegisterModel ("models/objects/blaser/tris.md2");

  re.RegisterPic("w_machinegun");
  re.RegisterPic("a_bullets");
  re.RegisterPic("i_health");
  re.RegisterPic("a_grenades");

  // ROGUE
  cl_mod_explo4_big = re.RegisterModel("models/objects/r_explode2/tris.md2");
  cl_mod_lightning = re.RegisterModel("models/proj/lightning/tris.md2");
  cl_mod_heatbeam = re.RegisterModel("models/proj/beam/tris.md2");
  cl_mod_monster_heatbeam = re.RegisterModel("models/proj/widowbeam/tris.md2");
  // ROGUE

  // [Paril-KEX] q2repro tent.c:317-318 -- retail's real muzzle-flash
  // models (models/weapons/v_*/flash/tris.md2), one per MuzzlefxT entry.
  // CL_AddMuzzleFX/CL_AddWeaponMuzzleFX below render these instead of the
  // classic dlight-only muzzle flash.
  for (let i = 0; i < MFLASH_TOTAL; i++) {
    cl_mod_muzzles[i] = re.RegisterModel(`models/weapons/${muzzlenames[i]}/flash/tris.md2`);
  }

  // q2repro tent.c:322 -- `cl_img_flare = R_RegisterImage("misc/flare.tga",
  // IT_SPRITE, IF_DEFAULT_FLARE)`. This port has no R_RegisterImage with an
  // image-type/flags pair; RegisterSkin is the primitive that loads a name
  // exactly as given (no "pics/" prefix, no forced ".pcx"), which is the one
  // property that matters here -- the same reasoning cl_parse.ts's
  // CL_RegisterImage header comment already spells out for the
  // RF_CUSTOMSKIN flare images. The IF_DEFAULT_FLARE half of the C call is
  // recovered at draw time from the image's own name (ref_gl/gl_rmain.ts's
  // R_DrawFlare).
  cl_img_flare = re.RegisterSkin("misc/flare.tga");
}

/*
=================
CL_ClearTEnts
=================
*/
export function CL_ClearTEnts(): void {
  for (const b of cl_beams) {
    b.entity = 0;
    b.dest_entity = 0;
    b.model = null;
    b.endtime = 0;
    b.offset = vec3();
    b.start = vec3();
    b.end = vec3();
  }
  for (const ex of cl_explosions) {
    ex.type = ExptypeT.ex_free;
    ex.ent = new EntityT();
    ex.frames = 0;
    ex.light = 0;
    ex.lightcolor = vec3();
    ex.start = 0;
    ex.baseframe = 0;
  }
  for (const l of cl_lasers) {
    l.ent = new EntityT();
    l.endtime = 0;
  }

  // ROGUE
  for (const b of cl_playerbeams) {
    b.entity = 0;
    b.dest_entity = 0;
    b.model = null;
    b.endtime = 0;
    b.offset = vec3();
    b.start = vec3();
    b.end = vec3();
  }
  for (const s of cl_sustains) {
    s.id = 0;
    s.type = 0;
    s.endtime = 0;
    s.nextthink = 0;
    s.thinkinterval = 0;
    s.org = vec3();
    s.dir = vec3();
    s.color = 0;
    s.count = 0;
    s.magnitude = 0;
    s.think = null;
  }
  // ROGUE
}

/*
=================
CL_AllocExplosion
=================
*/
function CL_AllocExplosion(): ExplosionT {
  for (const ex of cl_explosions) {
    if (ex.type === ExptypeT.ex_free) {
      ex.ent = new EntityT();
      ex.frames = 0;
      ex.light = 0;
      ex.lightcolor = vec3();
      ex.start = 0;
      ex.baseframe = 0;
      return ex;
    }
  }
  // find the oldest explosion
  let time = cl.time;
  let index = 0;

  for (let i = 0; i < MAX_EXPLOSIONS; i++) {
    if (cl_explosions[i].start < time) {
      time = cl_explosions[i].start;
      index = i;
    }
  }
  const ex = cl_explosions[index];
  ex.type = ExptypeT.ex_free;
  ex.ent = new EntityT();
  ex.frames = 0;
  ex.light = 0;
  ex.lightcolor = vec3();
  ex.start = 0;
  ex.baseframe = 0;
  return ex;
}

/*
=================
CL_AddMuzzleFX

[Paril-KEX] q2repro tent.c:450-474's CL_AddMuzzleFX -- renders a monster's
(or other non-viewing entity's) real muzzle-flash MODEL (retail's
models/weapons/v_<name>/flash/tris.md2) as a short-lived ex_mflash explosion,
alongside the existing dlight+sound CL_ParseMuzzleFlash2 already does in
cl_fx.ts. `skin` selects among a flash model's skins (only MFLASH_BLAST
uses more than skin 0: 0=orange, 1=blue, 2=green).

DEVIATION: q2repro's entity_t carries a per-entity vec3_t scale
(VectorSet(ex->ent.scale, scale, scale, scale)) that this port's EntityT
(ref.ts) has no field for -- ref_gl/ is not ported (PORTING.md), so no
renderer here consumes entity scale at all yet, and V_AddEntity's
field-by-field copy (cl_view.ts, out of this unit's territory) would need
its own update even if the field existed. The `scale` parameter is still
threaded through and used to size the position offset (VectorMA) exactly
like the C, matching every OTHER effect of scale; only the model's visual
size is unaffected until a renderer + V_AddEntity scale field lands.
=================
*/
export function CL_AddMuzzleFX(origin: Vec3, angles: Vec3, fx: MuzzlefxT, skin: number, scale: number): void {
  if (!clCvars.cl_muzzleflashes || !clCvars.cl_muzzleflashes.value) return;

  if (fx >= cl_mod_muzzles.length) throw new ComError(ERR_DROP, "CL_AddMuzzleFX: bad fx");

  const model = cl_mod_muzzles[fx];
  if (!model) return;

  const ex = CL_AllocExplosion();
  VectorCopy(origin, ex.ent.origin);
  VectorCopy(angles, ex.ent.angles);
  ex.type = ExptypeT.ex_mflash;
  ex.ent.flags = RF_TRANSLUCENT | RF_NOSHADOW | RF_FULLBRIGHT;
  ex.ent.alpha = 1.0;
  ex.start = cl.frame.servertime - 100;
  ex.ent.model = model;
  ex.ent.skinnum = skin;
  if (fx !== MFLASH_BOOMER) ex.ent.angles[2] = clFxMod().rand() % 360;
}

/*
=================
CL_SmokeAndFlash
=================
*/
export function CL_SmokeAndFlash(origin: Vec3): void {
  let ex = CL_AllocExplosion();
  VectorCopy(origin, ex.ent.origin);
  ex.type = ExptypeT.ex_misc;
  ex.frames = 4;
  ex.ent.flags = RF_TRANSLUCENT;
  ex.start = cl.frame.servertime - 100;
  ex.ent.model = cl_mod_smoke;

  ex = CL_AllocExplosion();
  VectorCopy(origin, ex.ent.origin);
  ex.type = ExptypeT.ex_flash;
  ex.ent.flags = RF_FULLBRIGHT;
  ex.frames = 2;
  ex.start = cl.frame.servertime - 100;
  ex.ent.model = cl_mod_flash;
}

/*
=================
CL_ParseParticles
=================
*/
function CL_ParseParticles(): void {
  const pos = vec3();
  const dir = vec3();
  MSG_ReadPos(net_message, pos);
  MSG_ReadDir(net_message, dir);

  const color = MSG_ReadByte(net_message);
  const count = MSG_ReadByte(net_message);

  clFxMod().CL_ParticleEffect(pos, dir, color, count);
}

/*
=================
CL_ParseBeam
=================
*/
function CL_ParseBeam(model: ModelS | null): number {
  const ent = MSG_ReadShort(net_message);

  const start = vec3();
  const end = vec3();
  MSG_ReadPos(net_message, start);
  MSG_ReadPos(net_message, end);

  // override any beam with the same entity
  for (const b of cl_beams) {
    if (b.entity === ent) {
      b.entity = ent;
      b.model = model;
      b.endtime = cl.time + 200;
      VectorCopy(start, b.start);
      VectorCopy(end, b.end);
      b.offset = vec3();
      return ent;
    }
  }

  // find a free beam
  for (const b of cl_beams) {
    if (!b.model || b.endtime < cl.time) {
      b.entity = ent;
      b.model = model;
      b.endtime = cl.time + 200;
      VectorCopy(start, b.start);
      VectorCopy(end, b.end);
      b.offset = vec3();
      return ent;
    }
  }
  Com_Printf("beam list overflow!\n");
  return ent;
}

/*
=================
CL_ParseBeam2
=================
*/
function CL_ParseBeam2(model: ModelS | null): number {
  const ent = MSG_ReadShort(net_message);

  const start = vec3();
  const end = vec3();
  const offset = vec3();
  MSG_ReadPos(net_message, start);
  MSG_ReadPos(net_message, end);
  MSG_ReadPos(net_message, offset);

  // override any beam with the same entity
  for (const b of cl_beams) {
    if (b.entity === ent) {
      b.entity = ent;
      b.model = model;
      b.endtime = cl.time + 200;
      VectorCopy(start, b.start);
      VectorCopy(end, b.end);
      VectorCopy(offset, b.offset);
      return ent;
    }
  }

  // find a free beam
  for (const b of cl_beams) {
    if (!b.model || b.endtime < cl.time) {
      b.entity = ent;
      b.model = model;
      b.endtime = cl.time + 200;
      VectorCopy(start, b.start);
      VectorCopy(end, b.end);
      VectorCopy(offset, b.offset);
      return ent;
    }
  }
  Com_Printf("beam list overflow!\n");
  return ent;
}

// ROGUE
/*
=================
CL_ParsePlayerBeam
  - adds to the cl_playerbeam array instead of the cl_beams array
=================
*/
function CL_ParsePlayerBeam(modelIn: ModelS | null): number {
  let model = modelIn;
  const ent = MSG_ReadShort(net_message);

  const start = vec3();
  const end = vec3();
  const offset = vec3();
  MSG_ReadPos(net_message, start);
  MSG_ReadPos(net_message, end);
  // PMM - network optimization
  if (model === cl_mod_heatbeam) {
    offset[0] = 2;
    offset[1] = 7;
    offset[2] = -3;
  } else if (model === cl_mod_monster_heatbeam) {
    model = cl_mod_heatbeam;
    offset[0] = 0;
    offset[1] = 0;
    offset[2] = 0;
  } else {
    MSG_ReadPos(net_message, offset);
  }

  // override any beam with the same entity
  // PMM - For player beams, we only want one per player (entity) so..
  for (const b of cl_playerbeams) {
    if (b.entity === ent) {
      b.entity = ent;
      b.model = model;
      b.endtime = cl.time + 200;
      VectorCopy(start, b.start);
      VectorCopy(end, b.end);
      VectorCopy(offset, b.offset);
      return ent;
    }
  }

  // find a free beam
  for (const b of cl_playerbeams) {
    if (!b.model || b.endtime < cl.time) {
      b.entity = ent;
      b.model = model;
      b.endtime = cl.time + 100; // PMM - this needs to be 100 to prevent multiple heatbeams
      VectorCopy(start, b.start);
      VectorCopy(end, b.end);
      VectorCopy(offset, b.offset);
      return ent;
    }
  }
  Com_Printf("beam list overflow!\n");
  return ent;
}
// rogue

/*
=================
CL_ParseLightning
=================
*/
function CL_ParseLightning(model: ModelS | null): number {
  const srcEnt = MSG_ReadShort(net_message);
  const destEnt = MSG_ReadShort(net_message);

  const start = vec3();
  const end = vec3();
  MSG_ReadPos(net_message, start);
  MSG_ReadPos(net_message, end);

  // override any beam with the same source AND destination entities
  for (const b of cl_beams) {
    if (b.entity === srcEnt && b.dest_entity === destEnt) {
      b.entity = srcEnt;
      b.dest_entity = destEnt;
      b.model = model;
      b.endtime = cl.time + 200;
      VectorCopy(start, b.start);
      VectorCopy(end, b.end);
      b.offset = vec3();
      return srcEnt;
    }
  }

  // find a free beam
  for (const b of cl_beams) {
    if (!b.model || b.endtime < cl.time) {
      b.entity = srcEnt;
      b.dest_entity = destEnt;
      b.model = model;
      b.endtime = cl.time + 200;
      VectorCopy(start, b.start);
      VectorCopy(end, b.end);
      b.offset = vec3();
      return srcEnt;
    }
  }
  Com_Printf("beam list overflow!\n");
  return srcEnt;
}

/*
=================
CL_ParseLaser
=================
*/
function CL_ParseLaser(colors: number): void {
  const start = vec3();
  const end = vec3();
  MSG_ReadPos(net_message, start);
  MSG_ReadPos(net_message, end);

  for (const l of cl_lasers) {
    if (l.endtime < cl.time) {
      l.ent.flags = RF_TRANSLUCENT | RF_BEAM;
      VectorCopy(start, l.ent.origin);
      VectorCopy(end, l.ent.oldorigin);
      l.ent.alpha = 0.3;
      l.ent.skinnum = (colors >> ((clFxMod().rand() % 4) * 8)) & 0xff;
      l.ent.model = null;
      l.ent.frame = 4;
      l.endtime = cl.time + 100;
      return;
    }
  }
}

//=============
//ROGUE
function CL_ParseSteam(): void {
  const id = MSG_ReadShort(net_message); // an id of -1 is an instant effect
  if (id !== -1) {
    // sustains
    let free_sustain: ClSustainT | null = null;
    for (const s of cl_sustains) {
      if (s.id === 0) {
        free_sustain = s;
        break;
      }
    }
    if (free_sustain) {
      const s = free_sustain;
      s.id = id;
      s.count = MSG_ReadByte(net_message);
      MSG_ReadPos(net_message, s.org);
      MSG_ReadDir(net_message, s.dir);
      const r = MSG_ReadByte(net_message);
      s.color = r & 0xff;
      s.magnitude = MSG_ReadShort(net_message);
      s.endtime = cl.time + MSG_ReadLong(net_message);
      s.think = CL_ParticleSteamEffect2;
      s.thinkinterval = 100;
      s.nextthink = cl.time;
    } else {
      // FIXME - read the stuff anyway
      const pos = vec3();
      const dir = vec3();
      MSG_ReadByte(net_message);
      MSG_ReadPos(net_message, pos);
      MSG_ReadDir(net_message, dir);
      MSG_ReadByte(net_message);
      MSG_ReadShort(net_message);
      MSG_ReadLong(net_message); // really interval
    }
  } else {
    // instant
    const cnt = MSG_ReadByte(net_message);
    const pos = vec3();
    const dir = vec3();
    MSG_ReadPos(net_message, pos);
    MSG_ReadDir(net_message, dir);
    const r = MSG_ReadByte(net_message);
    const magnitude = MSG_ReadShort(net_message);
    const color = r & 0xff;
    CL_ParticleSteamEffect(pos, dir, color, cnt, magnitude);
  }
}

function CL_ParseWidow(): void {
  const id = MSG_ReadShort(net_message);

  let free_sustain: ClSustainT | null = null;
  for (const s of cl_sustains) {
    if (s.id === 0) {
      free_sustain = s;
      break;
    }
  }
  if (free_sustain) {
    const s = free_sustain;
    s.id = id;
    MSG_ReadPos(net_message, s.org);
    s.endtime = cl.time + 2100;
    s.think = CL_Widowbeamout;
    s.thinkinterval = 1;
    s.nextthink = cl.time;
  } else {
    // FIXME - read the stuff anyway
    const pos = vec3();
    MSG_ReadPos(net_message, pos);
  }
}

function CL_ParseNuke(): void {
  let free_sustain: ClSustainT | null = null;
  for (const s of cl_sustains) {
    if (s.id === 0) {
      free_sustain = s;
      break;
    }
  }
  if (free_sustain) {
    const s = free_sustain;
    s.id = 21000;
    MSG_ReadPos(net_message, s.org);
    s.endtime = cl.time + 1000;
    s.think = CL_Nukeblast;
    s.thinkinterval = 1;
    s.nextthink = cl.time;
  } else {
    // FIXME - read the stuff anyway
    const pos = vec3();
    MSG_ReadPos(net_message, pos);
  }
}

//ROGUE
//=============

/*
=================
CL_ParseTEnt
=================
*/
const splash_color = fixedLength("splash_color", 7, [0x00, 0xe0, 0xb0, 0x50, 0xd0, 0xe0, 0xe8]);

export function CL_ParseTEnt(): void {
  const pos = vec3();
  const pos2 = vec3();
  const dir = vec3();
  let ex: ExplosionT;
  let ent = 0;

  const type = MSG_ReadByte(net_message);

  switch (type) {
    case TE_BLOOD: // bullet hitting flesh
      MSG_ReadPos(net_message, pos);
      MSG_ReadDir(net_message, dir);
      clFxMod().CL_ParticleEffect(pos, dir, 0xe8, 60);
      break;

    case TE_GUNSHOT: // bullet hitting wall
    case TE_SPARKS:
    case TE_BULLET_SPARKS:
      MSG_ReadPos(net_message, pos);
      MSG_ReadDir(net_message, dir);
      if (type === TE_GUNSHOT) clFxMod().CL_ParticleEffect(pos, dir, 0, 40);
      else clFxMod().CL_ParticleEffect(pos, dir, 0xe0, 6);

      if (type !== TE_SPARKS) {
        CL_SmokeAndFlash(pos);

        // impact sound
        const cnt = clFxMod().rand() & 15;
        if (cnt === 1) S_StartSound(pos, 0, 0, cl_sfx_ric1, 1, ATTN_NORM, 0);
        else if (cnt === 2) S_StartSound(pos, 0, 0, cl_sfx_ric2, 1, ATTN_NORM, 0);
        else if (cnt === 3) S_StartSound(pos, 0, 0, cl_sfx_ric3, 1, ATTN_NORM, 0);
      }

      break;

    case TE_SCREEN_SPARKS:
    case TE_SHIELD_SPARKS:
      MSG_ReadPos(net_message, pos);
      MSG_ReadDir(net_message, dir);
      if (type === TE_SCREEN_SPARKS) clFxMod().CL_ParticleEffect(pos, dir, 0xd0, 40);
      else clFxMod().CL_ParticleEffect(pos, dir, 0xb0, 40);
      // FIXME : replace or remove this sound
      S_StartSound(pos, 0, 0, cl_sfx_lashit, 1, ATTN_NORM, 0);
      break;

    case TE_SHOTGUN: // bullet hitting wall
      MSG_ReadPos(net_message, pos);
      MSG_ReadDir(net_message, dir);
      clFxMod().CL_ParticleEffect(pos, dir, 0, 20);
      CL_SmokeAndFlash(pos);
      break;

    case TE_SPLASH: {
      // bullet hitting water
      const cnt = MSG_ReadByte(net_message);
      MSG_ReadPos(net_message, pos);
      MSG_ReadDir(net_message, dir);
      const r = MSG_ReadByte(net_message);
      const color = r > 6 ? 0x00 : splash_color[r];
      clFxMod().CL_ParticleEffect(pos, dir, color, cnt);

      if (r === SPLASH_SPARKS) {
        const rr = clFxMod().rand() & 3;
        if (rr === 0) S_StartSound(pos, 0, 0, cl_sfx_spark5, 1, ATTN_STATIC, 0);
        else if (rr === 1) S_StartSound(pos, 0, 0, cl_sfx_spark6, 1, ATTN_STATIC, 0);
        else S_StartSound(pos, 0, 0, cl_sfx_spark7, 1, ATTN_STATIC, 0);
      }
      break;
    }

    case TE_LASER_SPARKS: {
      const cnt = MSG_ReadByte(net_message);
      MSG_ReadPos(net_message, pos);
      MSG_ReadDir(net_message, dir);
      const color = MSG_ReadByte(net_message);
      clFxMod().CL_ParticleEffect2(pos, dir, color, cnt);
      break;
    }

    // RAFAEL
    case TE_BLUEHYPERBLASTER:
      MSG_ReadPos(net_message, pos);
      MSG_ReadPos(net_message, dir);
      clFxMod().CL_BlasterParticles(pos, dir);
      break;

    case TE_BLASTER: // blaster hitting wall
      MSG_ReadPos(net_message, pos);
      MSG_ReadDir(net_message, dir);
      clFxMod().CL_BlasterParticles(pos, dir);

      ex = CL_AllocExplosion();
      VectorCopy(pos, ex.ent.origin);
      ex.ent.angles[0] = (Math.acos(dir[2]) / Math.PI) * 180;
      // PMM - fixed to correct for pitch of 0
      if (dir[0]) ex.ent.angles[1] = (Math.atan2(dir[1], dir[0]) / Math.PI) * 180;
      else if (dir[1] > 0) ex.ent.angles[1] = 90;
      else if (dir[1] < 0) ex.ent.angles[1] = 270;
      else ex.ent.angles[1] = 0;

      ex.type = ExptypeT.ex_misc;
      ex.ent.flags = RF_FULLBRIGHT | RF_TRANSLUCENT;
      ex.start = cl.frame.servertime - 100;
      ex.light = 150;
      ex.lightcolor[0] = 1;
      ex.lightcolor[1] = 1;
      ex.ent.model = cl_mod_explode;
      ex.frames = 4;
      S_StartSound(pos, 0, 0, cl_sfx_lashit, 1, ATTN_NORM, 0);
      break;

    case TE_RAILTRAIL: // railgun effect
      MSG_ReadPos(net_message, pos);
      MSG_ReadPos(net_message, pos2);
      clFxMod().CL_RailTrail(pos, pos2);
      S_StartSound(pos2, 0, 0, cl_sfx_railg, 1, ATTN_NORM, 0);
      break;

    case TE_EXPLOSION2:
    case TE_GRENADE_EXPLOSION:
    case TE_GRENADE_EXPLOSION_WATER:
      MSG_ReadPos(net_message, pos);

      ex = CL_AllocExplosion();
      VectorCopy(pos, ex.ent.origin);
      ex.type = ExptypeT.ex_poly;
      ex.ent.flags = RF_FULLBRIGHT;
      ex.start = cl.frame.servertime - 100;
      ex.light = 350;
      ex.lightcolor[0] = 1.0;
      ex.lightcolor[1] = 0.5;
      ex.lightcolor[2] = 0.5;
      ex.ent.model = cl_mod_explo4;
      ex.frames = 19;
      ex.baseframe = 30;
      ex.ent.angles[1] = clFxMod().rand() % 360;
      clFxMod().CL_ExplosionParticles(pos);
      if (type === TE_GRENADE_EXPLOSION_WATER) S_StartSound(pos, 0, 0, cl_sfx_watrexp, 1, ATTN_NORM, 0);
      else S_StartSound(pos, 0, 0, cl_sfx_grenexp, 1, ATTN_NORM, 0);
      break;

    // RAFAEL
    case TE_PLASMA_EXPLOSION:
      MSG_ReadPos(net_message, pos);
      ex = CL_AllocExplosion();
      VectorCopy(pos, ex.ent.origin);
      ex.type = ExptypeT.ex_poly;
      ex.ent.flags = RF_FULLBRIGHT;
      ex.start = cl.frame.servertime - 100;
      ex.light = 350;
      ex.lightcolor[0] = 1.0;
      ex.lightcolor[1] = 0.5;
      ex.lightcolor[2] = 0.5;
      ex.ent.angles[1] = clFxMod().rand() % 360;
      ex.ent.model = cl_mod_explo4;
      if (frand() < 0.5) ex.baseframe = 15;
      ex.frames = 15;
      clFxMod().CL_ExplosionParticles(pos);
      S_StartSound(pos, 0, 0, cl_sfx_rockexp, 1, ATTN_NORM, 0);
      break;

    case TE_EXPLOSION1:
    case TE_EXPLOSION1_BIG: // PMM
    case TE_ROCKET_EXPLOSION:
    case TE_ROCKET_EXPLOSION_WATER:
    case TE_EXPLOSION1_NP: // PMM
      MSG_ReadPos(net_message, pos);

      ex = CL_AllocExplosion();
      VectorCopy(pos, ex.ent.origin);
      ex.type = ExptypeT.ex_poly;
      ex.ent.flags = RF_FULLBRIGHT;
      ex.start = cl.frame.servertime - 100;
      ex.light = 350;
      ex.lightcolor[0] = 1.0;
      ex.lightcolor[1] = 0.5;
      ex.lightcolor[2] = 0.5;
      ex.ent.angles[1] = clFxMod().rand() % 360;
      if (type !== TE_EXPLOSION1_BIG)
        ex.ent.model = cl_mod_explo4; // PMM
      else ex.ent.model = cl_mod_explo4_big;
      if (frand() < 0.5) ex.baseframe = 15;
      ex.frames = 15;
      if (type !== TE_EXPLOSION1_BIG && type !== TE_EXPLOSION1_NP)
        // PMM
        clFxMod().CL_ExplosionParticles(pos); // PMM
      if (type === TE_ROCKET_EXPLOSION_WATER) S_StartSound(pos, 0, 0, cl_sfx_watrexp, 1, ATTN_NORM, 0);
      else S_StartSound(pos, 0, 0, cl_sfx_rockexp, 1, ATTN_NORM, 0);
      break;

    case TE_BFG_EXPLOSION:
      MSG_ReadPos(net_message, pos);
      ex = CL_AllocExplosion();
      VectorCopy(pos, ex.ent.origin);
      ex.type = ExptypeT.ex_poly;
      ex.ent.flags = RF_FULLBRIGHT;
      ex.start = cl.frame.servertime - 100;
      ex.light = 350;
      ex.lightcolor[0] = 0.0;
      ex.lightcolor[1] = 1.0;
      ex.lightcolor[2] = 0.0;
      ex.ent.model = cl_mod_bfg_explo;
      ex.ent.flags |= RF_TRANSLUCENT;
      ex.ent.alpha = 0.3;
      ex.frames = 4;
      break;

    case TE_BFG_BIGEXPLOSION:
      MSG_ReadPos(net_message, pos);
      clFxMod().CL_BFGExplosionParticles(pos);
      break;

    case TE_BFG_LASER:
      CL_ParseLaser(0xd0d1d2d3);
      break;

    case TE_BUBBLETRAIL:
      MSG_ReadPos(net_message, pos);
      MSG_ReadPos(net_message, pos2);
      clFxMod().CL_BubbleTrail(pos, pos2);
      break;

    case TE_PARASITE_ATTACK:
    case TE_MEDIC_CABLE_ATTACK:
      ent = CL_ParseBeam(cl_mod_parasite_segment);
      break;

    case TE_BOSSTPORT: // boss teleporting to station
      MSG_ReadPos(net_message, pos);
      clFxMod().CL_BigTeleportParticles(pos);
      S_StartSound(pos, 0, 0, S_RegisterSound("misc/bigtele.wav"), 1, ATTN_NONE, 0);
      break;

    case TE_GRAPPLE_CABLE:
      ent = CL_ParseBeam2(cl_mod_grapple_cable);
      break;

    // RAFAEL
    case TE_WELDING_SPARKS: {
      const cnt = MSG_ReadByte(net_message);
      MSG_ReadPos(net_message, pos);
      MSG_ReadDir(net_message, dir);
      const color = MSG_ReadByte(net_message);
      clFxMod().CL_ParticleEffect2(pos, dir, color, cnt);

      ex = CL_AllocExplosion();
      VectorCopy(pos, ex.ent.origin);
      ex.type = ExptypeT.ex_flash;
      // note to self
      // we need a better no draw flag
      ex.ent.flags = RF_BEAM;
      ex.start = cl.frame.servertime - 0.1;
      ex.light = 100 + (clFxMod().rand() % 75);
      ex.lightcolor[0] = 1.0;
      ex.lightcolor[1] = 1.0;
      ex.lightcolor[2] = 0.3;
      ex.ent.model = cl_mod_flash;
      ex.frames = 2;
      break;
    }

    case TE_GREENBLOOD:
      MSG_ReadPos(net_message, pos);
      MSG_ReadDir(net_message, dir);
      clFxMod().CL_ParticleEffect2(pos, dir, 0xdf, 30);
      break;

    // RAFAEL
    case TE_TUNNEL_SPARKS: {
      const cnt = MSG_ReadByte(net_message);
      MSG_ReadPos(net_message, pos);
      MSG_ReadDir(net_message, dir);
      const color = MSG_ReadByte(net_message);
      clFxMod().CL_ParticleEffect3(pos, dir, color, cnt);
      break;
    }

    //=============
    //PGM
    // PMM -following code integrated for flechette (different color)
    case TE_BLASTER2: // green blaster hitting wall
    case TE_FLECHETTE: // flechette
      MSG_ReadPos(net_message, pos);
      MSG_ReadDir(net_message, dir);

      // PMM
      if (type === TE_BLASTER2) CL_BlasterParticles2(pos, dir, 0xd0);
      else CL_BlasterParticles2(pos, dir, 0x6f); // 75

      ex = CL_AllocExplosion();
      VectorCopy(pos, ex.ent.origin);
      ex.ent.angles[0] = (Math.acos(dir[2]) / Math.PI) * 180;
      // PMM - fixed to correct for pitch of 0
      if (dir[0]) ex.ent.angles[1] = (Math.atan2(dir[1], dir[0]) / Math.PI) * 180;
      else if (dir[1] > 0) ex.ent.angles[1] = 90;
      else if (dir[1] < 0) ex.ent.angles[1] = 270;
      else ex.ent.angles[1] = 0;

      ex.type = ExptypeT.ex_misc;
      ex.ent.flags = RF_FULLBRIGHT | RF_TRANSLUCENT;

      // PMM
      if (type === TE_BLASTER2) ex.ent.skinnum = 1;
      else ex.ent.skinnum = 2; // flechette

      ex.start = cl.frame.servertime - 100;
      ex.light = 150;
      // PMM
      if (type === TE_BLASTER2) ex.lightcolor[1] = 1;
      else {
        // flechette
        ex.lightcolor[0] = 0.19;
        ex.lightcolor[1] = 0.41;
        ex.lightcolor[2] = 0.75;
      }
      ex.ent.model = cl_mod_explode;
      ex.frames = 4;
      S_StartSound(pos, 0, 0, cl_sfx_lashit, 1, ATTN_NORM, 0);
      break;

    case TE_LIGHTNING:
      ent = CL_ParseLightning(cl_mod_lightning);
      S_StartSound(null, ent, CHAN_WEAPON, cl_sfx_lightning, 1, ATTN_NORM, 0);
      break;

    case TE_DEBUGTRAIL:
      MSG_ReadPos(net_message, pos);
      MSG_ReadPos(net_message, pos2);
      CL_DebugTrail(pos, pos2);
      break;

    case TE_PLAIN_EXPLOSION:
      MSG_ReadPos(net_message, pos);

      ex = CL_AllocExplosion();
      VectorCopy(pos, ex.ent.origin);
      ex.type = ExptypeT.ex_poly;
      ex.ent.flags = RF_FULLBRIGHT;
      ex.start = cl.frame.servertime - 100;
      ex.light = 350;
      ex.lightcolor[0] = 1.0;
      ex.lightcolor[1] = 0.5;
      ex.lightcolor[2] = 0.5;
      ex.ent.angles[1] = clFxMod().rand() % 360;
      ex.ent.model = cl_mod_explo4;
      if (frand() < 0.5) ex.baseframe = 15;
      ex.frames = 15;
      // id's C source checks `type == TE_ROCKET_EXPLOSION_WATER` here too,
      // copy-pasted from the TE_EXPLOSION1 block above -- but `type` is
      // fixed to TE_PLAIN_EXPLOSION for this whole case, so the check can
      // never be true (tsc's switch narrowing flags the literal comparison
      // as unreachable). Always plays cl_sfx_rockexp, matching the real
      // runtime behavior of the original engine. Reported deviation.
      S_StartSound(pos, 0, 0, cl_sfx_rockexp, 1, ATTN_NORM, 0);
      break;

    case TE_FLASHLIGHT:
      MSG_ReadPos(net_message, pos);
      ent = MSG_ReadShort(net_message);
      CL_Flashlight(ent, pos);
      break;

    case TE_FORCEWALL: {
      MSG_ReadPos(net_message, pos);
      MSG_ReadPos(net_message, pos2);
      const color = MSG_ReadByte(net_message);
      CL_ForceWall(pos, pos2, color);
      break;
    }

    case TE_HEATBEAM:
      ent = CL_ParsePlayerBeam(cl_mod_heatbeam);
      break;

    case TE_MONSTER_HEATBEAM:
      ent = CL_ParsePlayerBeam(cl_mod_monster_heatbeam);
      break;

    case TE_HEATBEAM_SPARKS: {
      const cnt = 50;
      MSG_ReadPos(net_message, pos);
      MSG_ReadDir(net_message, dir);
      const r = 8;
      const magnitude = 60;
      const color = r & 0xff;
      CL_ParticleSteamEffect(pos, dir, color, cnt, magnitude);
      S_StartSound(pos, 0, 0, cl_sfx_lashit, 1, ATTN_NORM, 0);
      break;
    }

    case TE_HEATBEAM_STEAM: {
      const cnt = 20;
      MSG_ReadPos(net_message, pos);
      MSG_ReadDir(net_message, dir);
      const color = 0xe0;
      const magnitude = 60;
      CL_ParticleSteamEffect(pos, dir, color, cnt, magnitude);
      S_StartSound(pos, 0, 0, cl_sfx_lashit, 1, ATTN_NORM, 0);
      break;
    }

    case TE_STEAM:
      CL_ParseSteam();
      break;

    case TE_BUBBLETRAIL2: {
      const cnt = 8;
      MSG_ReadPos(net_message, pos);
      MSG_ReadPos(net_message, pos2);
      CL_BubbleTrail2(pos, pos2, cnt);
      S_StartSound(pos, 0, 0, cl_sfx_lashit, 1, ATTN_NORM, 0);
      break;
    }

    case TE_MOREBLOOD:
      MSG_ReadPos(net_message, pos);
      MSG_ReadDir(net_message, dir);
      clFxMod().CL_ParticleEffect(pos, dir, 0xe8, 250);
      break;

    case TE_CHAINFIST_SMOKE:
      dir[0] = 0;
      dir[1] = 0;
      dir[2] = 1;
      MSG_ReadPos(net_message, pos);
      CL_ParticleSmokeEffect(pos, dir, 0, 20, 20);
      break;

    case TE_ELECTRIC_SPARKS:
      MSG_ReadPos(net_message, pos);
      MSG_ReadDir(net_message, dir);
      clFxMod().CL_ParticleEffect(pos, dir, 0x75, 40);
      // FIXME : replace or remove this sound
      S_StartSound(pos, 0, 0, cl_sfx_lashit, 1, ATTN_NORM, 0);
      break;

    case TE_TRACKER_EXPLOSION:
      MSG_ReadPos(net_message, pos);
      CL_ColorFlash(pos, 0, 150, -1, -1, -1);
      CL_ColorExplosionParticles(pos, 0, 1);
      // CL_Tracker_Explode (pos);
      S_StartSound(pos, 0, 0, cl_sfx_disrexp, 1, ATTN_NORM, 0);
      break;

    case TE_TELEPORT_EFFECT:
    case TE_DBALL_GOAL:
      MSG_ReadPos(net_message, pos);
      clFxMod().CL_TeleportParticles(pos);
      break;

    case TE_WIDOWBEAMOUT:
      CL_ParseWidow();
      break;

    case TE_NUKEBLAST:
      CL_ParseNuke();
      break;

    case TE_WIDOWSPLASH:
      MSG_ReadPos(net_message, pos);
      CL_WidowSplash(pos);
      break;
    //PGM
    //==============

    default:
      throw new ComError(ERR_DROP, "CL_ParseTEnt: bad type");
  }
}

/*
=================
CL_AddBeams
=================
*/
function CL_AddBeams(): void {
  // update beams
  for (const b of cl_beams) {
    if (!b.model || b.endtime < cl.time) continue;

    // if coming from the player, update the start position
    if (b.entity === cl.playernum + 1) {
      // entity 0 is the world
      VectorCopy(cl.refdef.vieworg, b.start);
      b.start[2] -= 22; // adjust for view height
    }
    const org = vec3();
    VectorAdd(b.start, b.offset, org);

    // calculate pitch and yaw
    const dist = vec3();
    VectorSubtract(b.end, org, dist);

    let yaw: number;
    let pitch: number;
    if (dist[1] === 0 && dist[0] === 0) {
      yaw = 0;
      pitch = dist[2] > 0 ? 90 : 270;
    } else {
      // PMM - fixed to correct for pitch of 0
      if (dist[0]) yaw = (Math.atan2(dist[1], dist[0]) * 180) / Math.PI;
      else if (dist[1] > 0) yaw = 90;
      else yaw = 270;
      if (yaw < 0) yaw += 360;

      const forward = Math.sqrt(dist[0] * dist[0] + dist[1] * dist[1]);
      pitch = (Math.atan2(dist[2], forward) * -180.0) / Math.PI;
      if (pitch < 0) pitch += 360.0;
    }

    // add new entities for the beams
    let d = VectorNormalize(dist);

    let ent = new EntityT();
    let model_length: number;
    if (b.model === cl_mod_lightning) {
      model_length = 35.0;
      d -= 20.0; // correction so it doesn't end in middle of tesla
    } else {
      model_length = 30.0;
    }
    const steps = Math.ceil(d / model_length);
    const len = (d - model_length) / (steps - 1);

    // PMM - special case for lightning model .. if the real length is shorter than the model,
    // flip it around & draw it from the end to the start.  This prevents the model from going
    // through the tesla mine (instead it goes through the target)
    if (b.model === cl_mod_lightning && d <= model_length) {
      VectorCopy(b.end, ent.origin);
      ent.model = b.model;
      ent.flags = RF_FULLBRIGHT;
      ent.angles[0] = pitch;
      ent.angles[1] = yaw;
      ent.angles[2] = clFxMod().rand() % 360;
      V_AddEntity(ent);
      return;
    }
    while (d > 0) {
      ent = new EntityT();
      VectorCopy(org, ent.origin);
      ent.model = b.model;
      if (b.model === cl_mod_lightning) {
        ent.flags = RF_FULLBRIGHT;
        ent.angles[0] = -pitch;
        ent.angles[1] = yaw + 180.0;
        ent.angles[2] = clFxMod().rand() % 360;
      } else {
        ent.angles[0] = pitch;
        ent.angles[1] = yaw;
        ent.angles[2] = clFxMod().rand() % 360;
      }

      V_AddEntity(ent);

      for (let j = 0; j < 3; j++) org[j] += dist[j] * len;
      d -= model_length;
    }
  }
}

/*
=================
ROGUE - draw player locked beams
CL_AddPlayerBeams
=================
*/
function CL_AddPlayerBeams(): void {
  // PMM
  let hand_multiplier: number;
  if (hand) {
    if (hand.value === 2) hand_multiplier = 0;
    else if (hand.value === 1) hand_multiplier = -1;
    else hand_multiplier = 1;
  } else {
    hand_multiplier = 1;
  }
  // PMM

  // update beams
  for (const b of cl_playerbeams) {
    const f = vec3();
    const r = vec3();
    const u = vec3();
    if (!b.model || b.endtime < cl.time) continue;

    const org = vec3();
    if (cl_mod_heatbeam && b.model === cl_mod_heatbeam) {
      // if coming from the player, update the start position
      if (b.entity === cl.playernum + 1) {
        // entity 0 is the world
        // set up gun position
        // code straight out of CL_AddViewWeapon
        const ps = cl.frame.playerstate;
        const j0 = (cl.frame.serverframe - 1) & UPDATE_MASK;
        let oldframe = cl.frames[j0];
        if (oldframe.serverframe !== cl.frame.serverframe - 1 || !oldframe.valid) oldframe = cl.frame; // previous frame was dropped or involid
        const ops = oldframe.playerstate;
        for (let j = 0; j < 3; j++) {
          b.start[j] = cl.refdef.vieworg[j] + ops.gunoffset[j] + cl.lerpfrac * (ps.gunoffset[j] - ops.gunoffset[j]);
        }
        VectorMA(b.start, hand_multiplier * b.offset[0], cl.v_right, org);
        VectorMA(org, b.offset[1], cl.v_forward, org);
        VectorMA(org, b.offset[2], cl.v_up, org);
        if (hand && hand.value === 2) {
          VectorMA(org, -1, cl.v_up, org);
        }
        // FIXME - take these out when final
        VectorCopy(cl.v_right, r);
        VectorCopy(cl.v_forward, f);
        VectorCopy(cl.v_up, u);
      } else {
        VectorCopy(b.start, org);
      }
    } else {
      // if coming from the player, update the start position
      if (b.entity === cl.playernum + 1) {
        // entity 0 is the world
        VectorCopy(cl.refdef.vieworg, b.start);
        b.start[2] -= 22; // adjust for view height
      }
      VectorAdd(b.start, b.offset, org);
    }

    // calculate pitch and yaw
    const dist = vec3();
    VectorSubtract(b.end, org, dist);

    // PMM
    if (cl_mod_heatbeam && b.model === cl_mod_heatbeam && b.entity === cl.playernum + 1) {
      const len = VectorLength(dist);
      VectorScale(f, len, dist);
      VectorMA(dist, hand_multiplier * b.offset[0], r, dist);
      VectorMA(dist, b.offset[1], f, dist);
      VectorMA(dist, b.offset[2], u, dist);
      if (hand && hand.value === 2) {
        VectorMA(org, -1, cl.v_up, org);
      }
    }
    // PMM

    let yaw: number;
    let pitch: number;
    if (dist[1] === 0 && dist[0] === 0) {
      yaw = 0;
      pitch = dist[2] > 0 ? 90 : 270;
    } else {
      // PMM - fixed to correct for pitch of 0
      if (dist[0]) yaw = (Math.atan2(dist[1], dist[0]) * 180) / Math.PI;
      else if (dist[1] > 0) yaw = 90;
      else yaw = 270;
      if (yaw < 0) yaw += 360;

      const forward = Math.sqrt(dist[0] * dist[0] + dist[1] * dist[1]);
      pitch = (Math.atan2(dist[2], forward) * -180.0) / Math.PI;
      if (pitch < 0) pitch += 360.0;
    }

    let framenum = 0;
    if (cl_mod_heatbeam && b.model === cl_mod_heatbeam) {
      if (b.entity !== cl.playernum + 1) {
        framenum = 2;
        const angles = vec3();
        angles[0] = -pitch;
        angles[1] = yaw + 180.0;
        angles[2] = 0;
        AngleVectors(angles, f, r, u);

        // if it's a non-origin offset, it's a player, so use the hardcoded player offset
        if (!VectorCompare(b.offset, vec3_origin)) {
          VectorMA(org, -b.offset[0] + 1, r, org);
          VectorMA(org, -b.offset[1], f, org);
          VectorMA(org, -b.offset[2] - 10, u, org);
        } else {
          // if it's a monster, do the particle effect
          CL_MonsterPlasma_Shell(b.start);
        }
      } else {
        framenum = 1;
      }
    }

    // if it's the heatbeam, draw the particle effect
    if (cl_mod_heatbeam && b.model === cl_mod_heatbeam && b.entity === cl.playernum + 1) {
      CL_Heatbeam(org, dist);
    }

    // add new entities for the beams
    let d = VectorNormalize(dist);

    let ent = new EntityT();
    let model_length: number;
    if (b.model === cl_mod_heatbeam) {
      model_length = 32.0;
    } else if (b.model === cl_mod_lightning) {
      model_length = 35.0;
      d -= 20.0; // correction so it doesn't end in middle of tesla
    } else {
      model_length = 30.0;
    }
    const steps = Math.ceil(d / model_length);
    const len = (d - model_length) / (steps - 1);

    // PMM - special case for lightning model .. if the real length is shorter than the model,
    // flip it around & draw it from the end to the start.
    if (b.model === cl_mod_lightning && d <= model_length) {
      VectorCopy(b.end, ent.origin);
      ent.model = b.model;
      ent.flags = RF_FULLBRIGHT;
      ent.angles[0] = pitch;
      ent.angles[1] = yaw;
      ent.angles[2] = clFxMod().rand() % 360;
      V_AddEntity(ent);
      // Faithful to the C: this `return` exits CL_AddPlayerBeams entirely
      // (not just this beam's iteration) -- the same early-exit quirk as
      // CL_AddBeams's identical special case above.
      return;
    }
    while (d > 0) {
      ent = new EntityT();
      VectorCopy(org, ent.origin);
      ent.model = b.model;
      if (cl_mod_heatbeam && b.model === cl_mod_heatbeam) {
        ent.flags = RF_FULLBRIGHT;
        ent.angles[0] = -pitch;
        ent.angles[1] = yaw + 180.0;
        ent.angles[2] = cl.time % 360;
        ent.frame = framenum;
      } else if (b.model === cl_mod_lightning) {
        ent.flags = RF_FULLBRIGHT;
        ent.angles[0] = -pitch;
        ent.angles[1] = yaw + 180.0;
        ent.angles[2] = clFxMod().rand() % 360;
      } else {
        ent.angles[0] = pitch;
        ent.angles[1] = yaw;
        ent.angles[2] = clFxMod().rand() % 360;
      }

      V_AddEntity(ent);

      for (let j = 0; j < 3; j++) org[j] += dist[j] * len;
      d -= model_length;
    }
  }
}

/*
=================
CL_AddExplosions
=================
*/
function CL_AddExplosions(): void {
  for (const ex of cl_explosions) {
    if (ex.type === ExptypeT.ex_free) continue;
    const frac = (cl.time - ex.start) / 100.0;
    const f = Math.floor(frac);

    const ent = ex.ent;

    switch (ex.type) {
      case ExptypeT.ex_mflash:
        // [Paril-KEX] q2repro tent.c:542-548 -- time-based (50ms), not
        // frame-based like every other case here, and DOES render (this
        // case was vestigial/unreachable in vanilla -- see cl_tent.c:1617
        // in the classic reference source -- until CL_AddMuzzleFX above
        // started allocating ex_mflash explosions for real).
        if (cl.time - ex.start > 50) ex.type = ExptypeT.ex_free;
        else V_AddEntity(ent);
        break;
      case ExptypeT.ex_misc:
        if (f >= ex.frames - 1) {
          ex.type = ExptypeT.ex_free;
          break;
        }
        ent.alpha = 1.0 - frac / (ex.frames - 1);
        break;
      case ExptypeT.ex_flash:
        if (f >= 1) {
          ex.type = ExptypeT.ex_free;
          break;
        }
        ent.alpha = 1.0;
        break;
      case ExptypeT.ex_poly:
        if (f >= ex.frames - 1) {
          ex.type = ExptypeT.ex_free;
          break;
        }

        ent.alpha = (16.0 - f) / 16.0;

        if (f < 10) {
          ent.skinnum = f >> 1;
          if (ent.skinnum < 0) ent.skinnum = 0;
        } else {
          ent.flags |= RF_TRANSLUCENT;
          ent.skinnum = f < 13 ? 5 : 6;
        }
        break;
      case ExptypeT.ex_poly2:
        if (f >= ex.frames - 1) {
          ex.type = ExptypeT.ex_free;
          break;
        }

        ent.alpha = (5.0 - f) / 5.0;
        ent.skinnum = 0;
        ent.flags |= RF_TRANSLUCENT;
        break;
      default:
        break;
    }

    if (ex.type === ExptypeT.ex_free) continue;
    if (ex.light) {
      V_AddLight(ent.origin, ex.light * ent.alpha, ex.lightcolor[0], ex.lightcolor[1], ex.lightcolor[2]);
    }

    VectorCopy(ent.origin, ent.oldorigin);

    const ff = f < 0 ? 0 : f;
    ent.frame = ex.baseframe + ff + 1;
    ent.oldframe = ex.baseframe + ff;
    ent.backlerp = 1.0 - cl.lerpfrac;

    V_AddEntity(ent);
  }
}

/*
=================
CL_AddLasers
=================
*/
function CL_AddLasers(): void {
  for (const l of cl_lasers) {
    if (l.endtime >= cl.time) V_AddEntity(l.ent);
  }
}

/* PMM - CL_Sustains */
function CL_ProcessSustain(): void {
  for (const s of cl_sustains) {
    if (s.id) {
      if (s.endtime >= cl.time && cl.time >= s.nextthink) {
        if (s.think) s.think(s);
      } else if (s.endtime < cl.time) {
        s.id = 0;
      }
    }
  }
}

/*
=================
CL_AddTEnts
=================
*/
export function CL_AddTEnts(): void {
  CL_AddBeams();
  // PMM - draw plasma beams
  CL_AddPlayerBeams();
  CL_AddExplosions();
  CL_AddLasers();
  // PMM - set up sustain
  CL_ProcessSustain();
}
