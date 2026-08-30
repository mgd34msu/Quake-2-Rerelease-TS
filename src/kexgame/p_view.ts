// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// p_view.c -- player eye view (2023 Quake II re-release / "KEX" engine).
// Ported from ~/Projects/quake2-rerelease-dll/rerelease/p_view.cpp
// (1,556 lines, C++17): SV_CalcRoll, P_DamageFeedback (damage kicks),
// SV_CalcViewOffset (falling/bob/kick view offsets), SV_CalcGunOffset,
// SV_CalcBlend (incl. the KEX screen_blend/damage_blend split), P_WorldEffects
// (drowning/lava/slime), G_SetClientEffects/Event/Sound/Frame,
// G_LagCompensate/G_UnLagCompensate, ClientEndServerFrame.
//
// ============================================================================
// FIELD NAMING: screen_blend/damage_blend, not blend/damage_blend
// ============================================================================
// The legacy/vanilla port's `PlayerStateT` (src/shared/q_shared.ts) renames
// the KEX source's `ps.screen_blend` to `blend` ("KEX renames this field
// screen_blend -- the kex binding maps blend <-> screen_blend at the
// boundary. Do not rename."). That comment describes the LEGACY port's own
// field; this port line's own player state type, `KexPlayerStateT`
// (src/kexapi/game.ts:1409-1410), already carries the KEX names directly
// (`screen_blend`/`damage_blend`), so every call site below uses
// `ps.screen_blend`/`ps.damage_blend` verbatim -- no renaming needed here.
// `gclient_t::damage_blend` (a `Vec3`, g_local.h:2882) is a SEPARATE field
// from `ps.damage_blend` (a `Vec4`) -- the client-side accumulator P_DamageFeedback
// writes into every frame, which SV_CalcBlend then blends into `ps.damage_blend`.
// Confirmed by grepping the whole rerelease/ tree for both names before writing
// this file (p_view.cpp:216/568/657, g_local.h:2882, game.h:1438-1439).
//
// ============================================================================
// UNPORTED CROSS-DEPS -- inventory (see PORTING.md: "a function you cannot
// port faithfully is a reported deviation, not a TODO"; g_combat.ts's own
// header established the "throwing, unexported, cited stub" idiom this file
// follows, plus the "unconditionally-reached can't be a stub" corollary)
// ============================================================================
// REAL (fully self-contained; ported here despite living in another,
// not-yet-landed C++ file -- same "small self-contained function" precedent
// g_combat.ts set for ArmorIndex/PowerArmorType):
//   - P_CurrentKickFactor/P_CurrentKickAngles/P_CurrentKickOrigin (p_weapon.cpp:62-78)
//   - PlayerNoise (p_weapon.cpp:148-227)
//   - G_TeamplayEnabled (ctf/g_ctf.cpp:55-58: `ctf->integer || teamplay->integer`)
//   - CTFEffects/CTFSetPowerUpEffect (ctf/g_ctf.cpp:868-888/3854-3862): pure
//     field reads against IT_FLAG1/IT_FLAG2/EF_FLAG1/EF_FLAG2/resp.ctf_team,
//     all already-ported fields; no CTF match-state global needed.
//   - CTFApplyRegeneration (ctf/g_ctf.cpp:2080-2119): pure field logic +
//     ArmorIndex (g_combat.ts) + gi.sound; no CTF match-state global needed.
//   - G_LagCompensate/G_UnLagCompensate/G_SaveLagCompensation (this file's
//     own p_view.cpp:1250-1334): every field they touch
//     (num_lag_origins/next_lag_origin/is_lag_compensated/lag_restore_origin/
//     cmd.server_frame, game.max_lag_origins/lag_origins) is already ported.
//
// NARROW STUBS (throw, cited; reached only on a genuinely guarded path that
// this unit's own default-cvar/default-fixture test suite does not exercise):
//   - modelindex_flag1/modelindex_flag2 (CTFEffects): CTF module globals set
//     by PrecacheItem (ctf/g_ctf.cpp, not ported) -- concrete default 0 (see
//     "CTFMatchSetup/DMGame -- concrete faithful values" precedent in
//     g_combat.ts), NOT a throw: reached only if IT_FLAG1/IT_FLAG2 inventory
//     is ever nonzero, which nothing in this port line's spawn code can do yet.
//   - Bot_EndFrame -> bots/bot_includes.h (future src/kexgame/bots/) --
//     reached only when `ent.svflags & SVF_BOT`.
//   - PMenu_Do_Update -> ctf/p_ctf_menu.cpp (future) -- reached only when
//     `ent.client.menu !== null` (always null; no CTF menu spawn code exists).
//   - G_ShouldPlayersCollide -> p_client.cpp:2996 (future src/kexgame/p_client.ts)
//     -- same stub g_utils.ts already carries for the identical reason;
//     duplicated here per that file's own "local, unexported stub" precedent
//     (each file keeps its own copy rather than importing across modules).
//     Reached only in coop with G_ShouldPlayersCollide(false) actually needed.
//   - P_ForceFogTransition's protocol body (p_client.cpp:1788-1910+): the
//     function's own early-return guard (`client.fog === pers.wanted_fog &&
//     client.heightfog === pers.wanted_heightfog`) is ported for real; only
//     the svc_fog packet-writing tail (reached when they differ -- nothing in
//     this port line's trigger_fog-equivalent code exists yet to make them
//     differ) is a narrow stub.
//   - P_AssignClientSkinnum's packing tail (p_client.cpp:1741-1766): the
//     `ent.s.modelindex !== 255` early return is real; the KexPlayerSkinnumT
//     bitfield pack (client_num/vwep_index/viewheight/team_index/poi_icon ->
//     .skinnum) has no ported bit-layout helper anywhere in this port line
//     (the type only declares named fields + the raw int32, no pack/unpack
//     function) and inventing one without the real union's bit widths would
//     risk a silent wire-format bug, so it stays a narrow, cited stub.
//   - P_SendLevelPOI (p_client.cpp:1771-1782), used by Compass_Update:
//     Compass_Update's own early return (`if (!points) return;`, p_view.cpp's
//     porting-target is actually g_items.cpp:1499) makes this unreachable by
//     default -- `level.poi_points[...]` is never populated anywhere in this
//     port line (no POI-setting call site exists yet).
//
// CTF_GRAPPLE_STATE_FLY/PULL/HANG (ctf/g_ctf.h:16-20): a plain 3-value enum
// with no CTF-module state attached to its own numbering -- ported here as
// local numeric constants (0/1/2, matching the C++ declaration order
// exactly), not a stub. `ctf_grapplestate` itself is already a plain
// `number` field (g_local_types.ts), never written anywhere in this port
// line (no grapple-fire code exists yet), so it is always 0
// (=FLY) by construction; SkipViewModifiers's `> CTF_GRAPPLE_STATE_FLY`
// check is therefore always false today, exactly matching "no grapple in
// flight" in the real game.
//
// `xyspeed`/`bobmove`/`bobcycle`/`bobcycle_run`/`bobfracsin` (p_view.cpp:12-16,
// C file-scope globals shared with g_weapon.cpp): module-scope `let`s here,
// per the `current_player`/`current_client` precedent this file already
// needs for the same reason (C's other file-scope statics). g_target.ts
// independently carries its OWN private `let xyspeed = 0;` stub (that
// file's own header: "extern float xyspeed; (p_view.cpp) -- see file header",
// pending this unit) -- the two are NOT the same binding (TS has no
// cross-module `extern`), so g_target.ts's copy stays permanently zero even
// after this landing. Reported as a follow-up: a future unit that touches
// g_target.ts should either import `xyspeed`'s real value from here (this
// file would need to export it) or accept the two-copy split permanently.

import { type Vec3, vec3, VectorCopy } from "../shared/math";
import {
  ATTN_NORM,
  ATTN_STATIC,
  ContentsT,
  CvarFlagsT,
  EffectsT,
  KexEntityEventT,
  KexMulticastT,
  MODELINDEX_PLAYER,
  PmflagsT,
  RefdefFlagsT,
  RenderfxT,
  ServerCommandT,
  SoundchanT,
  SvflagsT,
  type Vec4,
  WaterLevelT,
} from "../kexapi/game";
import {
  AnimPriorityT,
  CtfteamT,
  DAMAGE_TIME,
  DAMAGE_TIME_SLACK,
  DamageflagsT,
  type EdictT,
  EntFlagsT,
  FALL_TIME,
  INVISIBILITY_TIME,
  ItemIdT,
  LADDER_SOUND_TIME,
  MAX_DAMAGE_INDICATORS,
  ModIdT,
  MovetypeT,
  PlayerNoiseT,
  SPHERE_DEFENDER,
  WeaponstateT,
} from "./g_local";
import { gi, g_edicts, game, level } from "./g_main_globals";
import { type GTime, Gtime_add, Gtime_divide, Gtime_from_hz, Gtime_from_ms, Gtime_milliseconds, Gtime_nonzero, Gtime_seconds, Gtime_subtract, GTIME_ZERO } from "./gtime";
import { AngleVectors, vec3_add, vec3_dot, vec3_length, vec3_muls, vec3_normalized, vec3_sub } from "./q_vec3";
import { PITCH, ROLL, YAW, brandom, clamp, crandom_open } from "./q_std";
import {
  FRAME_crpain1,
  FRAME_crpain4,
  FRAME_crstnd01,
  FRAME_crstnd19,
  FRAME_crwalk1,
  FRAME_crwalk2,
  FRAME_crwalk6,
  FRAME_jump1,
  FRAME_jump2,
  FRAME_jump3,
  FRAME_jump4,
  FRAME_jump6,
  FRAME_pain101,
  FRAME_pain104,
  FRAME_pain201,
  FRAME_pain204,
  FRAME_pain301,
  FRAME_pain304,
  FRAME_run1,
  FRAME_run6,
  FRAME_stand01,
  FRAME_stand40,
} from "./m_player";
import { ArmorIndex, PowerArmorType, T_Damage } from "./g_combat";
import { G_Spawn } from "./g_utils";
import { G_PlayerNotifyGoal } from "./g_target";
import { DeathmatchScoreboardMessage, G_CheckChaseStats, G_SetCoopStats, G_SetSpectatorStats, G_SetStats, PlayerStatT } from "./p_hud";

// ---------------------------------------------------------------------------
// cvar-read helpers (see g_combat.ts's own precedent for this exact idiom)
// ---------------------------------------------------------------------------

function cvarFloat(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): number {
  const c = gi.cvar(name, def, flags);
  return c === null ? Number(def) : c.value;
}

function cvarInt(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): number {
  return Math.trunc(cvarFloat(name, def, flags));
}

function cvarBool(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): boolean {
  return cvarInt(name, def, flags) !== 0;
}

// ---------------------------------------------------------------------------
// G_TeamplayEnabled -- ported here, not a stub (see file header)
// ---------------------------------------------------------------------------

/** ctf/g_ctf.cpp:55-58: `bool G_TeamplayEnabled() { return ctf->integer || teamplay->integer; }` */
export function G_TeamplayEnabled(): boolean {
  return (
    cvarBool("ctf", "0", CvarFlagsT.CVAR_SERVERINFO | CvarFlagsT.CVAR_LATCH) || cvarBool("teamplay", "0", CvarFlagsT.CVAR_LATCH)
  );
}

/** ctf/g_ctf.h:16-20 `enum ctfteam_grapple_state_t` -- see file header. */
const CTF_GRAPPLE_STATE_FLY = 0;

// ---------------------------------------------------------------------------
// module-scope statics (see file header)
// ---------------------------------------------------------------------------

let current_player: EdictT | null = null;
let current_client: EdictT["client"] = null;

const forward: Vec3 = vec3();
const right: Vec3 = vec3();
const up: Vec3 = vec3();

let xyspeed = 0;
let bobmove = 0;
let bobcycle = 0;
let bobcycle_run = 0;
let bobfracsin = 0;

// ---------------------------------------------------------------------------
// unported cross-deps (narrow throwing stubs) -- see file header
// ---------------------------------------------------------------------------

function Bot_EndFrame(_ent: EdictT): void {
  throw new Error("Bot_EndFrame: not yet ported (pending bots/, see bots/bot_includes.h)");
}

function PMenu_Do_Update(_ent: EdictT): void {
  throw new Error("PMenu_Do_Update: not yet ported (pending p_ctf_menu.ts, see ctf/p_ctf_menu.cpp)");
}

/** Same stub g_utils.ts carries under this exact name; see that file's own
 *  "local, unexported stub" precedent and this file's header. */
function G_ShouldPlayersCollide(_weaponry: boolean): boolean {
  throw new Error("G_ShouldPlayersCollide: not yet ported (pending p_client.ts, see p_client.cpp:2996)");
}

function sendFogTransition(_ent: EdictT, _instant: boolean): void {
  throw new Error("P_ForceFogTransition (svc_fog write): not yet ported (pending p_client.ts, see p_client.cpp:1788-1910)");
}

function packClientSkinnum(_ent: EdictT): void {
  throw new Error(
    "P_AssignClientSkinnum (bitfield pack): not yet ported -- no ported player_skinnum_t bit-layout helper exists (pending p_client.ts, see p_client.cpp:1741)",
  );
}

function sendLevelPOI(_ent: EdictT): void {
  throw new Error("P_SendLevelPOI: not yet ported (pending p_client.ts, see p_client.cpp:1771)");
}

// ---------------------------------------------------------------------------
// P_CurrentKickFactor / P_CurrentKickAngles / P_CurrentKickOrigin -- ported
// here, not a stub (see file header)
// ---------------------------------------------------------------------------

/** p_weapon.cpp:62-68: `float P_CurrentKickFactor(edict_t *ent)`. */
function P_CurrentKickFactor(ent: EdictT): number {
  const client = ent.client;
  if (client === null) return 0;
  if (client.kick.time < level.time) return 0;
  return Gtime_seconds(Gtime_subtract(client.kick.time, level.time)) / Gtime_seconds(client.kick.total);
}

/** p_weapon.cpp:71-74: `vec3_t P_CurrentKickAngles(edict_t *ent)`. */
function P_CurrentKickAngles(ent: EdictT): Vec3 {
  const client = ent.client;
  if (client === null) return vec3();
  return vec3_muls(client.kick.angles, P_CurrentKickFactor(ent));
}

/** p_weapon.cpp:76-79: `vec3_t P_CurrentKickOrigin(edict_t *ent)`. */
function P_CurrentKickOrigin(ent: EdictT): Vec3 {
  const client = ent.client;
  if (client === null) return vec3();
  return vec3_muls(client.kick.origin, P_CurrentKickFactor(ent));
}

// ---------------------------------------------------------------------------
// PlayerNoise -- ported here, not a stub (see file header)
// ---------------------------------------------------------------------------

/** p_weapon.cpp:148-227: `void PlayerNoise(edict_t *who, const vec3_t &where, player_noise_t type)`. */
export function PlayerNoise(who: EdictT, where: Vec3, type: PlayerNoiseT): void {
  const client = who.client;
  if (client === null) return;

  if (type === PlayerNoiseT.PNOISE_WEAPON) {
    client.invisibility_fade_time = Gtime_add(level.time, client.silencer_shots ? Gtime_divide(INVISIBILITY_TIME, 5) : INVISIBILITY_TIME);

    if (client.silencer_shots) {
      client.silencer_shots--;
      return;
    }
  }

  if (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) return;

  if ((who.flags & EntFlagsT.FL_NOTARGET) !== 0n) return;

  if (type === PlayerNoiseT.PNOISE_SELF && (client.landmark_free_fall || client.landmark_noise_time >= level.time)) return;

  // ROGUE
  if ((who.flags & EntFlagsT.FL_DISGUISED) !== 0n) {
    if (type === PlayerNoiseT.PNOISE_WEAPON) {
      level.disguise_violator = who;
      level.disguise_violation_time = Gtime_add(level.time, Gtime_from_ms(500));
    } else return;
  }
  // ROGUE

  if (who.mynoise === null) {
    const n1 = G_Spawn();
    n1.classname = "player_noise";
    n1.mins = vec3(-8, -8, -8);
    n1.maxs = vec3(8, 8, 8);
    n1.owner = who;
    who.mynoise = n1;

    const n2 = G_Spawn();
    n2.classname = "player_noise";
    n2.mins = vec3(-8, -8, -8);
    n2.maxs = vec3(8, 8, 8);
    n2.owner = who;
    who.mynoise2 = n2;
  }

  let noise: EdictT;

  if (type === PlayerNoiseT.PNOISE_SELF || type === PlayerNoiseT.PNOISE_WEAPON) {
    if (who.mynoise === null) throw new Error("PlayerNoise: mynoise unset after initialization -- unreachable");
    noise = who.mynoise;
    client.sound_entity = noise;
    client.sound_entity_time = level.time;
  } else {
    // type === PNOISE_IMPACT
    if (who.mynoise2 === null) throw new Error("PlayerNoise: mynoise2 unset after initialization -- unreachable");
    noise = who.mynoise2;
    client.sound2_entity = noise;
    client.sound2_entity_time = level.time;
  }

  VectorCopy(where, noise.s.origin);
  noise.absmin = vec3_sub(where, noise.maxs);
  noise.absmax = vec3_add(where, noise.maxs);
  noise.teleport_time = level.time;
  gi.linkentity(noise);
}

// ---------------------------------------------------------------------------
// SkipViewModifiers
// ---------------------------------------------------------------------------

/** p_view.cpp:23-37: `inline bool SkipViewModifiers()`. */
function SkipViewModifiers(): boolean {
  const client = current_client;
  if (client === null) return false;

  if (cvarBool("g_skipViewModifiers", "0", CvarFlagsT.CVAR_NOSET) && cvarBool("cheats", "0", CvarFlagsT.CVAR_SERVERINFO | CvarFlagsT.CVAR_LATCH)) {
    return true;
  }
  // don't do bobbing, etc on grapple
  if (client.ctf_grapple !== null && client.ctf_grapplestate > CTF_GRAPPLE_STATE_FLY) {
    return true;
  }
  // spectator mode
  if (client.resp.spectator || (G_TeamplayEnabled() && client.resp.ctf_team === CtfteamT.CTF_NOTEAM)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// G_PowerUpExpiring / G_PowerUpExpiringRelative -- ported here (g_local.h
// scope-mismatch precedent: this unit may not edit g_local.ts)
// ---------------------------------------------------------------------------

/** g_local.h:2640-2643: `constexpr bool G_PowerUpExpiringRelative(gtime_t left)`. */
function G_PowerUpExpiringRelative(left: GTime): boolean {
  return Gtime_milliseconds(left) > 3000 || Gtime_milliseconds(left) % 1000 < 500;
}

/** g_local.h:2645-2648: `constexpr bool G_PowerUpExpiring(gtime_t time)`. */
function G_PowerUpExpiring(time: GTime): boolean {
  return G_PowerUpExpiringRelative(Gtime_subtract(time, level.time));
}

// ---------------------------------------------------------------------------
// G_AddBlend -- local copy (see p_move.ts's identical precedent/header note:
// "a future unit that also needs it (p_view.ts) should move it to q_std.ts
// and import from there instead of copying it again." This unit's file list
// is fixed to p_view.ts/p_hud.ts/the test file only per its brief, so it
// cannot edit q_std.ts either -- reported as a follow-up below.)
// ---------------------------------------------------------------------------

/** q_std.h:154-166: `void G_AddBlend(float r, float g, float b, float a, vec4_t &v_blend)`. */
function G_AddBlend(r: number, g: number, b: number, a: number, v_blend: Vec4): void {
  if (a <= 0) return;

  const a2 = v_blend[3] + (1 - v_blend[3]) * a; // new total alpha
  const a3 = v_blend[3] / a2; // fraction of color from old

  v_blend[0] = v_blend[0] * a3 + r * (1 - a3);
  v_blend[1] = v_blend[1] * a3 + g * (1 - a3);
  v_blend[2] = v_blend[2] * a3 + b * (1 - a3);
  v_blend[3] = a2;
}

// ---------------------------------------------------------------------------
// activePlayers -- local copy (see g_ai.ts's identical `activePlayers()`
// precedent: a plain array, not the generator style g_target.ts/g_trigger.ts
// independently chose for the same C `active_players()` -- this port line
// has no lazy entity-iterable abstraction, so each consuming file ports its
// own copy with the same filter/order; see file header for the general
// per-file-duplicate-helper precedent).
// ---------------------------------------------------------------------------

/** g_local.h:3426-3437 `active_players()`. */
function activePlayers(): EdictT[] {
  const out: EdictT[] = [];
  for (let i = 1; i <= game.maxclients; i++) {
    const e = g_edicts[i];
    if (e !== undefined && e.inuse && e.client !== null && e.client.pers.connected) {
      out.push(e);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CTFEffects / CTFSetPowerUpEffect / CTFApplyRegeneration -- ported here,
// not stubs (see file header)
// ---------------------------------------------------------------------------

/** ctf/g_ctf.cpp:868-888: CTF module globals set by PrecacheItem (not
 *  ported); concrete default 0, see file header. */
let modelindex_flag1 = 0;
let modelindex_flag2 = 0;

/** ctf/g_ctf.cpp:868-888: `void CTFEffects(edict_t *player)`. */
function CTFEffects(player: EdictT): void {
  const client = player.client;
  if (client === null) return;

  player.s.effects &= ~(EffectsT.EF_FLAG1 | EffectsT.EF_FLAG2);
  if (player.health > 0) {
    if (client.pers.inventory[ItemIdT.IT_FLAG1]) player.s.effects |= EffectsT.EF_FLAG1;
    if (client.pers.inventory[ItemIdT.IT_FLAG2]) player.s.effects |= EffectsT.EF_FLAG2;
  }

  if (client.pers.inventory[ItemIdT.IT_FLAG1]) player.s.modelindex3 = modelindex_flag1;
  else if (client.pers.inventory[ItemIdT.IT_FLAG2]) player.s.modelindex3 = modelindex_flag2;
  else player.s.modelindex3 = 0;
}

/** ctf/g_ctf.cpp:3854-3862: `void CTFSetPowerUpEffect(edict_t *ent, effects_t def)`. */
function CTFSetPowerUpEffect(ent: EdictT, def: bigint): void {
  const client = ent.client;
  if (client !== null && client.resp.ctf_team === CtfteamT.CTF_TEAM1 && def === EffectsT.EF_QUAD) {
    ent.s.effects |= EffectsT.EF_PENT; // red
  } else if (client !== null && client.resp.ctf_team === CtfteamT.CTF_TEAM2 && def === EffectsT.EF_PENT) {
    ent.s.effects |= EffectsT.EF_QUAD; // blue
  } else {
    ent.s.effects |= def;
  }
}

/** ctf/g_ctf.cpp:2080-2119: `void CTFApplyRegeneration(edict_t *ent)`. */
function CTFApplyRegeneration(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  let noise = false;
  let volume = 1.0;

  if (client.silencer_shots) volume = 0.2;

  if (client.pers.inventory[ItemIdT.IT_TECH_REGENERATION]) {
    if (client.ctf_regentime < level.time) {
      client.ctf_regentime = level.time;
      if (ent.health < 150) {
        ent.health += 5;
        if (ent.health > 150) ent.health = 150;
        client.ctf_regentime = Gtime_add(client.ctf_regentime, Gtime_from_ms(500));
        noise = true;
      }
      const index = ArmorIndex(ent);
      if (index !== ItemIdT.IT_NULL && client.pers.inventory[index] < 150) {
        client.pers.inventory[index] += 5;
        if (client.pers.inventory[index] > 150) client.pers.inventory[index] = 150;
        client.ctf_regentime = Gtime_add(client.ctf_regentime, Gtime_from_ms(500));
        noise = true;
      }
    }
    if (noise && client.ctf_techsndtime < level.time) {
      client.ctf_techsndtime = Gtime_add(level.time, Gtime_from_ms(1000));
      gi.sound(ent, SoundchanT.CHAN_AUX, gi.soundindex("ctf/tech4.wav"), volume, ATTN_NORM, 0);
    }
  }
}

// ---------------------------------------------------------------------------
// SV_CalcRoll
// ---------------------------------------------------------------------------

/** p_view.cpp:45-67: `float SV_CalcRoll(const vec3_t &angles, const vec3_t &velocity)`. */
export function SV_CalcRoll(_angles: Vec3, velocity: Vec3): number {
  if (SkipViewModifiers()) return 0;

  let side = vec3_dot(velocity, right);
  const sign = side < 0 ? -1 : 1;
  side = Math.abs(side);

  const value = cvarFloat("sv_rollangle", "2", CvarFlagsT.CVAR_NOFLAGS);
  const rollspeed = cvarFloat("sv_rollspeed", "200", CvarFlagsT.CVAR_NOFLAGS);

  if (side < rollspeed) side = (side * value) / rollspeed;
  else side = value;

  return side * sign;
}

// ---------------------------------------------------------------------------
// P_DamageFeedback
// ---------------------------------------------------------------------------

/** C `static int i;` inside P_DamageFeedback's pain-frame-cycling switch --
 *  persists across calls exactly like the C static local. */
let painCycleIndex = 0;

/** p_view.cpp:76-279: `void P_DamageFeedback(edict_t *player)`. Handles
 *  color blends and view kicks. */
export function P_DamageFeedback(player: EdictT): void {
  const client = player.client;
  if (client === null) return;

  const armor_color: Vec3 = vec3(1.0, 1.0, 1.0);
  const power_color: Vec3 = vec3(0.0, 1.0, 0.0);
  const bcolor: Vec3 = vec3(1.0, 0.0, 0.0);

  // flash the backgrounds behind the status numbers
  let want_flashes = 0;

  if (client.damage_blood) want_flashes |= 1;
  if (client.damage_armor && (player.flags & EntFlagsT.FL_GODMODE) === 0n && client.invincible_time <= level.time) want_flashes |= 2;

  if (want_flashes) {
    client.flash_time = Gtime_add(level.time, Gtime_from_ms(100));
    client.ps.stats[PlayerStatT.STAT_FLASHES] = want_flashes;
  } else if (client.flash_time < level.time) {
    client.ps.stats[PlayerStatT.STAT_FLASHES] = 0;
  }

  // total points of damage shot at the player this frame
  let count = client.damage_blood + client.damage_armor + client.damage_parmor;
  if (count === 0) return; // didn't take any damage

  // start a pain animation if still in the player model
  if (client.anim_priority < AnimPriorityT.ANIM_PAIN && player.s.modelindex === MODELINDEX_PLAYER) {
    client.anim_priority = AnimPriorityT.ANIM_PAIN;
    if ((client.ps.pmove.pm_flags & PmflagsT.PMF_DUCKED) !== 0) {
      player.s.frame = FRAME_crpain1 - 1;
      client.anim_end = FRAME_crpain4;
    } else {
      painCycleIndex = (painCycleIndex + 1) % 3;
      switch (painCycleIndex) {
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

    client.anim_time = GTIME_ZERO;
  }

  const realcount = count;

  // if we took health damage, do a minimum clamp
  if (client.damage_blood) {
    if (count < 10) count = 10; // always make a visible effect
  } else {
    if (count > 2) count = 2; // don't go too deep
  }

  // play an appropriate pain sound
  if (level.time > player.pain_debounce_time && (player.flags & EntFlagsT.FL_GODMODE) === 0n && client.invincible_time <= level.time) {
    player.pain_debounce_time = Gtime_add(level.time, Gtime_from_ms(700));

    const pain_sounds = ["*pain25_1.wav", "*pain25_2.wav", "*pain50_1.wav", "*pain50_2.wav", "*pain75_1.wav", "*pain75_2.wav", "*pain100_1.wav", "*pain100_2.wav"];

    let l: number;
    if (player.health < 25) l = 0;
    else if (player.health < 50) l = 2;
    else if (player.health < 75) l = 4;
    else l = 6;

    if (brandom()) l |= 1;

    gi.sound(player, SoundchanT.CHAN_VOICE, gi.soundindex(pain_sounds[l]), 1, ATTN_NORM, 0);
    // Paril: pain noises alert monsters
    PlayerNoise(player, player.s.origin, PlayerNoiseT.PNOISE_SELF);
  }

  // the total alpha of the blend is always proportional to count
  if (client.damage_alpha < 0) client.damage_alpha = 0;

  // [Paril-KEX] tweak the values to rely less on this and more on damage indicators
  if (client.damage_blood || client.damage_alpha + count * 0.06 < 0.15) {
    client.damage_alpha += count * 0.06;

    if (client.damage_alpha < 0.06) client.damage_alpha = 0.06;
    if (client.damage_alpha > 0.4) client.damage_alpha = 0.4; // don't go too saturated
  }

  // mix in colors
  let v: Vec3 = vec3();

  if (client.damage_parmor) v = vec3_add(v, vec3_muls(power_color, client.damage_parmor / realcount));
  if (client.damage_blood) v = vec3_add(v, vec3_muls(bcolor, Math.max(15.0, client.damage_blood / realcount)));
  if (client.damage_armor) v = vec3_add(v, vec3_muls(armor_color, client.damage_armor / realcount));
  client.damage_blend = vec3_normalized(v);

  //
  // calculate view angle kicks
  //
  let kick = Math.abs(client.damage_knockback);
  if (kick && player.health > 0) {
    // kick of 0 means no view adjust at all
    kick = (kick * 100) / player.health;

    if (kick < count * 0.5) kick = count * 0.5;
    if (kick > 50) kick = 50;

    v = vec3_normalized(vec3_sub(client.damage_from, player.s.origin));

    let side = vec3_dot(v, right);
    client.v_dmg_roll = kick * side * 0.3;

    side = -vec3_dot(v, forward);
    client.v_dmg_pitch = kick * side * 0.3;

    client.v_dmg_time = Gtime_add(level.time, DAMAGE_TIME(Gtime_from_ms(gi.frame_time_ms)));
  }

  // [Paril-KEX] send view indicators
  if (client.num_damage_indicators) {
    gi.WriteByte(ServerCommandT.svc_damage);
    gi.WriteByte(client.num_damage_indicators);

    for (let i = 0; i < client.num_damage_indicators; i++) {
      const indicator = client.damage_indicators[i];
      if (indicator === undefined) continue;

      // encode total damage into 5 bits
      let encoded = clamp(Math.trunc((indicator.health + indicator.power + indicator.armor) / 3), 1, 0x1f);

      // encode types in the latter 3 bits
      if (indicator.health) encoded |= 0x20;
      if (indicator.armor) encoded |= 0x40;
      if (indicator.power) encoded |= 0x80;

      gi.WriteByte(encoded);
      gi.WriteDir(vec3_normalized(vec3_sub(player.s.origin, indicator.from)));
    }

    gi.unicast(player, false, 0);
  }

  //
  // clear totals
  //
  client.damage_blood = 0;
  client.damage_armor = 0;
  client.damage_parmor = 0;
  client.damage_knockback = 0;
  client.num_damage_indicators = 0;
}

// ---------------------------------------------------------------------------
// SV_CalcViewOffset
// ---------------------------------------------------------------------------

/**
 * p_view.cpp:297-471: `void SV_CalcViewOffset(edict_t *ent)`. Auto pitching
 * on slopes / falling / bob / kicks.
 */
export function SV_CalcViewOffset(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  //===================================
  // base angles

  // C: `vec3_t &angles = ent->client->ps.kick_angles;` -- a genuine
  // reference alias to the field, not a fresh local. `angles` below is
  // NEVER rebound to a different array object (that would silently stop
  // writing through to `ps.kick_angles`, per q_vec3.ts's aliasing-hazard
  // note); every "assign a whole vector" spot uses `VectorCopy(src, angles)`
  // to write the new value INTO the same aliased array instead.
  const angles: Vec3 = client.ps.kick_angles;

  // if dead, fix the angle and don't add any kick
  if (ent.deadflag && !client.resp.spectator) {
    VectorCopy(vec3(), angles);

    if ((ent.flags & EntFlagsT.FL_SAM_RAIMI) !== 0n) {
      client.ps.viewangles[ROLL] = 0;
      client.ps.viewangles[PITCH] = 0;
    } else {
      client.ps.viewangles[ROLL] = 40;
      client.ps.viewangles[PITCH] = -15;
    }
    client.ps.viewangles[YAW] = client.killer_yaw;
  } else if (!client.pers.bob_skip && !SkipViewModifiers()) {
    // add angles based on weapon kick
    VectorCopy(P_CurrentKickAngles(ent), angles);

    // add angles based on damage kick
    if (client.v_dmg_time > level.time) {
      // [Paril-KEX] 100ms of slack is added to account for visual
      // difference in higher tickrates
      const frameTimeMs = Gtime_from_ms(gi.frame_time_ms);
      const diff = Gtime_subtract(client.v_dmg_time, level.time);
      const slack = DAMAGE_TIME_SLACK(frameTimeMs);
      const damageTime = DAMAGE_TIME(frameTimeMs);

      let ratio: number;
      if (Gtime_milliseconds(slack) !== 0) {
        if (diff > Gtime_subtract(damageTime, slack)) {
          ratio = Gtime_seconds(Gtime_subtract(damageTime, diff)) / Gtime_seconds(slack);
        } else {
          ratio = Gtime_seconds(diff) / Gtime_seconds(Gtime_subtract(damageTime, slack));
        }
      } else {
        ratio = Gtime_seconds(diff) / Gtime_seconds(Gtime_subtract(damageTime, slack));
      }

      angles[PITCH] += ratio * client.v_dmg_pitch;
      angles[ROLL] += ratio * client.v_dmg_roll;
    }

    // add pitch based on fall kick
    if (client.fall_time > level.time) {
      const frameTimeMs = Gtime_from_ms(gi.frame_time_ms);
      const diff = Gtime_subtract(client.fall_time, level.time);
      const slack = DAMAGE_TIME_SLACK(frameTimeMs);
      const fallTime = FALL_TIME(frameTimeMs);

      let ratio: number;
      if (Gtime_milliseconds(slack) !== 0) {
        if (diff > Gtime_subtract(fallTime, slack)) {
          ratio = Gtime_seconds(Gtime_subtract(fallTime, diff)) / Gtime_seconds(slack);
        } else {
          ratio = Gtime_seconds(diff) / Gtime_seconds(Gtime_subtract(fallTime, slack));
        }
      } else {
        ratio = Gtime_seconds(diff) / Gtime_seconds(Gtime_subtract(fallTime, slack));
      }
      angles[PITCH] += ratio * client.fall_value;
    }

    // add angles based on velocity
    if (!client.pers.bob_skip && !SkipViewModifiers()) {
      let delta = vec3_dot(ent.velocity, forward);
      angles[PITCH] += delta * cvarFloat("run_pitch", "0.002", CvarFlagsT.CVAR_NOFLAGS);

      delta = vec3_dot(ent.velocity, right);
      angles[ROLL] += delta * cvarFloat("run_roll", "0.005", CvarFlagsT.CVAR_NOFLAGS);

      // add angles based on bob
      delta = bobfracsin * cvarFloat("bob_pitch", "0.002", CvarFlagsT.CVAR_NOFLAGS) * xyspeed;
      if ((client.ps.pmove.pm_flags & PmflagsT.PMF_DUCKED) !== 0 && ent.groundentity !== null) delta *= 6; // crouching
      delta = Math.min(delta, 1.2);
      angles[PITCH] += delta;
      delta = bobfracsin * cvarFloat("bob_roll", "0.002", CvarFlagsT.CVAR_NOFLAGS) * xyspeed;
      if ((client.ps.pmove.pm_flags & PmflagsT.PMF_DUCKED) !== 0 && ent.groundentity !== null) delta *= 6; // crouching
      delta = Math.min(delta, 1.2);
      if ((bobcycle & 1) !== 0) delta = -delta;
      angles[ROLL] += delta;
    }

    // add earthquake angles
    if (client.quake_time > level.time) {
      const factor = Math.min(1.0, (Gtime_seconds(client.quake_time) / Gtime_seconds(level.time)) * 0.25);

      angles[0] += crandom_open() * factor;
      angles[2] += crandom_open() * factor;
      angles[1] += crandom_open() * factor;
    }
  }

  // [Paril-KEX] clamp angles
  for (let i = 0; i < 3; i++) {
    angles[i] = clamp(angles[i], -31, 31);
  }

  //===================================
  // base origin

  let v: Vec3 = vec3();

  // add fall height
  if (!client.pers.bob_skip && !SkipViewModifiers()) {
    if (client.fall_time > level.time) {
      const frameTimeMs = Gtime_from_ms(gi.frame_time_ms);
      const diff = Gtime_subtract(client.fall_time, level.time);
      const slack = DAMAGE_TIME_SLACK(frameTimeMs);
      const fallTime = FALL_TIME(frameTimeMs);

      let ratio: number;
      if (Gtime_milliseconds(slack) !== 0) {
        if (diff > Gtime_subtract(fallTime, slack)) {
          ratio = Gtime_seconds(Gtime_subtract(fallTime, diff)) / Gtime_seconds(slack);
        } else {
          ratio = Gtime_seconds(diff) / Gtime_seconds(Gtime_subtract(fallTime, slack));
        }
      } else {
        ratio = Gtime_seconds(diff) / Gtime_seconds(Gtime_subtract(fallTime, slack));
      }
      v[2] -= ratio * client.fall_value * 0.4;
    }

    // add bob height
    let bob = bobfracsin * xyspeed * cvarFloat("bob_up", "0.005", CvarFlagsT.CVAR_NOFLAGS);
    if (bob > 6) bob = 6;
    v[2] += bob;
  }

  // add kick offset
  if (!client.pers.bob_skip && !SkipViewModifiers()) v = vec3_add(v, P_CurrentKickOrigin(ent));

  // absolutely bound offsets so the view can never be outside the player box
  if (v[0] < -14) v[0] = -14;
  else if (v[0] > 14) v[0] = 14;
  if (v[1] < -14) v[1] = -14;
  else if (v[1] > 14) v[1] = 14;
  if (v[2] < -22) v[2] = -22;
  else if (v[2] > 30) v[2] = 30;

  client.ps.viewoffset = v;
}

// ---------------------------------------------------------------------------
// SV_CalcGunOffset
// ---------------------------------------------------------------------------

/** p_view.cpp:478-557: `void SV_CalcGunOffset(edict_t *ent)`. */
export function SV_CalcGunOffset(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  // ROGUE - heatbeam shouldn't bob so the beam looks right
  if (
    client.pers.weapon !== null &&
    !((client.pers.weapon.id === ItemIdT.IT_WEAPON_PLASMABEAM || client.pers.weapon.id === ItemIdT.IT_WEAPON_GRAPPLE) && client.weaponstate === WeaponstateT.WEAPON_FIRING) &&
    !SkipViewModifiers()
  ) {
    // gun angles from bobbing
    client.ps.gunangles[ROLL] = xyspeed * bobfracsin * 0.005;
    client.ps.gunangles[YAW] = xyspeed * bobfracsin * 0.01;
    if ((bobcycle & 1) !== 0) {
      client.ps.gunangles[ROLL] = -client.ps.gunangles[ROLL];
      client.ps.gunangles[YAW] = -client.ps.gunangles[YAW];
    }

    client.ps.gunangles[PITCH] = xyspeed * bobfracsin * 0.005;

    const viewangles_delta = vec3_sub(client.oldviewangles, client.ps.viewangles);

    for (let i = 0; i < 3; i++) {
      client.slow_view_angles[i] += viewangles_delta[i];
    }

    // gun angles from delta movement
    for (let i = 0; i < 3; i++) {
      let d = client.slow_view_angles[i];

      if (!d) continue;

      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      if (d > 45) d = 45;
      if (d < -45) d = -45;

      // [Sam-KEX] Apply only half-delta. Makes the weapons look less detatched from the player.
      if (i === ROLL) client.ps.gunangles[i] += 0.1 * d * 0.5;
      else client.ps.gunangles[i] += 0.2 * d * 0.5;

      const reduction_factor = viewangles_delta[i] ? 0.05 : 0.15;

      if (d > 0) d = Math.max(0, d - gi.frame_time_ms * reduction_factor);
      else if (d < 0) d = Math.min(0, d + gi.frame_time_ms * reduction_factor);

      client.slow_view_angles[i] = d;
    }

    // [Paril-KEX] cl_rollhack
    client.ps.gunangles[ROLL] = -client.ps.gunangles[ROLL];
  } else {
    for (let i = 0; i < 3; i++) client.ps.gunangles[i] = 0;
  }

  // gun height
  client.ps.gunoffset = vec3();

  // gun_x / gun_y / gun_z are development tools
  const gun_x = cvarFloat("gun_x", "0", CvarFlagsT.CVAR_NOFLAGS);
  const gun_y = cvarFloat("gun_y", "0", CvarFlagsT.CVAR_NOFLAGS);
  const gun_z = cvarFloat("gun_z", "0", CvarFlagsT.CVAR_NOFLAGS);

  for (let i = 0; i < 3; i++) {
    client.ps.gunoffset[i] += forward[i] * gun_y;
    client.ps.gunoffset[i] += right[i] * gun_x;
    client.ps.gunoffset[i] += up[i] * -gun_z;
  }
}

// ---------------------------------------------------------------------------
// SV_CalcBlend
// ---------------------------------------------------------------------------

/** p_view.cpp:564-682: `void SV_CalcBlend(edict_t *ent)`. */
export function SV_CalcBlend(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  client.ps.damage_blend = vec3_4_zero();
  client.ps.screen_blend = vec3_4_zero();

  // add for powerups
  if (client.quad_time > level.time) {
    const remaining = Gtime_subtract(client.quad_time, level.time);
    if (Gtime_milliseconds(remaining) === 3000) gi.sound(ent, SoundchanT.CHAN_ITEM, gi.soundindex("items/damage2.wav"), 1, ATTN_NORM, 0);
    if (G_PowerUpExpiringRelative(remaining)) G_AddBlend(0, 0, 1, 0.08, client.ps.screen_blend);
  }
  // RAFAEL
  else if (client.quadfire_time > level.time) {
    const remaining = Gtime_subtract(client.quadfire_time, level.time);
    if (Gtime_milliseconds(remaining) === 3000) gi.sound(ent, SoundchanT.CHAN_ITEM, gi.soundindex("items/quadfire2.wav"), 1, ATTN_NORM, 0);
    if (G_PowerUpExpiringRelative(remaining)) G_AddBlend(1, 0.2, 0.5, 0.08, client.ps.screen_blend);
  }
  // RAFAEL
  // PMM - double damage
  else if (client.double_time > level.time) {
    const remaining = Gtime_subtract(client.double_time, level.time);
    if (Gtime_milliseconds(remaining) === 3000) gi.sound(ent, SoundchanT.CHAN_ITEM, gi.soundindex("misc/ddamage2.wav"), 1, ATTN_NORM, 0);
    if (G_PowerUpExpiringRelative(remaining)) G_AddBlend(0.9, 0.7, 0, 0.08, client.ps.screen_blend);
  }
  // PMM
  else if (client.invincible_time > level.time) {
    const remaining = Gtime_subtract(client.invincible_time, level.time);
    if (Gtime_milliseconds(remaining) === 3000) gi.sound(ent, SoundchanT.CHAN_ITEM, gi.soundindex("items/protect2.wav"), 1, ATTN_NORM, 0);
    if (G_PowerUpExpiringRelative(remaining)) G_AddBlend(1, 1, 0, 0.08, client.ps.screen_blend);
  } else if (client.invisible_time > level.time) {
    const remaining = Gtime_subtract(client.invisible_time, level.time);
    if (Gtime_milliseconds(remaining) === 3000) gi.sound(ent, SoundchanT.CHAN_ITEM, gi.soundindex("items/protect2.wav"), 1, ATTN_NORM, 0);
    if (G_PowerUpExpiringRelative(remaining)) G_AddBlend(0.8, 0.8, 0.8, 0.08, client.ps.screen_blend);
  } else if (client.enviro_time > level.time) {
    const remaining = Gtime_subtract(client.enviro_time, level.time);
    if (Gtime_milliseconds(remaining) === 3000) gi.sound(ent, SoundchanT.CHAN_ITEM, gi.soundindex("items/airout.wav"), 1, ATTN_NORM, 0);
    if (G_PowerUpExpiringRelative(remaining)) G_AddBlend(0, 1, 0, 0.08, client.ps.screen_blend);
  } else if (client.breather_time > level.time) {
    const remaining = Gtime_subtract(client.breather_time, level.time);
    if (Gtime_milliseconds(remaining) === 3000) gi.sound(ent, SoundchanT.CHAN_ITEM, gi.soundindex("items/airout.wav"), 1, ATTN_NORM, 0);
    if (G_PowerUpExpiringRelative(remaining)) G_AddBlend(0.4, 1, 0.4, 0.04, client.ps.screen_blend);
  }

  // PGM
  if (client.nuke_time > level.time) {
    const brightness = Gtime_seconds(Gtime_subtract(client.nuke_time, level.time)) / 2.0;
    G_AddBlend(1, 1, 1, brightness, client.ps.screen_blend);
  }
  if (client.ir_time > level.time) {
    const remaining = Gtime_subtract(client.ir_time, level.time);
    if (G_PowerUpExpiringRelative(remaining)) {
      client.ps.rdflags |= RefdefFlagsT.RDF_IRGOGGLES;
      G_AddBlend(1, 0, 0, 0.2, client.ps.screen_blend);
    } else {
      client.ps.rdflags &= ~RefdefFlagsT.RDF_IRGOGGLES;
    }
  } else {
    client.ps.rdflags &= ~RefdefFlagsT.RDF_IRGOGGLES;
  }
  // PGM

  // add for damage
  if (client.damage_alpha > 0) G_AddBlend(client.damage_blend[0], client.damage_blend[1], client.damage_blend[2], client.damage_alpha, client.ps.damage_blend);

  // [Paril-KEX] drowning visual indicator
  if (ent.air_finished < Gtime_add(level.time, Gtime_from_ms(9000))) {
    const drown_color: Vec3 = vec3(0.1, 0.1, 0.2);
    const max_drown_alpha = 0.75;
    const alpha = ent.air_finished < level.time ? 1 : 1.0 - Gtime_seconds(Gtime_subtract(ent.air_finished, level.time)) / 9.0;
    G_AddBlend(drown_color[0], drown_color[1], drown_color[2], Math.min(alpha, max_drown_alpha), client.ps.damage_blend);
  }

  // #if 0 -- bonus_alpha blend is dead code in the C source too (dropped)

  // drop the damage value
  client.damage_alpha -= gi.frame_time_s * 0.6;
  if (client.damage_alpha < 0) client.damage_alpha = 0;

  // drop the bonus value
  client.bonus_alpha -= gi.frame_time_s;
  if (client.bonus_alpha < 0) client.bonus_alpha = 0;
}

/** fresh zero Vec4, for `ps.screen_blend`/`ps.damage_blend = {}` (C's
 *  aggregate-init-to-zero). Never share one instance across assignments --
 *  see q_vec3.ts's aliasing-hazard note. */
function vec3_4_zero(): Vec4 {
  return new Float32Array(4);
}

// ---------------------------------------------------------------------------
// P_WorldEffects
// ---------------------------------------------------------------------------

/** p_view.cpp:689-854: `void P_WorldEffects()`. Reads/writes the
 *  module-scope `current_player`/`current_client` (see file header). */
export function P_WorldEffects(): void {
  const player = current_player;
  const client = current_client;
  if (player === null || client === null) return;

  if (player.movetype === MovetypeT.MOVETYPE_NOCLIP) {
    player.air_finished = Gtime_add(level.time, Gtime_from_ms(12000)); // don't need air
    return;
  }

  const waterlevel = player.waterlevel;
  const old_waterlevel = client.old_waterlevel;
  client.old_waterlevel = waterlevel;

  const breather = client.breather_time > level.time;
  const envirosuit = client.enviro_time > level.time;

  // if just entered a water volume, play a sound
  if (!old_waterlevel && waterlevel) {
    PlayerNoise(player, player.s.origin, PlayerNoiseT.PNOISE_SELF);
    if ((player.watertype & ContentsT.CONTENTS_LAVA) !== 0) gi.sound(player, SoundchanT.CHAN_BODY, gi.soundindex("player/lava_in.wav"), 1, ATTN_NORM, 0);
    else if ((player.watertype & ContentsT.CONTENTS_SLIME) !== 0) gi.sound(player, SoundchanT.CHAN_BODY, gi.soundindex("player/watr_in.wav"), 1, ATTN_NORM, 0);
    else if ((player.watertype & ContentsT.CONTENTS_WATER) !== 0) gi.sound(player, SoundchanT.CHAN_BODY, gi.soundindex("player/watr_in.wav"), 1, ATTN_NORM, 0);
    player.flags |= EntFlagsT.FL_INWATER;

    // clear damage_debounce, so the pain sound will play immediately
    player.damage_debounce_time = Gtime_subtract(level.time, Gtime_from_ms(1000));
  }

  // if just completely exited a water volume, play a sound
  if (old_waterlevel && !waterlevel) {
    PlayerNoise(player, player.s.origin, PlayerNoiseT.PNOISE_SELF);
    gi.sound(player, SoundchanT.CHAN_BODY, gi.soundindex("player/watr_out.wav"), 1, ATTN_NORM, 0);
    player.flags &= ~EntFlagsT.FL_INWATER;
  }

  // check for head just going under water
  if (old_waterlevel !== WaterLevelT.WATER_UNDER && waterlevel === WaterLevelT.WATER_UNDER) {
    gi.sound(player, SoundchanT.CHAN_BODY, gi.soundindex("player/watr_un.wav"), 1, ATTN_NORM, 0);
  }

  // check for head just coming out of water
  if (player.health > 0 && old_waterlevel === WaterLevelT.WATER_UNDER && waterlevel !== WaterLevelT.WATER_UNDER) {
    if (player.air_finished < level.time) {
      gi.sound(player, SoundchanT.CHAN_VOICE, gi.soundindex("player/gasp1.wav"), 1, ATTN_NORM, 0);
      PlayerNoise(player, player.s.origin, PlayerNoiseT.PNOISE_SELF);
    } else if (player.air_finished < Gtime_add(level.time, Gtime_from_ms(11000))) {
      gi.sound(player, SoundchanT.CHAN_VOICE, gi.soundindex("player/gasp2.wav"), 1, ATTN_NORM, 0);
    }
  }

  // check for drowning
  if (waterlevel === WaterLevelT.WATER_UNDER) {
    if (breather || envirosuit) {
      player.air_finished = Gtime_add(level.time, Gtime_from_ms(10000));

      if (Gtime_milliseconds(Gtime_subtract(client.breather_time, level.time)) % 2500 === 0) {
        if (!client.breather_sound) gi.sound(player, SoundchanT.CHAN_AUTO, gi.soundindex("player/u_breath1.wav"), 1, ATTN_NORM, 0);
        else gi.sound(player, SoundchanT.CHAN_AUTO, gi.soundindex("player/u_breath2.wav"), 1, ATTN_NORM, 0);
        client.breather_sound ^= 1;
        PlayerNoise(player, player.s.origin, PlayerNoiseT.PNOISE_SELF);
        // FIXME: release a bubble?
      }
    }

    // if out of air, start drowning
    if (player.air_finished < level.time) {
      if (client.next_drown_time < level.time && player.health > 0) {
        client.next_drown_time = Gtime_add(level.time, Gtime_from_ms(1000));

        // take more damage the longer underwater
        player.dmg += 2;
        if (player.dmg > 15) player.dmg = 15;

        if (player.health <= player.dmg) gi.sound(player, SoundchanT.CHAN_VOICE, gi.soundindex("*drown1.wav"), 1, ATTN_NORM, 0);
        else if (brandom()) gi.sound(player, SoundchanT.CHAN_VOICE, gi.soundindex("*gurp1.wav"), 1, ATTN_NORM, 0);
        else gi.sound(player, SoundchanT.CHAN_VOICE, gi.soundindex("*gurp2.wav"), 1, ATTN_NORM, 0);

        player.pain_debounce_time = level.time;

        T_Damage(player, g_edicts[0], g_edicts[0], vec3_origin_local(), player.s.origin, vec3_origin_local(), player.dmg, 0, DamageflagsT.DAMAGE_NO_ARMOR, { id: ModIdT.MOD_WATER, friendly_fire: false, no_point_loss: false });
      }
    } else if (player.air_finished <= Gtime_add(level.time, Gtime_from_ms(3000))) {
      // Paril: almost-drowning sounds
      if (client.next_drown_time < level.time) {
        const n = 1 + (Math.trunc(Gtime_seconds(level.time)) % 3);
        gi.sound(player, SoundchanT.CHAN_VOICE, gi.soundindex(`player/wade${n}.wav`), 1, ATTN_NORM, 0);
        client.next_drown_time = Gtime_add(level.time, Gtime_from_ms(1000));
      }
    }
  } else {
    player.air_finished = Gtime_add(level.time, Gtime_from_ms(12000));
    player.dmg = 2;
  }

  // check for sizzle damage
  if (waterlevel && (player.watertype & (ContentsT.CONTENTS_LAVA | ContentsT.CONTENTS_SLIME)) !== 0 && player.slime_debounce_time <= level.time) {
    if ((player.watertype & ContentsT.CONTENTS_LAVA) !== 0) {
      if (player.health > 0 && player.pain_debounce_time <= level.time && client.invincible_time < level.time) {
        if (brandom()) gi.sound(player, SoundchanT.CHAN_VOICE, gi.soundindex("player/burn1.wav"), 1, ATTN_NORM, 0);
        else gi.sound(player, SoundchanT.CHAN_VOICE, gi.soundindex("player/burn2.wav"), 1, ATTN_NORM, 0);
        player.pain_debounce_time = Gtime_add(level.time, Gtime_from_ms(1000));
      }

      const dmg = (envirosuit ? 1 : 3) * waterlevel; // take 1/3 damage with envirosuit

      T_Damage(player, g_edicts[0], g_edicts[0], vec3_origin_local(), player.s.origin, vec3_origin_local(), dmg, 0, DamageflagsT.DAMAGE_NONE, {
        id: ModIdT.MOD_LAVA,
        friendly_fire: false,
        no_point_loss: false,
      });
      player.slime_debounce_time = Gtime_add(level.time, Gtime_from_ms(100));
    }

    if ((player.watertype & ContentsT.CONTENTS_SLIME) !== 0) {
      if (!envirosuit) {
        T_Damage(player, g_edicts[0], g_edicts[0], vec3_origin_local(), player.s.origin, vec3_origin_local(), 1 * waterlevel, 0, DamageflagsT.DAMAGE_NONE, {
          id: ModIdT.MOD_SLIME,
          friendly_fire: false,
          no_point_loss: false,
        });
        player.slime_debounce_time = Gtime_add(level.time, Gtime_from_ms(100));
      }
    }
  }
}

/** q_vec3.h `vec3_origin` -- see file header; a fresh zero vector each call
 *  (T_Damage's `dir`/`normal` params are read-only here but this avoids any
 *  aliasing risk with the module's own shared `vec3_origin`-style constant). */
function vec3_origin_local(): Vec3 {
  return vec3();
}

// ---------------------------------------------------------------------------
// G_SetClientEffects
// ---------------------------------------------------------------------------

/** ctf/g_ctf.h:16-20 `enum ctfteam_grapple_state_t` -- see file header
 *  (CTF_GRAPPLE_STATE_FLY declared earlier). */
const CTF_GRAPPLE_STATE_PULL = 1;
const CTF_GRAPPLE_STATE_HANG = 2;

/** p_view.cpp:861-989: `void G_SetClientEffects(edict_t *ent)`. */
export function G_SetClientEffects(ent: EdictT): void {
  ent.s.effects = EffectsT.EF_NONE;
  ent.s.renderfx &= RenderfxT.RF_STAIR_STEP;
  ent.s.renderfx |= RenderfxT.RF_IR_VISIBLE;
  ent.s.alpha = 1.0;

  if (ent.health <= 0 || Gtime_nonzero(level.intermissiontime)) return;

  if ((ent.flags & EntFlagsT.FL_FLASHLIGHT) !== 0n) ent.s.effects |= EffectsT.EF_FLASHLIGHT;

  //=========
  // PGM
  if ((ent.flags & EntFlagsT.FL_DISGUISED) !== 0n) ent.s.renderfx |= RenderfxT.RF_USE_DISGUISE;

  if (cvarBool("gamerules", "0", CvarFlagsT.CVAR_LATCH)) {
    // DMGame.PlayerEffects -- always null in this port line; see g_combat.ts's
    // identical "concrete faithful value, not a stub" precedent for DMGame.
    // No-op.
  }
  // PGM
  //=========

  if (ent.powerarmor_time > level.time) {
    const pa_type = PowerArmorType(ent);
    if (pa_type === ItemIdT.IT_ITEM_POWER_SCREEN) {
      ent.s.effects |= EffectsT.EF_POWERSCREEN;
    } else if (pa_type === ItemIdT.IT_ITEM_POWER_SHIELD) {
      ent.s.effects |= EffectsT.EF_COLOR_SHELL;
      ent.s.renderfx |= RenderfxT.RF_SHELL_GREEN;
    }
  }

  // ZOID
  CTFEffects(ent);
  // ZOID

  const client = ent.client;
  if (client === null) return;

  if (client.quad_time > level.time) {
    if (G_PowerUpExpiring(client.quad_time)) CTFSetPowerUpEffect(ent, EffectsT.EF_QUAD);
  }

  // RAFAEL
  if (client.quadfire_time > level.time) {
    if (G_PowerUpExpiring(client.quadfire_time)) CTFSetPowerUpEffect(ent, EffectsT.EF_DUALFIRE);
  }
  // RAFAEL
  //=======
  // ROGUE
  if (client.double_time > level.time) {
    if (G_PowerUpExpiring(client.double_time)) CTFSetPowerUpEffect(ent, EffectsT.EF_DOUBLE);
  }
  if (client.owned_sphere !== null && client.owned_sphere.spawnflags === SPHERE_DEFENDER) {
    CTFSetPowerUpEffect(ent, EffectsT.EF_HALF_DAMAGE);
  }
  if (client.tracker_pain_time > level.time) {
    ent.s.effects |= EffectsT.EF_TRACKERTRAIL;
  }
  if (client.invisible_time > level.time) {
    if (client.invisibility_fade_time <= level.time) ent.s.alpha = 0.1;
    else {
      const x = Gtime_seconds(Gtime_subtract(client.invisibility_fade_time, level.time)) / Gtime_seconds(INVISIBILITY_TIME);
      ent.s.alpha = clamp(x, 0.1, 1.0);
    }
  }
  // ROGUE
  //=======

  if (client.invincible_time > level.time) {
    if (G_PowerUpExpiring(client.invincible_time)) CTFSetPowerUpEffect(ent, EffectsT.EF_PENT);
  }

  // show cheaters!!!
  if ((ent.flags & EntFlagsT.FL_GODMODE) !== 0n) {
    ent.s.effects |= EffectsT.EF_COLOR_SHELL;
    ent.s.renderfx |= RenderfxT.RF_SHELL_RED | RenderfxT.RF_SHELL_GREEN | RenderfxT.RF_SHELL_BLUE;
  }

  // disintegrator stuff -- `#if 0` in the C source, dropped per PORTING.md.
}

// ---------------------------------------------------------------------------
// G_SetClientEvent
// ---------------------------------------------------------------------------

/** p_view.cpp:996-1017: `void G_SetClientEvent(edict_t *ent)`. Reads the
 *  module-scope `current_client` (C reads it too, via the file-scope
 *  static). */
export function G_SetClientEvent(ent: EdictT): void {
  if (ent.s.event !== KexEntityEventT.EV_NONE) return;

  const client = current_client;
  if (client === null) return;

  if ((client.ps.pmove.pm_flags & PmflagsT.PMF_ON_LADDER) !== 0) {
    if (
      !cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH) &&
      client.last_ladder_sound < level.time &&
      vec3_length(vec3_sub(client.last_ladder_pos, ent.s.origin)) > 48
    ) {
      ent.s.event = KexEntityEventT.EV_LADDER_STEP;
      VectorCopy(ent.s.origin, client.last_ladder_pos);
      client.last_ladder_sound = Gtime_add(level.time, LADDER_SOUND_TIME);
    }
  } else if (ent.groundentity !== null && xyspeed > 225) {
    if (Math.trunc(client.bobtime + bobmove) !== bobcycle_run) ent.s.event = KexEntityEventT.EV_FOOTSTEP;
  }
}

// ---------------------------------------------------------------------------
// G_SetClientSound
// ---------------------------------------------------------------------------

/** g_items.cpp precache global, never assigned in this port line (no
 *  precache routine has landed yet) -- concrete default 0, matching
 *  modelindex_flag1/2's treatment above. */
let snd_fry = 0;

/** p_view.cpp:1024-1076: `void G_SetClientSound(edict_t *ent)`. */
export function G_SetClientSound(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  // help beep (no more than three times)
  if (client.pers.helpchanged && client.pers.helpchanged <= 3 && client.pers.help_time < level.time) {
    if (client.pers.helpchanged === 1) gi.sound(ent, SoundchanT.CHAN_AUTO, gi.soundindex("misc/pc_up.wav"), 1, ATTN_STATIC, 0);
    client.pers.helpchanged++;
    client.pers.help_time = Gtime_add(level.time, Gtime_from_ms(5000));
  }

  // reset defaults
  ent.s.sound = 0;
  ent.s.loop_attenuation = 0;
  ent.s.loop_volume = 0;

  if (ent.waterlevel && (ent.watertype & (ContentsT.CONTENTS_LAVA | ContentsT.CONTENTS_SLIME)) !== 0) {
    ent.s.sound = snd_fry;
    return;
  }

  if (ent.deadflag || client.resp.spectator) return;

  if (client.weapon_sound) ent.s.sound = client.weapon_sound;
  else if (client.pers.weapon !== null) {
    if (client.pers.weapon.id === ItemIdT.IT_WEAPON_RAILGUN) ent.s.sound = gi.soundindex("weapons/rg_hum.wav");
    else if (client.pers.weapon.id === ItemIdT.IT_WEAPON_BFG) ent.s.sound = gi.soundindex("weapons/bfg_hum.wav");
    // RAFAEL
    else if (client.pers.weapon.id === ItemIdT.IT_WEAPON_PHALANX) ent.s.sound = gi.soundindex("weapons/phaloop.wav");
    // RAFAEL
  }

  // [Paril-KEX] if no other sound is playing, play appropriate grapple sounds
  if (!ent.s.sound && client.ctf_grapple !== null) {
    if (client.ctf_grapplestate === CTF_GRAPPLE_STATE_PULL) ent.s.sound = gi.soundindex("weapons/grapple/grpull.wav");
    else if (client.ctf_grapplestate === CTF_GRAPPLE_STATE_FLY) ent.s.sound = gi.soundindex("weapons/grapple/grfly.wav");
    else if (client.ctf_grapplestate === CTF_GRAPPLE_STATE_HANG) ent.s.sound = gi.soundindex("weapons/grapple/grhang.wav");
  }

  // weapon sounds play at a higher attn
  ent.s.loop_attenuation = ATTN_NORM;
}

// ---------------------------------------------------------------------------
// G_SetClientFrame
// ---------------------------------------------------------------------------

/** p_view.cpp:1083-1224: `void G_SetClientFrame(edict_t *ent)`. The C
 *  `goto newanim;` jumps are ported as a `!skipToNewAnim` guard around the
 *  early-return block that the gotos would otherwise skip -- see this
 *  file's git history / PORTING.md's "goto -> restructure with early
 *  return, labeled break, or a small state flag; keep the original control
 *  flow order" for the idiom. */
export function G_SetClientFrame(ent: EdictT): void {
  if (ent.s.modelindex !== MODELINDEX_PLAYER) return; // not in the player model

  const client = ent.client;
  if (client === null) return;

  const duck = (client.ps.pmove.pm_flags & PmflagsT.PMF_DUCKED) !== 0;
  const run = xyspeed !== 0;

  // check for stand/duck and stop/go transitions
  const skipToNewAnim =
    (duck !== client.anim_duck && client.anim_priority < AnimPriorityT.ANIM_DEATH) ||
    (run !== client.anim_run && client.anim_priority === AnimPriorityT.ANIM_BASIC) ||
    (ent.groundentity === null && client.anim_priority <= AnimPriorityT.ANIM_WAVE);

  if (!skipToNewAnim) {
    if (client.anim_time > level.time) return;
    else if ((client.anim_priority & AnimPriorityT.ANIM_REVERSED) !== 0 && ent.s.frame > client.anim_end) {
      if (client.anim_time <= level.time) {
        ent.s.frame--;
        client.anim_time = Gtime_add(level.time, Gtime_from_hz(10));
      }
      return;
    } else if ((client.anim_priority & AnimPriorityT.ANIM_REVERSED) === 0 && ent.s.frame < client.anim_end) {
      // continue an animation
      if (client.anim_time <= level.time) {
        ent.s.frame++;
        client.anim_time = Gtime_add(level.time, Gtime_from_hz(10));
      }
      return;
    }

    if (client.anim_priority === AnimPriorityT.ANIM_DEATH) return; // stay there
    if (client.anim_priority === AnimPriorityT.ANIM_JUMP) {
      if (ent.groundentity === null) return; // stay there
      client.anim_priority = AnimPriorityT.ANIM_WAVE;

      if (duck) {
        ent.s.frame = FRAME_jump6;
        client.anim_end = FRAME_jump4;
        client.anim_priority |= AnimPriorityT.ANIM_REVERSED;
      } else {
        ent.s.frame = FRAME_jump3;
        client.anim_end = FRAME_jump6;
      }
      client.anim_time = Gtime_add(level.time, Gtime_from_hz(10));
      return;
    }
  }

  // newanim:
  // return to either a running or standing frame
  client.anim_priority = AnimPriorityT.ANIM_BASIC;
  client.anim_duck = duck;
  client.anim_run = run;
  client.anim_time = Gtime_add(level.time, Gtime_from_hz(10));

  if (ent.groundentity === null) {
    // ZOID: if on grapple, don't go into jump frame, go into standing frame
    if (client.ctf_grapple !== null) {
      if (duck) {
        ent.s.frame = FRAME_crstnd01;
        client.anim_end = FRAME_crstnd19;
      } else {
        ent.s.frame = FRAME_stand01;
        client.anim_end = FRAME_stand40;
      }
    } else {
      // ZOID
      client.anim_priority = AnimPriorityT.ANIM_JUMP;

      if (duck) {
        if (ent.s.frame !== FRAME_crwalk2) ent.s.frame = FRAME_crwalk1;
        client.anim_end = FRAME_crwalk2;
      } else {
        if (ent.s.frame !== FRAME_jump2) ent.s.frame = FRAME_jump1;
        client.anim_end = FRAME_jump2;
      }
    }
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

// ---------------------------------------------------------------------------
// P_RunMegaHealth
// ---------------------------------------------------------------------------

/** p_view.cpp:1227-1248: `[Paril-KEX] static void P_RunMegaHealth(edict_t *ent)`. */
function P_RunMegaHealth(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if (!Gtime_nonzero(client.pers.megahealth_time)) return;
  else if (ent.health <= ent.max_health) {
    client.pers.megahealth_time = GTIME_ZERO;
    return;
  }

  client.pers.megahealth_time = Gtime_subtract(client.pers.megahealth_time, Gtime_from_ms(gi.frame_time_ms));

  if (client.pers.megahealth_time <= GTIME_ZERO) {
    ent.health--;

    if (ent.health > ent.max_health) client.pers.megahealth_time = Gtime_from_ms(1000);
    else client.pers.megahealth_time = GTIME_ZERO;
  }
}

// ---------------------------------------------------------------------------
// G_LagCompensate / G_UnLagCompensate / G_SaveLagCompensation -- ported
// here, not stubs (see file header)
// ---------------------------------------------------------------------------

/** p_view.cpp:1251-1310: `[Paril-KEX] void G_LagCompensate(edict_t *from_player, const vec3_t &start, const vec3_t &dir)`. */
export function G_LagCompensate(from_player: EdictT, start: Vec3, dir: Vec3): void {
  const current_frame = gi.ServerFrame();

  // if you need this to fight monsters, you need help
  if (!cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) return;
  else if (!cvarBool("g_lag_compensation", "1", CvarFlagsT.CVAR_NOFLAGS)) return;

  const fromClient = from_player.client;
  if (fromClient === null) return; // defensive; C assumes client always valid here
  // don't need this
  else if (fromClient.cmd.server_frame >= current_frame || (from_player.svflags & SvflagsT.SVF_BOT) !== 0) return;

  const frame_delta = current_frame - fromClient.cmd.server_frame + 1;

  for (const player of activePlayers()) {
    // we aren't gonna hit ourselves
    if (player === from_player) continue;

    const client = player.client;
    if (client === null) continue;

    // not enough data, spare them
    if (client.num_lag_origins < frame_delta) continue;

    // if they're way outside of cone of vision, they won't be captured in this
    if (vec3_dot(vec3_normalized(vec3_sub(player.s.origin, start)), dir) < 0.75) continue;

    let lag_id = client.next_lag_origin - 1 - (frame_delta - 1);

    if (lag_id < 0) lag_id = game.max_lag_origins + lag_id;

    if (lag_id < 0 || lag_id >= client.num_lag_origins) {
      gi.Com_Print("lag compensation error\n");
      G_UnLagCompensate();
      return;
    }

    const lagOrigins = game.lag_origins;
    if (lagOrigins === null) continue; // defensive: never allocated in this port line

    const lag_origin = lagOrigins[(player.s.number - 1) * game.max_lag_origins + lag_id];
    if (lag_origin === undefined) continue;

    // no way they'd be hit if they aren't in the PVS
    if (!gi.inPVS(lag_origin, start, false)) continue;

    // only back up once
    if (!client.is_lag_compensated) {
      client.is_lag_compensated = true;
      VectorCopy(player.s.origin, client.lag_restore_origin);
    }

    VectorCopy(lag_origin, player.s.origin);

    gi.linkentity(player);
  }
}

/** p_view.cpp:1313-1324: `[Paril-KEX] void G_UnLagCompensate()`. */
export function G_UnLagCompensate(): void {
  for (const player of activePlayers()) {
    const client = player.client;
    if (client !== null && client.is_lag_compensated) {
      client.is_lag_compensated = false;
      VectorCopy(client.lag_restore_origin, player.s.origin);
      gi.linkentity(player);
    }
  }
}

/** p_view.cpp:1327-1334: `[Paril-KEX] static void G_SaveLagCompensation(edict_t *ent)`. */
function G_SaveLagCompensation(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const lagOrigins = game.lag_origins;
  if (lagOrigins === null) return; // defensive: never allocated in this port line

  lagOrigins[(ent.s.number - 1) * game.max_lag_origins + client.next_lag_origin] = ent.s.origin;
  client.next_lag_origin = (client.next_lag_origin + 1) % game.max_lag_origins;

  if (client.num_lag_origins < game.max_lag_origins) client.num_lag_origins++;
}

// ---------------------------------------------------------------------------
// P_ForceFogTransition -- real guard, narrow stub tail (see file header)
// ---------------------------------------------------------------------------

function fogArrayEquals(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function heightFogEquals(a: { start: readonly number[]; end: readonly number[]; falloff: number; density: number }, b: typeof a): boolean {
  return a.falloff === b.falloff && a.density === b.density && fogArrayEquals(a.start, b.start) && fogArrayEquals(a.end, b.end);
}

/** p_client.cpp:1788-1910+: `[Paril-KEX] void P_ForceFogTransition(edict_t *ent, bool instant)`.
 *  See file header: the early-return guard is real; the svc_fog write is a
 *  narrow, cited stub. */
export function P_ForceFogTransition(ent: EdictT, instant: boolean): void {
  const client = ent.client;
  if (client === null) return;

  // sanity check; if we're not changing the values, don't bother
  if (fogArrayEquals(client.fog, client.pers.wanted_fog) && heightFogEquals(client.heightfog, client.pers.wanted_heightfog)) return;

  sendFogTransition(ent, instant);
}

// ---------------------------------------------------------------------------
// P_AssignClientSkinnum -- real guard, narrow stub tail (see file header)
// ---------------------------------------------------------------------------

/** p_client.cpp:1741-1766: `void P_AssignClientSkinnum(edict_t *ent)`. */
export function P_AssignClientSkinnum(ent: EdictT): void {
  if (ent.s.modelindex !== 255) return;
  packClientSkinnum(ent);
}

// ---------------------------------------------------------------------------
// Compass_Update -- real guard, narrow stub tail (see file header)
// ---------------------------------------------------------------------------

function compassUpdateBody(_ent: EdictT, _first: boolean): void {
  throw new Error(
    "Compass_Update body: not yet ported -- level.poi_points is a single Vec3 slot per player, not the multi-point vec3_t* path buffer the real body walks (pending g_items.ts, see g_items.cpp:1498-1541)",
  );
}

/** g_items.cpp:1498-1541: `void Compass_Update(edict_t *ent, bool first)`. */
export function Compass_Update(ent: EdictT, first: boolean): void {
  const client = ent.client;
  if (client === null) return;

  const points = level.poi_points[ent.s.number - 1];

  // deleted for some reason
  if (points === null || points === undefined) return;

  compassUpdateBody(ent, first);
}

// ---------------------------------------------------------------------------
// ClientEndServerFrame
// ---------------------------------------------------------------------------

/**
 * p_view.cpp:1344-1557: `void ClientEndServerFrame(edict_t *ent)`. Called
 * for each player at the end of the server frame and right after spawning.
 */
export function ClientEndServerFrame(ent: EdictT): void {
  // no player exists yet (load game)
  if (ent.client === null || !ent.client.pers.spawned) return;

  current_player = ent;
  current_client = ent.client;
  const client = ent.client;

  // check fog changes
  P_ForceFogTransition(ent, false);

  // check goals
  G_PlayerNotifyGoal(ent);

  // mega health
  P_RunMegaHealth(ent);

  //
  // If the origin or velocity have changed since ClientThink(), update the
  // pmove values. This will happen when the client is pushed by a bmodel or
  // kicked by an explosion.
  //
  // If it wasn't updated here, the view position would lag a frame behind
  // the body position when pushed -- "sinking into plats"
  //
  VectorCopy(ent.s.origin, client.ps.pmove.origin);
  VectorCopy(ent.velocity, client.ps.pmove.velocity);

  //
  // If the end of unit layout is displayed, don't give the player any
  // normal movement attributes
  //
  if (Gtime_nonzero(level.intermissiontime) || client.awaiting_respawn) {
    if (client.awaiting_respawn || level.intermission_eou || level.is_n64 || (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH) && Gtime_nonzero(level.intermissiontime))) {
      client.ps.screen_blend[3] = 0;
      client.ps.damage_blend[3] = 0;
      client.ps.fov = 90;
      client.ps.gunindex = 0;
    }
    G_SetStats(ent);
    G_SetCoopStats(ent);

    // if the scoreboard is up, update it if a client leaves
    if (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH) && client.showscores && Gtime_nonzero(client.menutime)) {
      DeathmatchScoreboardMessage(ent, ent.enemy);
      gi.unicast(ent, false, 0);
      client.menutime = GTIME_ZERO;
    }

    return;
  }

  // ZOID
  // regen tech
  CTFApplyRegeneration(ent);
  // ZOID

  AngleVectors(client.v_angle, forward, right, up);

  // burn from lava, etc
  P_WorldEffects();

  //
  // set model angles from view angles so other things in the world can
  // tell which direction you are looking
  //
  if (client.v_angle[PITCH] > 180) ent.s.angles[PITCH] = (-360 + client.v_angle[PITCH]) / 3;
  else ent.s.angles[PITCH] = client.v_angle[PITCH] / 3;

  ent.s.angles[YAW] = client.v_angle[YAW];
  ent.s.angles[ROLL] = 0;
  // [Paril-KEX] cl_rollhack
  ent.s.angles[ROLL] = -SV_CalcRoll(ent.s.angles, ent.velocity) * 4;

  //
  // calculate speed and cycle to be used for all cyclic walking effects
  //
  xyspeed = Math.sqrt(ent.velocity[0] * ent.velocity[0] + ent.velocity[1] * ent.velocity[1]);

  if (xyspeed < 5) {
    bobmove = 0;
    client.bobtime = 0; // start at beginning of cycle again
  } else if (ent.groundentity !== null) {
    // so bobbing only cycles when on ground
    if (xyspeed > 210) bobmove = gi.frame_time_ms / 400;
    else if (xyspeed > 100) bobmove = gi.frame_time_ms / 800;
    else bobmove = gi.frame_time_ms / 1600;
  }

  client.bobtime += bobmove;
  let bobtime = client.bobtime;
  const bobtime_run = bobtime;

  if ((client.ps.pmove.pm_flags & PmflagsT.PMF_DUCKED) !== 0 && ent.groundentity !== null) bobtime *= 4;

  bobcycle = Math.trunc(bobtime);
  bobcycle_run = Math.trunc(bobtime_run);
  bobfracsin = Math.abs(Math.sin(bobtime * Math.PI));

  // apply all the damage taken this frame
  P_DamageFeedback(ent);

  // determine the view offsets
  SV_CalcViewOffset(ent);

  // determine the gun offsets
  SV_CalcGunOffset(ent);

  // determine the full screen color blend
  // must be after viewoffset, so eye contents can be accurately determined
  SV_CalcBlend(ent);

  // chase cam stuff
  if (client.resp.spectator) G_SetSpectatorStats(ent);
  else G_SetStats(ent);

  G_CheckChaseStats(ent);

  G_SetCoopStats(ent);

  G_SetClientEvent(ent);

  G_SetClientEffects(ent);

  G_SetClientSound(ent);

  G_SetClientFrame(ent);

  VectorCopy(ent.velocity, client.oldvelocity);
  VectorCopy(client.ps.viewangles, client.oldviewangles);
  client.oldgroundentity = ent.groundentity;

  // ZOID
  if (client.menudirty && client.menutime <= level.time) {
    if (client.menu !== null) {
      PMenu_Do_Update(ent);
      gi.unicast(ent, true, 0);
    }
    client.menutime = level.time;
    client.menudirty = false;
  }
  // ZOID

  // if the scoreboard is up, update it
  if (client.showscores && client.menutime <= level.time) {
    // ZOID
    if (client.menu !== null) {
      PMenu_Do_Update(ent);
      client.menudirty = false;
    } else {
      // ZOID
      DeathmatchScoreboardMessage(ent, ent.enemy);
    }
    gi.unicast(ent, false, 0);
    client.menutime = Gtime_add(level.time, Gtime_from_ms(3000));
  }

  if ((ent.svflags & SvflagsT.SVF_BOT) !== 0) {
    Bot_EndFrame(ent);
  }

  P_AssignClientSkinnum(ent);

  if (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) G_SaveLagCompensation(ent);

  Compass_Update(ent, false);

  // [Paril-KEX] in coop, if player collision is enabled and we are
  // currently in no-player-collision mode, check if it's safe.
  if (cvarBool("coop", "0", CvarFlagsT.CVAR_LATCH) && G_ShouldPlayersCollide(false) && (ent.clipmask & ContentsT.CONTENTS_PLAYER) === 0 && ent.takedamage) {
    let clipped_player = false;

    for (const player of activePlayers()) {
      if (player === ent) continue;

      const clip = gi.clip(player, ent.s.origin, ent.mins, ent.maxs, ent.s.origin, ContentsT.CONTENTS_MONSTER | ContentsT.CONTENTS_PLAYER);

      if (clip.startsolid || clip.allsolid) {
        clipped_player = true;
        break;
      }
    }

    // safe!
    if (!clipped_player) ent.clipmask |= ContentsT.CONTENTS_PLAYER;
  }
}
