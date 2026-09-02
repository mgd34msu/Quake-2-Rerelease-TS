// p_view.c
//
// m_player.h frame split (same treatment as p_weapon.ts's FRAME_* consts):
// m_player_frames.ts does not exist on disk yet (owned by the p_client
// worker, G6a). Only the twenty FRAME_* names this file references are
// ported here as local consts; report/relocate once m_player_frames.ts
// lands.
//
// rogue/p_view.c vs baseq2/p_view.c: SV_CalcViewOffset's dead-player view
// angles get an FL_SAM_RAIMI branch (zero roll/pitch instead of the classic
// 40/-15 tilt, for the pack's "sam raimi cam" easter egg); SV_CalcGunOffset
// skips all gun-angle bobbing while the heatbeam (weapon_plasmabeam) is
// equipped, since the continuous beam needs a steady muzzle; SV_CalcBlend
// gains a double-damage screen tint (client.double_framenum), a nuke flash
// (client.nuke_framenum) and IR-goggles overlay (client.ir_framenum,
// PlayerStateT.rdflags |= RDF_IRGOGGLES); G_SetClientEffects switches the
// renderfx reset from 0 to RF_IR_VISIBLE (players are always IR-visible,
// even dead), adds an FL_DISGUISED -> RF_USE_DISGUISE passthrough and a
// DMGame.PlayerEffects hook (deathmatch-game-rules per-frame effects,
// g_newdm.c/dm_tag.c/dm_ball.c -- RG-systems' SCOPE) right after the
// health/intermission early-return, and gains EF_DOUBLE/EF_HALF_DAMAGE
// (defender sphere)/EF_TRACKERTRAIL effect bits alongside the existing
// EF_QUAD/EF_PENT tracking.
import { FRAME_stand01, FRAME_stand40, FRAME_run1, FRAME_run6, FRAME_pain101, FRAME_pain104, FRAME_pain201, FRAME_pain204, FRAME_pain301, FRAME_pain304, FRAME_jump1, FRAME_jump2, FRAME_jump3, FRAME_jump6, FRAME_crstnd01, FRAME_crstnd19, FRAME_crwalk1, FRAME_crwalk6, FRAME_crpain1, FRAME_crpain4 } from "./m_player_frames";

import {
  AngleVectors,
  DotProduct,
  type Vec3,
  vec3,
  vec3_origin,
  VectorAdd,
  VectorClear,
  VectorCopy,
  VectorMA,
  VectorNormalize,
  VectorSubtract,
} from "../shared/math";
import {
  ATTN_NORM,
  ATTN_STATIC,
  CHAN_AUTO,
  CHAN_BODY,
  CHAN_ITEM,
  CHAN_VOICE,
  CONTENTS_LAVA,
  CONTENTS_SLIME,
  CONTENTS_SOLID,
  CONTENTS_WATER,
  type CvarT,
  DF_NO_FALLING,
  EF_COLOR_SHELL,
  EF_DOUBLE,
  EF_HALF_DAMAGE,
  EF_PENT,
  EF_POWERSCREEN,
  EF_QUAD,
  EF_TRACKERTRAIL,
  EntityEventT,
  PITCH,
  PMF_DUCKED,
  RDF_IRGOGGLES,
  RDF_UNDERWATER,
  RF_IR_VISIBLE,
  RF_SHELL_BLUE,
  RF_SHELL_GREEN,
  RF_SHELL_RED,
  RF_TRANSLUCENT,
  RF_USE_DISGUISE,
  ROLL,
  STAT_FLASHES,
  YAW,
} from "../shared/q_shared";
import {
  ANIM_BASIC,
  ANIM_DEATH,
  ANIM_JUMP,
  ANIM_PAIN,
  ANIM_REVERSE,
  ANIM_WAVE,
  DAMAGE_NO_ARMOR,
  DAMAGE_TIME,
  DMGame,
  type EdictT,
  FALL_TIME,
  FL_DISGUISED,
  FL_GODMODE,
  FL_INWATER,
  FL_SAM_RAIMI,
  gameCvars,
  gameIndices,
  game,
  type GClientT,
  type GItemT,
  gi,
  level,
  MOD_FALLING,
  MOD_LAVA,
  MOD_SLIME,
  MOD_WATER,
  MovetypeT,
  PNOISE_SELF,
  POWER_ARMOR_SCREEN,
  POWER_ARMOR_SHIELD,
  world,
} from "./g_local";
import { T_Damage } from "./g_combat";
import { FindItemByClassname, PowerArmorType } from "./g_items";
import { DeathmatchScoreboardMessage, G_CheckChaseStats, G_SetSpectatorStats, G_SetStats } from "./p_hud";
import { PlayerNoise } from "./p_weapon";

// a per-file local mirrors other units' own cvarNum (module-local
// everywhere in this codebase, not a shared export) per the established
// house style (see p_weapon.ts).
function cvarNum(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}

// `static edict_t *current_player; static gclient_t *current_client;` --
// file-static globals in the C, reassigned each ClientEndServerFrame call.
let current_player: EdictT | null = null;
let current_client: GClientT | null = null;

// `static vec3_t forward, right, up;`
const forward: Vec3 = vec3();
const right: Vec3 = vec3();
const up: Vec3 = vec3();

// `float xyspeed; float bobmove; int bobcycle; float bobfracsin;` -- none
// of these have `static` in the C, but nothing outside p_view.c references
// them (confirmed by grep), so they stay file-local module state here too.
let xyspeed = 0;
let bobmove = 0;
let bobcycle = 0;
let bobfracsin = 0;

// `static vec3_t power_color = {0,1,0}; static vec3_t acolor = {1,1,1};
// static vec3_t bcolor = {1,0,0};` -- constant blend colors local to
// P_DamageFeedback in the C; module consts here since they never change.
const power_color: Vec3 = vec3(0.0, 1.0, 0.0);
const acolor: Vec3 = vec3(1.0, 1.0, 1.0);
const bcolor: Vec3 = vec3(1.0, 0.0, 0.0);

// `static int i;` inside P_DamageFeedback -- a function-local static that
// persists across every call (every player, every frame), cycling the pain
// animation choice process-wide. Ported as module state to preserve that.
let painAnimIndex = 0;

// ROGUE -- `static gitem_t *heatbeam;` inside SV_CalcGunOffset, lazily
// resolved on first use and cached process-wide (same treatment as
// painAnimIndex above).
let heatbeam: GItemT | null = null;

// `current_player`/`current_client`/`right` are file-static in the C with
// no external accessor -- there is no BSP-free way in the original C to set
// them either, since they are only ever assigned inside ClientEndServerFrame
// itself. These two exports exist solely so this unit's tests can exercise
// P_WorldEffects (which reads current_player/current_client) and SV_CalcRoll
// (which reads `right`) directly, without driving the entire
// ClientEndServerFrame pipeline (G_SetStats, SV_CalcBlend, item lookups,
// etc). They do not change any function's logic, only how test setup can
// reach this module's otherwise-private state. Same precedent as
// cmodel.ts's CM_MarkMapLoadedForTesting.
export function P_SetCurrentPlayerForTesting(ent: EdictT): void {
  current_player = ent;
  current_client = ent.client;
}
export function SV_SetRightVectorForTesting(newRight: Vec3): void {
  VectorCopy(newRight, right);
}

/*
===============
SV_CalcRoll

===============
*/
export function SV_CalcRoll(_angles: Vec3, velocity: Vec3): number {
  let side = DotProduct(velocity, right);
  const sign = side < 0 ? -1 : 1;
  side = Math.abs(side);

  const value = cvarNum(gameCvars.sv_rollangle);

  if (side < cvarNum(gameCvars.sv_rollspeed)) side = (side * value) / cvarNum(gameCvars.sv_rollspeed);
  else side = value;

  return side * sign;
}

/*
===============
P_DamageFeedback

Handles color blends and view kicks
===============
*/
export function P_DamageFeedback(player: EdictT): void {
  const client = player.client;
  if (client === null) return; // C assumes player->client is always valid for a player edict

  // flash the backgrounds behind the status numbers
  client.ps.stats[STAT_FLASHES] = 0;
  if (client.damage_blood) client.ps.stats[STAT_FLASHES] |= 1;
  if (client.damage_armor && (player.flags & FL_GODMODE) === 0 && client.invincible_framenum <= level.framenum)
    client.ps.stats[STAT_FLASHES] |= 2;

  // total points of damage shot at the player this frame
  let count = client.damage_blood + client.damage_armor + client.damage_parmor;
  if (count === 0) return; // didn't take any damage

  // start a pain animation if still in the player model
  if (client.anim_priority < ANIM_PAIN && player.s.modelindex === 255) {
    client.anim_priority = ANIM_PAIN;
    if ((client.ps.pmove.pm_flags & PMF_DUCKED) !== 0) {
      player.s.frame = FRAME_crpain1 - 1;
      client.anim_end = FRAME_crpain4;
    } else {
      painAnimIndex = (painAnimIndex + 1) % 3;
      switch (painAnimIndex) {
        case 0:
          player.s.frame = FRAME_pain101 - 1;
          client.anim_end = FRAME_pain104;
          break;
        case 1:
          player.s.frame = FRAME_pain201 - 1;
          client.anim_end = FRAME_pain204;
          break;
        case 2:
          player.s.frame = FRAME_pain301 - 1;
          client.anim_end = FRAME_pain304;
          break;
        default:
          break;
      }
    }
  }

  const realcount = count;
  if (count < 10) count = 10; // always make a visible effect

  // play an apropriate pain sound
  if (level.time > player.pain_debounce_time && (player.flags & FL_GODMODE) === 0 && client.invincible_framenum <= level.framenum) {
    // C: `rand()&1` -- see g_misc.ts's established house style for raw rand().
    const r = 1 + (Math.floor(Math.random() * 2) & 1);
    player.pain_debounce_time = level.time + 0.7;
    let l: number;
    if (player.health < 25) l = 25;
    else if (player.health < 50) l = 50;
    else if (player.health < 75) l = 75;
    else l = 100;
    gi.sound(player, CHAN_VOICE, gi.soundindex(`*pain${l}_${r}.wav`), 1, ATTN_NORM, 0);
  }

  // the total alpha of the blend is always proportional to count
  if (client.damage_alpha < 0) client.damage_alpha = 0;
  client.damage_alpha += count * 0.01;
  if (client.damage_alpha < 0.2) client.damage_alpha = 0.2;
  if (client.damage_alpha > 0.6) client.damage_alpha = 0.6; // don't go too saturated

  // the color of the blend will vary based on how much was absorbed
  // by different armors
  const v: Vec3 = vec3();
  if (client.damage_parmor) VectorMA(v, client.damage_parmor / realcount, power_color, v);
  if (client.damage_armor) VectorMA(v, client.damage_armor / realcount, acolor, v);
  if (client.damage_blood) VectorMA(v, client.damage_blood / realcount, bcolor, v);
  VectorCopy(v, client.damage_blend);

  //
  // calculate view angle kicks
  //
  let kick = Math.abs(client.damage_knockback);
  if (kick && player.health > 0) {
    // kick of 0 means no view adjust at all
    kick = (kick * 100) / player.health;

    if (kick < count * 0.5) kick = count * 0.5;
    if (kick > 50) kick = 50;

    VectorSubtract(client.damage_from, player.s.origin, v);
    VectorNormalize(v);

    let side = DotProduct(v, right);
    client.v_dmg_roll = kick * side * 0.3;

    side = -DotProduct(v, forward);
    client.v_dmg_pitch = kick * side * 0.3;

    client.v_dmg_time = level.time + DAMAGE_TIME;
  }

  //
  // clear totals
  //
  client.damage_blood = 0;
  client.damage_armor = 0;
  client.damage_parmor = 0;
  client.damage_knockback = 0;
}

/*
===============
SV_CalcViewOffset

Auto pitching on slopes?

  fall from 128: 400 = 160000
  fall from 256: 580 = 336400
  fall from 384: 720 = 518400
  fall from 512: 800 = 640000
  fall from 640: 960 =

  damage = deltavelocity*deltavelocity  * 0.0001

===============
*/
export function SV_CalcViewOffset(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  // base angles
  const angles = client.ps.kick_angles;
  let ratio: number;

  // if dead, fix the angle and don't add any kick
  if (ent.deadflag) {
    VectorClear(angles);

    if (ent.flags & FL_SAM_RAIMI) {
      client.ps.viewangles[ROLL] = 0;
      client.ps.viewangles[PITCH] = 0;
    } else {
      client.ps.viewangles[ROLL] = 40;
      client.ps.viewangles[PITCH] = -15;
    }
    client.ps.viewangles[YAW] = client.killer_yaw;
  } else {
    // add angles based on weapon kick
    VectorCopy(client.kick_angles, angles);

    // add angles based on damage kick
    ratio = (client.v_dmg_time - level.time) / DAMAGE_TIME;
    if (ratio < 0) {
      ratio = 0;
      client.v_dmg_pitch = 0;
      client.v_dmg_roll = 0;
    }
    angles[PITCH] += ratio * client.v_dmg_pitch;
    angles[ROLL] += ratio * client.v_dmg_roll;

    // add pitch based on fall kick
    ratio = (client.fall_time - level.time) / FALL_TIME;
    if (ratio < 0) ratio = 0;
    angles[PITCH] += ratio * client.fall_value;

    // add angles based on velocity
    let delta = DotProduct(ent.velocity, forward);
    angles[PITCH] += delta * cvarNum(gameCvars.run_pitch);

    delta = DotProduct(ent.velocity, right);
    angles[ROLL] += delta * cvarNum(gameCvars.run_roll);

    // add angles based on bob
    delta = bobfracsin * cvarNum(gameCvars.bob_pitch) * xyspeed;
    if ((client.ps.pmove.pm_flags & PMF_DUCKED) !== 0) delta *= 6; // crouching
    angles[PITCH] += delta;
    delta = bobfracsin * cvarNum(gameCvars.bob_roll) * xyspeed;
    if ((client.ps.pmove.pm_flags & PMF_DUCKED) !== 0) delta *= 6; // crouching
    if ((bobcycle & 1) !== 0) delta = -delta;
    angles[ROLL] += delta;
  }

  // base origin
  const v: Vec3 = vec3();

  // add view height
  v[2] += ent.viewheight;

  // add fall height
  ratio = (client.fall_time - level.time) / FALL_TIME;
  if (ratio < 0) ratio = 0;
  v[2] -= ratio * client.fall_value * 0.4;

  // add bob height
  let bob = bobfracsin * xyspeed * cvarNum(gameCvars.bob_up);
  if (bob > 6) bob = 6;
  v[2] += bob;

  // add kick offset
  VectorAdd(v, client.kick_origin, v);

  // absolutely bound offsets
  // so the view can never be outside the player box
  if (v[0] < -14) v[0] = -14;
  else if (v[0] > 14) v[0] = 14;
  if (v[1] < -14) v[1] = -14;
  else if (v[1] > 14) v[1] = 14;
  if (v[2] < -22) v[2] = -22;
  else if (v[2] > 30) v[2] = 30;

  VectorCopy(v, client.ps.viewoffset);
}

/*
==============
SV_CalcGunOffset
==============
*/
export function SV_CalcGunOffset(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  // ROGUE
  if (heatbeam === null) heatbeam = FindItemByClassname("weapon_plasmabeam");

  // ROGUE - heatbeam shouldn't bob so the beam looks right
  if (client.pers.weapon !== heatbeam) {
    // ROGUE
    // gun angles from bobbing
    client.ps.gunangles[ROLL] = xyspeed * bobfracsin * 0.005;
    client.ps.gunangles[YAW] = xyspeed * bobfracsin * 0.01;
    if ((bobcycle & 1) !== 0) {
      client.ps.gunangles[ROLL] = -client.ps.gunangles[ROLL];
      client.ps.gunangles[YAW] = -client.ps.gunangles[YAW];
    }

    client.ps.gunangles[PITCH] = xyspeed * bobfracsin * 0.005;

    // gun angles from delta movement
    for (let i = 0; i < 3; i++) {
      let delta = client.oldviewangles[i] - client.ps.viewangles[i];
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      if (delta > 45) delta = 45;
      if (delta < -45) delta = -45;
      if (i === YAW) client.ps.gunangles[ROLL] += 0.1 * delta;
      client.ps.gunangles[i] += 0.2 * delta;
    }
  }
  // ROGUE
  else {
    for (let i = 0; i < 3; i++) client.ps.gunangles[i] = 0;
  }
  //ROGUE

  // gun height
  VectorClear(client.ps.gunoffset);

  // gun_x / gun_y / gun_z are development tools
  for (let i = 0; i < 3; i++) {
    client.ps.gunoffset[i] += forward[i] * cvarNum(gameCvars.gun_y);
    client.ps.gunoffset[i] += right[i] * cvarNum(gameCvars.gun_x);
    client.ps.gunoffset[i] += up[i] * -cvarNum(gameCvars.gun_z);
  }
}

/*
=============
SV_AddBlend
=============
*/
export function SV_AddBlend(r: number, g: number, b: number, a: number, v_blend: Float32Array): void {
  if (a <= 0) return;
  const a2 = v_blend[3] + (1 - v_blend[3]) * a; // new total alpha
  const a3 = v_blend[3] / a2; // fraction of color from old

  v_blend[0] = v_blend[0] * a3 + r * (1 - a3);
  v_blend[1] = v_blend[1] * a3 + g * (1 - a3);
  v_blend[2] = v_blend[2] * a3 + b * (1 - a3);
  v_blend[3] = a2;
}

/*
=============
SV_CalcBlend
=============
*/
export function SV_CalcBlend(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  client.ps.blend[0] = 0;
  client.ps.blend[1] = 0;
  client.ps.blend[2] = 0;
  client.ps.blend[3] = 0;

  // add for contents
  const vieworg: Vec3 = vec3();
  VectorAdd(ent.s.origin, client.ps.viewoffset, vieworg);
  const contents = gi.pointcontents(vieworg);
  if ((contents & (CONTENTS_LAVA | CONTENTS_SLIME | CONTENTS_WATER)) !== 0) client.ps.rdflags |= RDF_UNDERWATER;
  else client.ps.rdflags &= ~RDF_UNDERWATER;

  if ((contents & (CONTENTS_SOLID | CONTENTS_LAVA)) !== 0) SV_AddBlend(1.0, 0.3, 0.0, 0.6, client.ps.blend);
  else if ((contents & CONTENTS_SLIME) !== 0) SV_AddBlend(0.0, 0.1, 0.05, 0.6, client.ps.blend);
  else if ((contents & CONTENTS_WATER) !== 0) SV_AddBlend(0.5, 0.3, 0.2, 0.4, client.ps.blend);

  // add for powerups
  if (client.quad_framenum > level.framenum) {
    const remaining = client.quad_framenum - level.framenum;
    if (remaining === 30) gi.sound(ent, CHAN_ITEM, gi.soundindex("items/damage2.wav"), 1, ATTN_NORM, 0);
    if (remaining > 30 || (remaining & 4) !== 0) SV_AddBlend(0, 0, 1, 0.08, client.ps.blend);
  }
  // PMM - double damage
  else if (client.double_framenum > level.framenum) {
    const remaining = client.double_framenum - level.framenum;
    if (remaining === 30) gi.sound(ent, CHAN_ITEM, gi.soundindex("misc/ddamage2.wav"), 1, ATTN_NORM, 0);
    if (remaining > 30 || (remaining & 4) !== 0) SV_AddBlend(0.9, 0.7, 0, 0.08, client.ps.blend);
  }
  // PMM
  else if (client.invincible_framenum > level.framenum) {
    const remaining = client.invincible_framenum - level.framenum;
    if (remaining === 30) gi.sound(ent, CHAN_ITEM, gi.soundindex("items/protect2.wav"), 1, ATTN_NORM, 0);
    if (remaining > 30 || (remaining & 4) !== 0) SV_AddBlend(1, 1, 0, 0.08, client.ps.blend);
  } else if (client.enviro_framenum > level.framenum) {
    const remaining = client.enviro_framenum - level.framenum;
    if (remaining === 30) gi.sound(ent, CHAN_ITEM, gi.soundindex("items/airout.wav"), 1, ATTN_NORM, 0);
    if (remaining > 30 || (remaining & 4) !== 0) SV_AddBlend(0, 1, 0, 0.08, client.ps.blend);
  } else if (client.breather_framenum > level.framenum) {
    const remaining = client.breather_framenum - level.framenum;
    if (remaining === 30) gi.sound(ent, CHAN_ITEM, gi.soundindex("items/airout.wav"), 1, ATTN_NORM, 0);
    if (remaining > 30 || (remaining & 4) !== 0) SV_AddBlend(0.4, 1, 0.4, 0.04, client.ps.blend);
  }

  // PGM
  if (client.nuke_framenum > level.framenum) {
    const brightness = (client.nuke_framenum - level.framenum) / 20.0;
    SV_AddBlend(1, 1, 1, brightness, client.ps.blend);
  }
  if (client.ir_framenum > level.framenum) {
    const remaining = client.ir_framenum - level.framenum;
    if (remaining > 30 || (remaining & 4) !== 0) {
      client.ps.rdflags |= RDF_IRGOGGLES;
      SV_AddBlend(1, 0, 0, 0.2, client.ps.blend);
    } else {
      client.ps.rdflags &= ~RDF_IRGOGGLES;
    }
  } else {
    client.ps.rdflags &= ~RDF_IRGOGGLES;
  }
  // PGM

  // add for damage
  if (client.damage_alpha > 0)
    SV_AddBlend(client.damage_blend[0], client.damage_blend[1], client.damage_blend[2], client.damage_alpha, client.ps.blend);

  if (client.bonus_alpha > 0) SV_AddBlend(0.85, 0.7, 0.3, client.bonus_alpha, client.ps.blend);

  // drop the damage value
  client.damage_alpha -= 0.06;
  if (client.damage_alpha < 0) client.damage_alpha = 0;

  // drop the bonus value
  client.bonus_alpha -= 0.1;
  if (client.bonus_alpha < 0) client.bonus_alpha = 0;
}

/*
=================
P_FallingDamage
=================
*/
export function P_FallingDamage(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if (ent.s.modelindex !== 255) return; // not in the player model

  if (ent.movetype === MovetypeT.MOVETYPE_NOCLIP) return;

  let delta: number;
  if (client.oldvelocity[2] < 0 && ent.velocity[2] > client.oldvelocity[2] && ent.groundentity === null) {
    delta = client.oldvelocity[2];
  } else {
    if (ent.groundentity === null) return;
    delta = ent.velocity[2] - client.oldvelocity[2];
  }
  delta = delta * delta * 0.0001;

  // never take falling damage if completely underwater
  if (ent.waterlevel === 3) return;
  if (ent.waterlevel === 2) delta *= 0.25;
  if (ent.waterlevel === 1) delta *= 0.5;

  if (delta < 1) return;

  if (delta < 15) {
    ent.s.event = EntityEventT.EV_FOOTSTEP;
    return;
  }

  client.fall_value = delta * 0.5;
  if (client.fall_value > 40) client.fall_value = 40;
  client.fall_time = level.time + FALL_TIME;

  if (delta > 30) {
    if (ent.health > 0) {
      ent.s.event = delta >= 55 ? EntityEventT.EV_FALLFAR : EntityEventT.EV_FALL;
    }
    ent.pain_debounce_time = level.time; // no normal pain sound
    let damage = ((delta - 30) / 2) | 0;
    if (damage < 1) damage = 1;
    const dir: Vec3 = vec3(0, 0, 1);

    if (cvarNum(gameCvars.deathmatch) === 0 || ((cvarNum(gameCvars.dmflags) | 0) & DF_NO_FALLING) === 0)
      T_Damage(ent, world(), world(), dir, ent.s.origin, vec3_origin, damage, 0, 0, MOD_FALLING);
  } else {
    ent.s.event = EntityEventT.EV_FALLSHORT;
    return;
  }
}

/*
=============
P_WorldEffects
=============
*/
export function P_WorldEffects(): void {
  const ent = current_player;
  const client = current_client;
  if (ent === null || client === null) return;

  if (ent.movetype === MovetypeT.MOVETYPE_NOCLIP) {
    ent.air_finished = level.time + 12; // don't need air
    return;
  }

  const waterlevel = ent.waterlevel;
  const old_waterlevel = client.old_waterlevel;
  client.old_waterlevel = waterlevel;

  const breather = client.breather_framenum > level.framenum;
  const envirosuit = client.enviro_framenum > level.framenum;

  //
  // if just entered a water volume, play a sound
  //
  if (old_waterlevel === 0 && waterlevel !== 0) {
    PlayerNoise(ent, ent.s.origin, PNOISE_SELF);
    if ((ent.watertype & CONTENTS_LAVA) !== 0) gi.sound(ent, CHAN_BODY, gi.soundindex("player/lava_in.wav"), 1, ATTN_NORM, 0);
    else if ((ent.watertype & CONTENTS_SLIME) !== 0) gi.sound(ent, CHAN_BODY, gi.soundindex("player/watr_in.wav"), 1, ATTN_NORM, 0);
    else if ((ent.watertype & CONTENTS_WATER) !== 0) gi.sound(ent, CHAN_BODY, gi.soundindex("player/watr_in.wav"), 1, ATTN_NORM, 0);
    ent.flags |= FL_INWATER;

    // clear damage_debounce, so the pain sound will play immediately
    ent.damage_debounce_time = level.time - 1;
  }

  //
  // if just completely exited a water volume, play a sound
  //
  if (old_waterlevel !== 0 && waterlevel === 0) {
    PlayerNoise(ent, ent.s.origin, PNOISE_SELF);
    gi.sound(ent, CHAN_BODY, gi.soundindex("player/watr_out.wav"), 1, ATTN_NORM, 0);
    ent.flags &= ~FL_INWATER;
  }

  //
  // check for head just going under water
  //
  if (old_waterlevel !== 3 && waterlevel === 3) {
    gi.sound(ent, CHAN_BODY, gi.soundindex("player/watr_un.wav"), 1, ATTN_NORM, 0);
  }

  //
  // check for head just coming out of water
  //
  if (old_waterlevel === 3 && waterlevel !== 3) {
    if (ent.air_finished < level.time) {
      // gasp for air
      gi.sound(ent, CHAN_VOICE, gi.soundindex("player/gasp1.wav"), 1, ATTN_NORM, 0);
      PlayerNoise(ent, ent.s.origin, PNOISE_SELF);
    } else if (ent.air_finished < level.time + 11) {
      // just break surface
      gi.sound(ent, CHAN_VOICE, gi.soundindex("player/gasp2.wav"), 1, ATTN_NORM, 0);
    }
  }

  //
  // check for drowning
  //
  if (waterlevel === 3) {
    // breather or envirosuit give air
    if (breather || envirosuit) {
      ent.air_finished = level.time + 10;

      if ((client.breather_framenum - level.framenum) % 25 === 0) {
        if (client.breather_sound === 0) gi.sound(ent, CHAN_AUTO, gi.soundindex("player/u_breath1.wav"), 1, ATTN_NORM, 0);
        else gi.sound(ent, CHAN_AUTO, gi.soundindex("player/u_breath2.wav"), 1, ATTN_NORM, 0);
        client.breather_sound ^= 1;
        PlayerNoise(ent, ent.s.origin, PNOISE_SELF);
        //FIXME: release a bubble?
      }
    }

    // if out of air, start drowning
    if (ent.air_finished < level.time) {
      // drown!
      if (client.next_drown_time < level.time && ent.health > 0) {
        client.next_drown_time = level.time + 1;

        // take more damage the longer underwater
        ent.dmg += 2;
        if (ent.dmg > 15) ent.dmg = 15;

        // play a gurp sound instead of a normal pain sound
        if (ent.health <= ent.dmg) gi.sound(ent, CHAN_VOICE, gi.soundindex("player/drown1.wav"), 1, ATTN_NORM, 0);
        else if ((Math.floor(Math.random() * 2) & 1) !== 0) gi.sound(ent, CHAN_VOICE, gi.soundindex("*gurp1.wav"), 1, ATTN_NORM, 0);
        else gi.sound(ent, CHAN_VOICE, gi.soundindex("*gurp2.wav"), 1, ATTN_NORM, 0);

        ent.pain_debounce_time = level.time;

        T_Damage(ent, world(), world(), vec3_origin, ent.s.origin, vec3_origin, ent.dmg, 0, DAMAGE_NO_ARMOR, MOD_WATER);
      }
    }
  } else {
    ent.air_finished = level.time + 12;
    ent.dmg = 2;
  }

  //
  // check for sizzle damage
  //
  if (waterlevel !== 0 && (ent.watertype & (CONTENTS_LAVA | CONTENTS_SLIME)) !== 0) {
    if ((ent.watertype & CONTENTS_LAVA) !== 0) {
      if (ent.health > 0 && ent.pain_debounce_time <= level.time && client.invincible_framenum < level.framenum) {
        if ((Math.floor(Math.random() * 2) & 1) !== 0) gi.sound(ent, CHAN_VOICE, gi.soundindex("player/burn1.wav"), 1, ATTN_NORM, 0);
        else gi.sound(ent, CHAN_VOICE, gi.soundindex("player/burn2.wav"), 1, ATTN_NORM, 0);
        ent.pain_debounce_time = level.time + 1;
      }

      if (envirosuit)
        // take 1/3 damage with envirosuit
        T_Damage(ent, world(), world(), vec3_origin, ent.s.origin, vec3_origin, 1 * waterlevel, 0, 0, MOD_LAVA);
      else T_Damage(ent, world(), world(), vec3_origin, ent.s.origin, vec3_origin, 3 * waterlevel, 0, 0, MOD_LAVA);
    }

    if ((ent.watertype & CONTENTS_SLIME) !== 0) {
      if (!envirosuit) {
        // no damage from slime with envirosuit
        T_Damage(ent, world(), world(), vec3_origin, ent.s.origin, vec3_origin, 1 * waterlevel, 0, 0, MOD_SLIME);
      }
    }
  }
}

/*
===============
G_SetClientEffects
===============
*/
export function G_SetClientEffects(ent: EdictT): void {
  ent.s.effects = 0;
  // ent.s.renderfx = 0;

  // PGM - player is always ir visible, even dead.
  ent.s.renderfx = RF_IR_VISIBLE;

  if (ent.health <= 0 || level.intermissiontime !== 0) return;

  //=========
  //PGM
  if (ent.flags & FL_DISGUISED) ent.s.renderfx |= RF_USE_DISGUISE;

  const gamerules = gameCvars.gamerules;
  if (gamerules !== null && gamerules.value) {
    if (DMGame.PlayerEffects) DMGame.PlayerEffects(ent);
  }
  //PGM
  //=========

  if (ent.powerarmor_time > level.time) {
    const pa_type = PowerArmorType(ent);
    if (pa_type === POWER_ARMOR_SCREEN) {
      ent.s.effects |= EF_POWERSCREEN;
    } else if (pa_type === POWER_ARMOR_SHIELD) {
      ent.s.effects |= EF_COLOR_SHELL;
      ent.s.renderfx |= RF_SHELL_GREEN;
    }
  }

  const client = ent.client;
  if (client !== null) {
    if (client.quad_framenum > level.framenum) {
      const remaining = client.quad_framenum - level.framenum;
      if (remaining > 30 || (remaining & 4) !== 0) ent.s.effects |= EF_QUAD;
    }

    //=======
    //ROGUE
    if (client.double_framenum > level.framenum) {
      const remaining = client.double_framenum - level.framenum;
      if (remaining > 30 || (remaining & 4) !== 0) ent.s.effects |= EF_DOUBLE;
    }
    if (client.owned_sphere !== null && client.owned_sphere.spawnflags === 1) {
      ent.s.effects |= EF_HALF_DAMAGE;
    }
    if (client.tracker_pain_framenum > level.framenum) {
      ent.s.effects |= EF_TRACKERTRAIL;
    }
    //ROGUE
    //=======

    if (client.invincible_framenum > level.framenum) {
      const remaining = client.invincible_framenum - level.framenum;
      if (remaining > 30 || (remaining & 4) !== 0) ent.s.effects |= EF_PENT;
    }

    // RE-RELEASE CONTENT PORT -- item_invisibility (the cloak), placed by
    // rdm14. See g_items.ts's Use_Invisibility.
    //
    // The re-release draws this with a dedicated fade shader driven by
    // `invisibility_fade_time`, which protocol 34 has no representation for.
    // RF_TRANSLUCENT is the closest thing this module's renderer and its
    // protocol both already understand, so the cloak reads as translucency
    // rather than the re-release's ramped fade -- the player is visibly
    // cloaked, just not with the re-release's exact look. The same
    // >30-or-blink tail every other powerup here uses gives the
    // about-to-expire warning flicker.
    if (client.invisible_framenum > level.framenum) {
      const remaining = client.invisible_framenum - level.framenum;
      if (remaining > 30 || (remaining & 4) !== 0) ent.s.renderfx |= RF_TRANSLUCENT;
    }
  }

  // show cheaters!!!
  if ((ent.flags & FL_GODMODE) !== 0) {
    ent.s.effects |= EF_COLOR_SHELL;
    ent.s.renderfx |= RF_SHELL_RED | RF_SHELL_GREEN | RF_SHELL_BLUE;
  }
}

/*
===============
G_SetClientEvent
===============
*/
export function G_SetClientEvent(ent: EdictT): void {
  if (ent.s.event !== 0) return;

  if (ent.groundentity !== null && xyspeed > 225) {
    if (current_client !== null && Math.trunc(current_client.bobtime + bobmove) !== bobcycle) ent.s.event = EntityEventT.EV_FOOTSTEP;
  }
}

/*
===============
G_SetClientSound
===============
*/
export function G_SetClientSound(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if (client.pers.game_helpchanged !== game.helpchanged) {
    client.pers.game_helpchanged = game.helpchanged;
    client.pers.helpchanged = 1;
  }

  // help beep (no more than three times)
  if (client.pers.helpchanged !== 0 && client.pers.helpchanged <= 3 && (level.framenum & 63) === 0) {
    client.pers.helpchanged++;
    gi.sound(ent, CHAN_VOICE, gi.soundindex("misc/pc_up.wav"), 1, ATTN_STATIC, 0);
  }

  const weap = client.pers.weapon !== null ? (client.pers.weapon.classname ?? "") : "";

  if (ent.waterlevel !== 0 && (ent.watertype & (CONTENTS_LAVA | CONTENTS_SLIME)) !== 0) ent.s.sound = gameIndices.snd_fry;
  else if (weap === "weapon_railgun") ent.s.sound = gi.soundindex("weapons/rg_hum.wav");
  else if (weap === "weapon_bfg") ent.s.sound = gi.soundindex("weapons/bfg_hum.wav");
  else if (client.weapon_sound !== 0) ent.s.sound = client.weapon_sound;
  else ent.s.sound = 0;
}

/*
===============
G_SetClientFrame
===============
*/
export function G_SetClientFrame(ent: EdictT): void {
  if (ent.s.modelindex !== 255) return; // not in the player model

  const client = ent.client;
  if (client === null) return;

  const duck = (client.ps.pmove.pm_flags & PMF_DUCKED) !== 0;
  const run = xyspeed !== 0;

  // check for stand/duck and stop/go transitions -- `goto newanim` in the C
  // fires from any of these three conditions, or by falling through the
  // block below; both paths converge on the same code, ported as one
  // straight-line function since nothing after this point depends on which
  // path was taken.
  const gotoNewanim =
    (duck !== client.anim_duck && client.anim_priority < ANIM_DEATH) ||
    (run !== client.anim_run && client.anim_priority === ANIM_BASIC) ||
    (ent.groundentity === null && client.anim_priority <= ANIM_WAVE);

  if (!gotoNewanim) {
    if (client.anim_priority === ANIM_REVERSE) {
      if (ent.s.frame > client.anim_end) {
        ent.s.frame--;
        return;
      }
    } else if (ent.s.frame < client.anim_end) {
      // continue an animation
      ent.s.frame++;
      return;
    }

    if (client.anim_priority === ANIM_DEATH) return; // stay there
    if (client.anim_priority === ANIM_JUMP) {
      if (ent.groundentity === null) return; // stay there
      client.anim_priority = ANIM_WAVE;
      ent.s.frame = FRAME_jump3;
      client.anim_end = FRAME_jump6;
      return;
    }
  }

  // newanim:
  // return to either a running or standing frame
  client.anim_priority = ANIM_BASIC;
  client.anim_duck = duck;
  client.anim_run = run;

  if (ent.groundentity === null) {
    client.anim_priority = ANIM_JUMP;
    if (ent.s.frame !== FRAME_jump2) ent.s.frame = FRAME_jump1;
    client.anim_end = FRAME_jump2;
  } else if (run) {
    // running
    if (duck) {
      ent.s.frame = FRAME_crwalk1;
      client.anim_end = FRAME_crwalk6;
    } else {
      ent.s.frame = FRAME_run1;
      client.anim_end = FRAME_run6;
    }
  } else {
    // standing
    if (duck) {
      ent.s.frame = FRAME_crstnd01;
      client.anim_end = FRAME_crstnd19;
    } else {
      ent.s.frame = FRAME_stand01;
      client.anim_end = FRAME_stand40;
    }
  }
}

/*
=================
ClientEndServerFrame

Called for each player at the end of the server frame
and right after spawning
=================
*/
export function ClientEndServerFrame(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  current_player = ent;
  current_client = client;

  //
  // If the origin or velocity have changed since ClientThink(),
  // update the pmove values.  This will happen when the client
  // is pushed by a bmodel or kicked by an explosion.
  //
  // If it wasn't updated here, the view position would lag a frame
  // behind the body position when pushed -- "sinking into plats"
  //
  for (let i = 0; i < 3; i++) {
    client.ps.pmove.origin[i] = ent.s.origin[i] * 8.0;
    client.ps.pmove.velocity[i] = ent.velocity[i] * 8.0;
  }

  //
  // If the end of unit layout is displayed, don't give
  // the player any normal movement attributes
  //
  if (level.intermissiontime !== 0) {
    // FIXME: add view drifting here?
    client.ps.blend[3] = 0;
    client.ps.fov = 90;
    G_SetStats(ent);
    return;
  }

  AngleVectors(client.v_angle, forward, right, up);

  // burn from lava, etc
  P_WorldEffects();

  //
  // set model angles from view angles so other things in
  // the world can tell which direction you are looking
  //
  if (client.v_angle[PITCH] > 180) ent.s.angles[PITCH] = (-360 + client.v_angle[PITCH]) / 3;
  else ent.s.angles[PITCH] = client.v_angle[PITCH] / 3;
  ent.s.angles[YAW] = client.v_angle[YAW];
  ent.s.angles[ROLL] = 0;
  ent.s.angles[ROLL] = SV_CalcRoll(ent.s.angles, ent.velocity) * 4;

  //
  // calculate speed and cycle to be used for
  // all cyclic walking effects
  //
  xyspeed = Math.sqrt(ent.velocity[0] * ent.velocity[0] + ent.velocity[1] * ent.velocity[1]);

  if (xyspeed < 5) {
    bobmove = 0;
    client.bobtime = 0; // start at beginning of cycle again
  } else if (ent.groundentity !== null) {
    // so bobbing only cycles when on ground
    if (xyspeed > 210) bobmove = 0.25;
    else if (xyspeed > 100) bobmove = 0.125;
    else bobmove = 0.0625;
  }

  client.bobtime += bobmove;
  let bobtime = client.bobtime;

  if ((client.ps.pmove.pm_flags & PMF_DUCKED) !== 0) bobtime *= 4;

  bobcycle = Math.trunc(bobtime);
  bobfracsin = Math.abs(Math.sin(bobtime * Math.PI));

  // detect hitting the floor
  P_FallingDamage(ent);

  // apply all the damage taken this frame
  P_DamageFeedback(ent);

  // determine the view offsets
  SV_CalcViewOffset(ent);

  // determine the gun offsets
  SV_CalcGunOffset(ent);

  // determine the full screen color blend
  // must be after viewoffset, so eye contents can be
  // accurately determined
  // FIXME: with client prediction, the contents
  // should be determined by the client
  SV_CalcBlend(ent);

  // chase cam stuff
  if (client.resp.spectator) G_SetSpectatorStats(ent);
  else G_SetStats(ent);

  G_CheckChaseStats(ent);

  G_SetClientEvent(ent);

  G_SetClientEffects(ent);

  G_SetClientSound(ent);

  G_SetClientFrame(ent);

  VectorCopy(ent.velocity, client.oldvelocity);
  VectorCopy(client.ps.viewangles, client.oldviewangles);

  // clear weapon kicks
  VectorClear(client.kick_origin);
  VectorClear(client.kick_angles);

  // if the scoreboard is up, update it
  if (client.showscores && (level.framenum & 31) === 0) {
    DeathmatchScoreboardMessage(ent, ent.enemy);
    gi.unicast(ent, false);
  }
}
