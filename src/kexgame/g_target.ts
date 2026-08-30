// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_target.c -- target entities for the game module (2023 Quake II
// re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/g_target.cpp (2,076 lines,
// C++17): target_temp_entity, target_speaker, target_help (+
// G_PlayerNotifyGoal), target_secret, target_goal, target_explosion,
// target_changelevel, target_splash, target_spawner, target_blaster,
// target_crosslevel_trigger/target, target_laser (+ the piercing think
// chain), target_lightramp, target_earthquake, target_camera (+ the N64
// dummy-player intermission-path chain), target_gravity, target_soundfx,
// target_light, target_poi, target_music, target_healthbar,
// target_autosave, target_sky, target_crossunit_trigger/target,
// target_achievement, target_story. Behavioral code, ported bug-for-bug per
// PORTING.md. Every SP_* is exported under its exact C name for the future
// spawn registry; every THINK/USE function is registered through
// g_save_registry.ts under its exact C name (g_target.cpp declares no
// TOUCH() functions at all -- verified by grepping the whole file).
//
// No overlap with g_monster.ts's trigger_health_relay (that lives in
// g_monster.cpp, not this file) or with g_trigger.ts (disjoint entity
// prefixes; g_trigger.ts's own header already resolved the one apparent
// overlap candidate, trigger_health_relay).
//
// ============================================================================
// `st` (spawn_temp_t) placeholder -- same situation/idiom as g_trigger.ts
// ============================================================================
// See g_trigger.ts's own header for the full rationale (no g_spawn.ts yet in
// this port line, so `extern spawn_temp_t st;` has no shared home). This
// file's own local `st` mirrors that one exactly (same real `SpawnTempT`
// type, permanently defaulted, no setter) -- every `st.X` read below is
// honestly always "unset" until a future g_spawn.ts unit lands.
//
// ============================================================================
// EXTERNAL DEPENDENCIES NOT YET PORTED (throwing stubs, cited) -- CORRECTED
// ============================================================================
// This section previously listed BeginIntermission, MoveClientToIntermission,
// G_SetClientFrame, G_EndOfUnitMessage, respawn, and P_UseCoopInstancedItems
// as a single "not yet ported" group. That was stale: earlier units already
// swapped BeginIntermission/MoveClientToIntermission/G_EndOfUnitMessage (real
// imports from src/kexgame/p_hud.ts, line ~171) and G_SetClientFrame (real
// import from src/kexgame/p_view.ts, line ~172) to real implementations
// without updating this comment. The p_client.ts unit that swapped
// respawn/P_UseCoopInstancedItems to real imports below is the one that
// finally corrected this. As of now, the only genuinely unported cross-dep
// left in this file is:
// - ED_CallSpawn            -> g_spawn.cpp (future g_spawn.ts; no
//   src/kexgame/g_spawn.ts exists yet in THIS port line -- the legacy/
//   vanilla `src/game/g_spawn.ts` is a different port line and does not
//   satisfy this). Reached only by target_spawner's use handler.
//
// ============================================================================
// STUB SWAP: fire_blaster / pierce_trace / GetUnicastKey -- now real imports
// from src/kexgame/g_weapon.ts, THEIR ACTUAL C++ HOME
// ============================================================================
// Before src/kexgame/g_weapon.ts existed, this file carried its OWN local
// copies of four symbols that are genuinely defined in g_weapon.cpp, not
// here: `fire_blaster` (a throwing stub, cited "pending g_weapon.ts"),
// and REAL local ports of `pierce_trace`/`pierce_args_t::mark`/
// `pierce_args_t::restore` (g_weapon.cpp:88-108 / g_local.h:3562-3587) and
// `GetUnicastKey` (g_weapon.cpp:820-828) -- the latter three couldn't be
// stubs because `target_laser_think` reaches `pierce_trace`/`mark`/
// `restore` on every single think tick a laser is on, and
// `G_PlayerNotifyGoal`'s N64-goals branch unconditionally reaches
// `GetUnicastKey`.
//
// g_weapon.ts has now landed with real exports of all four (it is their
// actual C++ home). Per this port line's "one implementation should own a
// symbol, not two independently-maintained copies" principle, this file's
// own four local definitions are DELETED and replaced with `import {
// fire_blaster, GetUnicastKey, markPierce, restorePierce, pierceTrace }
// from "./g_weapon"`. Verified behaviorally identical before deleting: the
// moved bodies were diffed character-for-character against this file's
// pre-move versions, and this file's own `target_laser_think` test (its
// debounce-window case, which exercises `pierceTrace`/`markPierce`/
// `restorePierce` every tick) and `G_PlayerNotifyGoal`'s N64 test (which
// exercises `GetUnicastKey`) both still pass unchanged against the import.
// This file's own `giTraceline`/`traceEdict`/`modFromId`/`cvarInt` local
// helpers are UNCHANGED -- those are the ordinary "duplicate the tiny
// header-only wrapper per file" idiom this port line uses everywhere (see
// g_weapon.ts's own identical copies), never a second copy of real
// cross-file LOGIC the way the four symbols above were.
//
// ============================================================================
// STUB SWAP: respawn / P_UseCoopInstancedItems -- now real imports from
// src/kexgame/p_client.ts, THEIR ACTUAL C++ HOME
// ============================================================================
// This file carried local, unexported throwing stubs for these two symbols
// (cited "pending p_client.ts"), reached only once target_camera is actually
// used, which requires a real player-driven intermission flow this port line
// doesn't have yet -- neither stub ever actually threw in this file's own
// test suite. Now that src/kexgame/p_client.ts has landed with real,
// exported `respawn`/`P_UseCoopInstancedItems` (their genuine C++ home), the
// local stubs are DELETED and replaced with real imports. This closes a
// real, sanctioned import cycle with p_client.ts (which imports
// G_PlayerNotifyGoal from THIS file, for ClientBegin's own
// "[Paril-KEX] send them goal, if needed" call) -- same shape and safety
// argument as g_utils.ts's/g_weapon.ts's/p_hud.ts's identical precedent
// comments: both cycle-facing exports (`respawn`/`P_UseCoopInstancedItems`
// here, `G_PlayerNotifyGoal` on p_client.ts's side) are hoisted top-level
// declarations used only inside function bodies, never at module-eval time.
//
// ============================================================================
// CONFIG_HEALTH_BAR_NAME / CONFIG_STORY -- computed locally, not guessed
// ============================================================================
// Declared in bg_local.h's own "reserved general CS ranges" anonymous enum
// (lines 56-73), not ported anywhere yet (grepped bg_local.ts -- it doesn't
// exist; grepped kexapi/game.ts -- zero matches). Rather than hardcoding an
// absolute configstring index (which would silently break if any of the
// already-ported CS_* constants it's offset from ever changed), both are
// computed here with the SAME offset arithmetic the C++ enum performs,
// anchored on the already-ported `CS_GENERAL`/`MAX_CLIENTS` constants:
// CONFIG_CTF_MATCH=CS_GENERAL+0, TEAMINFO=+1, PLAYER_NAME=+2,
// PLAYER_NAME_END=+2+MAX_CLIENTS(256)=+258, COOP_RESPAWN_STRING=+259,
// COOP_RESPAWN_STRING_END=+259+(COOP_RESPAWN_TOTAL-1=5)=+264,
// N64_PHYSICS=+265, HEALTH_BAR_NAME=+266, STORY=+267.
//
// ============================================================================
// xyspeed -- placement-mismatch global, ported as file-scoped state
// ============================================================================
// `extern float xyspeed;` (defined in p_view.cpp, not ported as an exported
// value there -- p_view.ts's own copy is an unexported module-scope `let`)
// is read by `target_camera_dummy_think` immediately before its own call
// into the now-real, imported `G_SetClientFrame` (see the corrected
// "EXTERNAL DEPENDENCIES NOT YET PORTED" section above -- G_SetClientFrame
// itself has been a real import from p_view.ts since an earlier unit; this
// note used to call it "(stubbed)", which was stale). Since p_view.ts's own
// `xyspeed` isn't exported, this file still can't import it, so it stays a
// local, unexported, module-scope mutable variable here -- same "placement
// mismatch, report don't move" precedent g_monster.ts's own `st` note and
// this file's `st` placeholder both already establish.

import { vec3, type Vec3 } from "../shared/math";
import {
  ATTN_LOOP_NONE,
  ATTN_NONE,
  ATTN_NORM,
  ATTN_STATIC,
  ButtonT,
  ContentsT,
  CS_CDTRACK,
  CS_GENERAL,
  CS_LIGHTS,
  CS_SKY,
  CS_SKYAXIS,
  CS_SKYROTATE,
  CvarFlagsT,
  EffectsT,
  type KexEdictT,
  KexEntityEventT,
  KexMulticastT,
  KexTempEventT,
  type KexTraceT,
  MASK_SHOT,
  MAX_CLIENTS,
  MODELINDEX_PLAYER,
  MODELINDEX_WORLD,
  type PathInfo,
  PathFlags,
  PathLinkType,
  type PathRequest,
  PathReturnCode,
  PrintTypeT,
  RenderfxT,
  RF_BEAM_LIGHTNING,
  ServerCommandT,
  ShadowLightTypeT,
  SolidT,
  SoundchanT,
  SvflagsT,
} from "../kexapi/game";
import {
  DAMAGE_TIME,
  DamageflagsT,
  type EdictT,
  EntFlagsT,
  MAX_HEALTH_BARS,
  MAX_PIERCE,
  type ModT,
  ModIdT,
  MonsterAiFlagsT,
  MovetypeT,
  type PierceArgsT,
  type PierceHitFn,
  SFL_CROSS_TRIGGER_MASK,
  type SpawnTempT,
  type ThinkFn,
  type UseFn,
} from "./g_local";
import { RegisterThink, RegisterUse } from "./g_save_registry";
import { gi, g_edicts, game, globals, level } from "./g_main_globals";
import { T_Damage, T_RadiusDamage } from "./g_combat";
import { G_FindByString, G_FreeEdict, G_PickTarget, G_SetMovedir, G_Spawn, G_UseTargets, KillBox } from "./g_utils";
import { fire_blaster, GetUnicastKey, markPierce, restorePierce, pierceTrace } from "./g_weapon";
import { BeginIntermission, MoveClientToIntermission, G_EndOfUnitMessage } from "./p_hud";
import { G_SetClientFrame } from "./p_view";
import { respawn, P_UseCoopInstancedItems } from "./p_client";
import { GTIME_ZERO, Gtime_add, Gtime_from_ms, Gtime_from_sec, Gtime_nonzero, Gtime_seconds, Gtime_subtract } from "./gtime";
import { SpawnFlags_from, SpawnFlags_has, type SpawnFlags } from "./spawnflags";
import { RotatePointAroundVector, vec3_add, vec3_equals, vec3_length, vec3_lengthSquared, vec3_muls, vec3_normalized, vec3_origin, vec3_sub } from "./q_vec3";
import { brandom } from "./q_std";

// ---------------------------------------------------------------------------
// `st` placeholder (see file header)
// ---------------------------------------------------------------------------

const st: SpawnTempT = {
  sky: null,
  skyrotate: 0,
  skyaxis: vec3(0, 0, 0),
  skyautorotate: 1,
  nextmap: null,
  lip: 0,
  distance: 0,
  height: 0,
  noise: null,
  pausetime: 0,
  item: null,
  gravity: null,
  minyaw: 0,
  maxyaw: 0,
  minpitch: 0,
  maxpitch: 0,
  sl: { data: { lighttype: ShadowLightTypeT.point, radius: 0, resolution: 0, intensity: 1, fade_start: 0, fade_end: 0, lightstyle: -1, coneangle: 45, conedirection: vec3(0, 0, 0) }, lightstyletarget: null },
  music: null,
  instantitems: 0,
  radius: 0,
  hub_map: false,
  achievement: null,
  goals: null,
  image: null,
  fade_start_dist: 96,
  fade_end_dist: 384,
  start_items: null,
  no_grapple: 0,
  health_multiplier: 1.0,
  reinforcements: null,
  noise_start: null,
  noise_middle: null,
  noise_end: null,
  loop_count: 0,
  keys_specified: new Set<string>(),
};

/** EDICT_NUM idiom -- see g_phys.ts's/g_monster.ts's own `traceEdict`. */
function traceEdict(ent: KexEdictT | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

function modFromId(id: ModIdT): ModT {
  return { id, friendly_fire: false, no_point_loss: false };
}

/** deathmatch->integer / coop->integer, per g_utils.ts's own CvarT.value note. */
function cvarInt(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): number {
  const c = gi.cvar(name, def, flags);
  return c === null ? Math.trunc(Number(def)) : Math.trunc(c.value);
}
function cvarFloat(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): number {
  const c = gi.cvar(name, def, flags);
  return c === null ? Number(def) : c.value;
}
function deathmatchEnabled(): boolean {
  return cvarInt("deathmatch", "0") !== 0;
}
function coopEnabled(): boolean {
  return cvarInt("coop", "0", CvarFlagsT.CVAR_LATCH) !== 0;
}
function dmAllowExit(): boolean {
  return cvarInt("g_dm_allow_exit", "0") !== 0;
}

/** `active_players()` (g_local.h:3426-3437): inuse, connected players. */
function* active_players(): Generator<EdictT> {
  for (let i = 1; i <= game.maxclients; i++) {
    const ent = g_edicts[i];
    if (ent === undefined || !ent.inuse || ent.client === null || !ent.client.pers.connected) continue;
    yield ent;
  }
}

/** bg_local.h:56-73 offset chain -- see file header. */
const CONFIG_CTF_PLAYER_NAME = CS_GENERAL + 2;
const CONFIG_CTF_PLAYER_NAME_END = CONFIG_CTF_PLAYER_NAME + MAX_CLIENTS;
const COOP_RESPAWN_TOTAL = 6;
const CONFIG_COOP_RESPAWN_STRING = CONFIG_CTF_PLAYER_NAME_END + 1;
const CONFIG_COOP_RESPAWN_STRING_END = CONFIG_COOP_RESPAWN_STRING + (COOP_RESPAWN_TOTAL - 1);
const CONFIG_N64_PHYSICS = CONFIG_COOP_RESPAWN_STRING_END + 1;
const CONFIG_HEALTH_BAR_NAME_INDEX = CONFIG_N64_PHYSICS + 1;
const CONFIG_STORY_INDEX = CONFIG_HEALTH_BAR_NAME_INDEX + 1;

// ---------------------------------------------------------------------------
// unported cross-deps (throwing stubs) -- see file header
// ---------------------------------------------------------------------------

// fire_blaster: formerly a local throwing stub here -- src/kexgame/
// g_weapon.ts has landed with a real export; see this file's own header,
// "STUB SWAP: fire_blaster / pierce_trace / GetUnicastKey".

function ED_CallSpawn(_ent: EdictT): void {
  throw new Error("ED_CallSpawn: not yet ported (pending g_spawn.ts, see g_spawn.cpp)");
}

// respawn / P_UseCoopInstancedItems: formerly local throwing stubs here --
// src/kexgame/p_client.ts has landed with real exports; see this file's own
// header, "STUB SWAP: respawn / P_UseCoopInstancedItems".

/** `extern float xyspeed;` (p_view.cpp) -- see file header. */
let xyspeed = 0;

// ---------------------------------------------------------------------------
// target_temp_entity
// ---------------------------------------------------------------------------

/** g_target.cpp:9-15: `USE(Use_Target_Tent)`. */
export const Use_Target_Tent: UseFn = RegisterUse("Use_Target_Tent", (ent: EdictT): void => {
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(ent.style);
  gi.WritePosition(ent.s.origin);
  gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PVS, false);
});

/** g_target.cpp:17-23: `void SP_target_temp_entity(edict_t *ent)`. */
export function SP_target_temp_entity(ent: EdictT): void {
  if (level.is_n64 && ent.style === 27) ent.style = KexTempEventT.TE_TELEPORT_EFFECT;
  ent.use = Use_Target_Tent;
}

// ---------------------------------------------------------------------------
// target_speaker
// ---------------------------------------------------------------------------

const SPAWNFLAG_SPEAKER_LOOPED_ON: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAG_SPEAKER_LOOPED_OFF: SpawnFlags = SpawnFlags_from(2);
const SPAWNFLAG_SPEAKER_RELIABLE: SpawnFlags = SpawnFlags_from(4);
const SPAWNFLAG_SPEAKER_NO_STEREO: SpawnFlags = SpawnFlags_from(8);

/** g_target.cpp:48-69: `USE(Use_Target_Speaker)`. */
export const Use_Target_Speaker: UseFn = RegisterUse("Use_Target_Speaker", (ent: EdictT): void => {
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_SPEAKER_LOOPED_ON) || SpawnFlags_has(ent.spawnflags, SPAWNFLAG_SPEAKER_LOOPED_OFF)) {
    // looping sound toggles
    ent.s.sound = ent.s.sound !== 0 ? 0 : ent.noise_index;
  } else {
    // normal sound
    const chan = SpawnFlags_has(ent.spawnflags, SPAWNFLAG_SPEAKER_RELIABLE) ? SoundchanT.CHAN_VOICE | SoundchanT.CHAN_RELIABLE : SoundchanT.CHAN_VOICE;
    // use a positioned_sound, because this entity won't normally be sent to
    // any clients because it is invisible
    gi.positioned_sound(ent.s.origin, ent, chan, ent.noise_index, ent.volume, ent.attenuation, 0);
  }
});

/** g_target.cpp:71-119: `void SP_target_speaker(edict_t *ent)`. */
export function SP_target_speaker(ent: EdictT): void {
  if (st.noise === null) {
    gi.Com_Print(`${ent.classname ?? "?"}: no noise set\n`);
    return;
  }

  ent.noise_index = st.noise.includes(".wav") ? gi.soundindex(st.noise) : gi.soundindex(`${st.noise}.wav`);

  if (ent.volume === 0) {
    ent.volume = 1.0;
    ent.s.loop_volume = 1.0;
  }

  if (ent.attenuation === 0) {
    ent.attenuation = SpawnFlags_has(ent.spawnflags, SPAWNFLAG_SPEAKER_LOOPED_OFF) || SpawnFlags_has(ent.spawnflags, SPAWNFLAG_SPEAKER_LOOPED_ON) ? ATTN_STATIC : ATTN_NORM;
  } else if (ent.attenuation === -1) {
    // use -1 so 0 defaults to 1
    if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_SPEAKER_LOOPED_OFF) || SpawnFlags_has(ent.spawnflags, SPAWNFLAG_SPEAKER_LOOPED_ON)) {
      ent.attenuation = ATTN_LOOP_NONE;
      ent.svflags |= SvflagsT.SVF_NOCULL;
    } else {
      ent.attenuation = ATTN_NONE;
    }
  }

  ent.s.loop_attenuation = ent.attenuation;

  // check for prestarted looping sound
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_SPEAKER_LOOPED_ON)) ent.s.sound = ent.noise_index;

  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_SPEAKER_NO_STEREO)) ent.s.renderfx |= RenderfxT.RF_NO_STEREO;

  ent.use = Use_Target_Speaker;

  // must link the entity so we get areas and clusters so the server can
  // determine who to send updates to
  gi.linkentity(ent);
}

// ---------------------------------------------------------------------------
// target_help (+ target_poi_use forward reference, defined further below)
// ---------------------------------------------------------------------------

const SPAWNFLAG_HELP_HELP1: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAG_SET_POI: SpawnFlags = SpawnFlags_from(2);

/** g_target.cpp:127-150: `USE(Use_Target_Help)`. */
export const Use_Target_Help: UseFn = RegisterUse("Use_Target_Help", (ent: EdictT, other: EdictT | null, activator: EdictT | null): void => {
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_HELP_HELP1)) {
    if (game.helpmessage1 !== (ent.message ?? "")) {
      game.helpmessage1 = ent.message ?? "";
      game.help1changed++;
    }
  } else {
    if (game.helpmessage2 !== (ent.message ?? "")) {
      game.helpmessage2 = ent.message ?? "";
      game.help2changed++;
    }
  }

  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_SET_POI)) {
    target_poi_use(ent, other, activator);
  }
});

/** g_target.cpp:152-179: `void SP_target_help(edict_t *ent)`. */
export function SP_target_help(ent: EdictT): void {
  if (deathmatchEnabled()) {
    G_FreeEdict(ent);
    return;
  }

  if (ent.message === null) {
    gi.Com_Print(`${ent.classname ?? "?"}: no message\n`);
    G_FreeEdict(ent);
    return;
  }

  ent.use = Use_Target_Help;

  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_SET_POI)) {
    ent.noise_index = st.image !== null ? gi.imageindex(st.image) : gi.imageindex("friend");
  }
}

// ---------------------------------------------------------------------------
// target_secret
// ---------------------------------------------------------------------------

/** g_target.cpp:187-195: `USE(use_target_secret)`. */
export const use_target_secret: UseFn = RegisterUse("use_target_secret", (ent: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
  gi.sound(ent, SoundchanT.CHAN_VOICE, ent.noise_index, 1, ATTN_NORM, 0);

  level.found_secrets++;

  G_UseTargets(ent, activator);
  G_FreeEdict(ent);
});

/** g_target.cpp:197-203: `THINK(G_VerifyTargetted)`. */
export const G_VerifyTargetted: ThinkFn = RegisterThink("G_VerifyTargetted", (ent: EdictT): void => {
  if (ent.targetname === null || ent.targetname === "") {
    gi.Com_Print(`WARNING: missing targetname on ${ent.classname ?? "?"}\n`);
  } else if (G_FindByString(null, "target", ent.targetname) === null) {
    gi.Com_Print(`WARNING: doesn't appear to be anything targeting ${ent.classname ?? "?"}\n`);
  }
});

/** g_target.cpp:205-222: `void SP_target_secret(edict_t *ent)`. */
export function SP_target_secret(ent: EdictT): void {
  if (deathmatchEnabled()) {
    G_FreeEdict(ent);
    return;
  }

  ent.think = G_VerifyTargetted;
  ent.nextthink = Gtime_add(level.time, Gtime_from_ms(10));

  ent.use = use_target_secret;
  const noise = st.noise ?? "misc/secret.wav";
  ent.noise_index = gi.soundindex(noise);
  ent.svflags = SvflagsT.SVF_NOCLIENT;
  level.total_secrets++;
}

// ---------------------------------------------------------------------------
// G_PlayerNotifyGoal / target_goal
// ---------------------------------------------------------------------------

/** g_target.cpp:226-301: `void G_PlayerNotifyGoal(edict_t *player)`. */
export function G_PlayerNotifyGoal(player: EdictT): void {
  // no goals in DM
  if (deathmatchEnabled()) return;
  if (player.client === null) return;

  if (!player.client.pers.spawned) return;
  else if (Gtime_subtract(level.time, player.client.resp.entertime) < Gtime_from_ms(300)) return;

  // N64 goals
  if (level.goals !== null) {
    // if the goal has updated, commit it first
    if (game.help1changed !== game.help2changed) {
      // skip ahead by the number of goals we've finished, then take the
      // segment up to the next tab as the new helpmessage1
      const segments = level.goals.split("\t");

      if (level.goal_num >= segments.length) gi.Com_Error("invalid n64 goals; tell Paril\n");

      game.helpmessage1 = segments[level.goal_num] ?? "";
      game.help2changed = game.help1changed;
    }

    if (player.client.pers.game_help1changed !== game.help1changed) {
      gi.Loc_Print(player, PrintTypeT.PRINT_TYPEWRITER, game.helpmessage1, [], 0);
      gi.local_sound(player, null, player, SoundchanT.CHAN_AUTO | SoundchanT.CHAN_RELIABLE, gi.soundindex("misc/talk.wav"), 1.0, ATTN_NONE, 0, GetUnicastKey());

      player.client.pers.game_help1changed = game.help1changed;
    }

    // no regular goals
    return;
  }

  if (player.client.pers.game_help1changed !== game.help1changed) {
    player.client.pers.game_help1changed = game.help1changed;
    player.client.pers.helpchanged = 1;
    player.client.pers.help_time = Gtime_add(level.time, Gtime_from_sec(5));

    if (game.helpmessage1 !== "") {
      // [Sam-KEX] Print objective to screen
      gi.Loc_Print(player, PrintTypeT.PRINT_TYPEWRITER, "$g_primary_mission_objective", [game.helpmessage1], 1);
    }
  }

  if (player.client.pers.game_help2changed !== game.help2changed) {
    player.client.pers.game_help2changed = game.help2changed;
    player.client.pers.helpchanged = 1;
    player.client.pers.help_time = Gtime_add(level.time, Gtime_from_sec(5));

    if (game.helpmessage2 !== "") {
      gi.Loc_Print(player, PrintTypeT.PRINT_TYPEWRITER, "$g_secondary_mission_objective", [game.helpmessage2], 1);
    }
  }
}

const SPAWNFLAG_GOAL_KEEP_MUSIC: SpawnFlags = SpawnFlags_from(1);

/** g_target.cpp:309-335: `USE(use_target_goal)`. */
export const use_target_goal: UseFn = RegisterUse("use_target_goal", (ent: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
  gi.sound(ent, SoundchanT.CHAN_VOICE, ent.noise_index, 1, ATTN_NORM, 0);

  level.found_goals++;

  if (level.found_goals === level.total_goals && !SpawnFlags_has(ent.spawnflags, SPAWNFLAG_GOAL_KEEP_MUSIC)) {
    gi.configstring(CS_CDTRACK, ent.sounds !== 0 ? `${ent.sounds}` : "0");
  }

  // [Paril-KEX] n64 goals
  if (level.goals !== null) {
    level.goal_num++;
    game.help1changed++;

    for (const player of active_players()) G_PlayerNotifyGoal(player);
  }

  G_UseTargets(ent, activator);
  G_FreeEdict(ent);
});

/** g_target.cpp:337-351: `void SP_target_goal(edict_t *ent)`. */
export function SP_target_goal(ent: EdictT): void {
  if (deathmatchEnabled()) {
    G_FreeEdict(ent);
    return;
  }

  ent.use = use_target_goal;
  const noise = st.noise ?? "misc/secret.wav";
  ent.noise_index = gi.soundindex(noise);
  ent.svflags = SvflagsT.SVF_NOCLIENT;
  level.total_goals++;
}

// ---------------------------------------------------------------------------
// target_explosion
// ---------------------------------------------------------------------------

/**
 * Every USE handler below sets `self.activator` unconditionally as its first
 * statement before any later THINK could run; this throws if that invariant
 * is ever violated instead of silently narrowing a null (matches the
 * M_ProcessPain precedent in g_monster.ts's own header).
 */
function requireActivator(self: EdictT, context: string): EdictT {
  if (self.activator === null) throw new Error(`${context}: self.activator is null (invariant violated -- always set by the USE handler immediately before this can run)`);
  return self.activator;
}

/** g_target.cpp:361-376: `THINK(target_explosion_explode)`. */
export const target_explosion_explode: ThinkFn = RegisterThink("target_explosion_explode", (self: EdictT): void => {
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_EXPLOSION1);
  gi.WritePosition(self.s.origin);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PHS, false);

  T_RadiusDamage(self, requireActivator(self, "target_explosion_explode"), self.dmg, null, self.dmg + 40, DamageflagsT.DAMAGE_NONE, modFromId(ModIdT.MOD_EXPLOSIVE));

  const save = self.delay;
  self.delay = 0;
  G_UseTargets(self, self.activator);
  self.delay = save;
});

/** g_target.cpp:378-390: `USE(use_target_explosion)`. */
export const use_target_explosion: UseFn = RegisterUse("use_target_explosion", (self: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
  self.activator = activator;

  if (self.delay === 0) {
    target_explosion_explode(self);
    return;
  }

  self.think = target_explosion_explode;
  self.nextthink = Gtime_add(level.time, Gtime_from_sec(self.delay));
});

/** g_target.cpp:392-396: `void SP_target_explosion(edict_t *ent)`. */
export function SP_target_explosion(ent: EdictT): void {
  ent.use = use_target_explosion;
  ent.svflags = SvflagsT.SVF_NOCLIENT;
}

// ---------------------------------------------------------------------------
// target_changelevel
// ---------------------------------------------------------------------------

/** g_target.cpp:403-464: `USE(use_target_changelevel)`. */
export const use_target_changelevel: UseFn = RegisterUse("use_target_changelevel", (self: EdictT, other: EdictT | null, activator: EdictT | null): void => {
  if (Gtime_nonzero(level.intermissiontime)) return; // already activated

  if (!deathmatchEnabled() && !coopEnabled()) {
    if (g_edicts[1].health <= 0) return;
  }

  // if noexit, do a ton of damage to other
  if (deathmatchEnabled() && !dmAllowExit() && other !== null && other !== g_edicts[0]) {
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, 10 * other.max_health, 1000, DamageflagsT.DAMAGE_NONE, modFromId(ModIdT.MOD_EXIT));
    return;
  }

  // if multiplayer, let everyone know who hit the exit
  if (deathmatchEnabled()) {
    if (level.time < Gtime_from_sec(10)) return;

    if (activator !== null && activator.client !== null) {
      gi.Loc_Print(null, PrintTypeT.PRINT_HIGH | PrintTypeT.PRINT_BROADCAST, "$g_exited_level", [activator.client.pers.netname], 1);
    }
  }

  // if going to a new unit, clear cross triggers
  if (self.map !== null && self.map.includes("*")) {
    game.cross_level_flags &= ~SFL_CROSS_TRIGGER_MASK;
  }

  // if map has a landmark, store position instead of using spawn next map
  if (activator !== null && activator.client !== null && !deathmatchEnabled()) {
    activator.client.landmark_name = null;
    activator.client.landmark_rel_pos = vec3_origin;

    self.target_ent = self.target !== null ? G_PickTarget(self.target) : null;
    if (self.target_ent !== null) {
      activator.client.landmark_name = self.target_ent.targetname;

      // get relative vector to landmark pos, and unrotate by the landmark
      // angles in preparation to be rotated by the next map
      activator.client.landmark_rel_pos = vec3_sub(activator.s.origin, self.target_ent.s.origin);

      activator.client.landmark_rel_pos = RotatePointAroundVector(vec3(1, 0, 0), activator.client.landmark_rel_pos, -self.target_ent.s.angles[0]);
      activator.client.landmark_rel_pos = RotatePointAroundVector(vec3(0, 1, 0), activator.client.landmark_rel_pos, -self.target_ent.s.angles[2]);
      activator.client.landmark_rel_pos = RotatePointAroundVector(vec3(0, 0, 1), activator.client.landmark_rel_pos, -self.target_ent.s.angles[1]);

      activator.client.oldvelocity = RotatePointAroundVector(vec3(1, 0, 0), activator.client.oldvelocity, -self.target_ent.s.angles[0]);
      activator.client.oldvelocity = RotatePointAroundVector(vec3(0, 1, 0), activator.client.oldvelocity, -self.target_ent.s.angles[2]);
      activator.client.oldvelocity = RotatePointAroundVector(vec3(0, 0, 1), activator.client.oldvelocity, -self.target_ent.s.angles[1]);

      // unrotate our view angles for the next map too
      activator.client.oldviewangles = vec3_sub(activator.client.ps.viewangles, self.target_ent.s.angles);
    }
  }

  BeginIntermission(self);
});

/** g_target.cpp:466-477: `void SP_target_changelevel(edict_t *ent)`. */
export function SP_target_changelevel(ent: EdictT): void {
  if (ent.map === null) {
    gi.Com_Print(`${ent.classname ?? "?"}: no map\n`);
    G_FreeEdict(ent);
    return;
  }

  ent.use = use_target_changelevel;
  ent.svflags = SvflagsT.SVF_NOCLIENT;
}

// ---------------------------------------------------------------------------
// target_splash
// ---------------------------------------------------------------------------

/** g_target.cpp:497-509: `USE(use_target_splash)`. */
export const use_target_splash: UseFn = RegisterUse("use_target_splash", (self: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_SPLASH);
  gi.WriteByte(self.count);
  gi.WritePosition(self.s.origin);
  gi.WriteDir(self.movedir);
  gi.WriteByte(self.sounds);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PVS, false);

  if (self.dmg !== 0) {
    if (activator === null) throw new Error("use_target_splash: activator is null (invariant violated -- T_RadiusDamage requires a real attacker)");
    T_RadiusDamage(self, activator, self.dmg, null, self.dmg + 40, DamageflagsT.DAMAGE_NONE, modFromId(ModIdT.MOD_SPLASH));
  }
});

/** g_target.cpp:511-524: `void SP_target_splash(edict_t *self)`. */
export function SP_target_splash(self: EdictT): void {
  self.use = use_target_splash;
  G_SetMovedir(self.s.angles, self.movedir);

  if (self.count === 0) self.count = 32;

  // N64 "sparks" are blue, not yellow.
  if (level.is_n64 && self.sounds === 1) self.sounds = 7;

  self.svflags = SvflagsT.SVF_NOCLIENT;
}

// ---------------------------------------------------------------------------
// target_spawner
// ---------------------------------------------------------------------------

/** g_target.cpp:542-568: `USE(use_target_spawner)`. */
export const use_target_spawner: UseFn = RegisterUse("use_target_spawner", (self: EdictT): void => {
  const ent = G_Spawn();
  ent.classname = self.target;
  // RAFAEL
  ent.flags = self.flags;
  // RAFAEL
  ent.s.origin = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]);
  ent.s.angles = vec3(self.s.angles[0], self.s.angles[1], self.s.angles[2]);
  // `st = {};` in the C++ resets the shared spawn-temp global for the
  // upcoming ED_CallSpawn -- a no-op here since this port's own `st`
  // placeholder (see file header) is always already empty.

  // [Paril-KEX] although I fixed these in our maps, this is just in case
  // anybody else does this by accident. Don't count these monsters so they
  // don't inflate the monster count.
  ent.monsterinfo.aiflags |= MonsterAiFlagsT.AI_DO_NOT_COUNT;

  ED_CallSpawn(ent);
  gi.linkentity(ent);

  KillBox(ent, false);
  if (self.speed !== 0) ent.velocity = vec3(self.movedir[0], self.movedir[1], self.movedir[2]);

  ent.s.renderfx |= RenderfxT.RF_IR_VISIBLE; // PGM
});

/** g_target.cpp:570-579: `void SP_target_spawner(edict_t *self)`. */
export function SP_target_spawner(self: EdictT): void {
  self.use = use_target_spawner;
  self.svflags = SvflagsT.SVF_NOCLIENT;
  if (self.speed !== 0) {
    G_SetMovedir(self.s.angles, self.movedir);
    self.movedir = vec3_muls(self.movedir, self.speed);
  }
}

// ---------------------------------------------------------------------------
// target_blaster
// ---------------------------------------------------------------------------

const SPAWNFLAG_BLASTER_NOTRAIL: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAG_BLASTER_NOEFFECTS: SpawnFlags = SpawnFlags_from(2);

/** g_target.cpp:593-606: `USE(use_target_blaster)`. */
export const use_target_blaster: UseFn = RegisterUse("use_target_blaster", (self: EdictT): void => {
  const effect: EffectsT = SpawnFlags_has(self.spawnflags, SPAWNFLAG_BLASTER_NOEFFECTS)
    ? EffectsT.EF_NONE
    : SpawnFlags_has(self.spawnflags, SPAWNFLAG_BLASTER_NOTRAIL)
      ? EffectsT.EF_HYPERBLASTER
      : EffectsT.EF_BLASTER;

  fire_blaster(self, self.s.origin, self.movedir, self.dmg, self.speed, effect, modFromId(ModIdT.MOD_TARGET_BLASTER));
  gi.sound(self, SoundchanT.CHAN_VOICE, self.noise_index, 1, ATTN_NORM, 0);
});

/** g_target.cpp:608-620: `void SP_target_blaster(edict_t *self)`. */
export function SP_target_blaster(self: EdictT): void {
  self.use = use_target_blaster;
  G_SetMovedir(self.s.angles, self.movedir);
  self.noise_index = gi.soundindex("weapons/laser2.wav");

  if (self.dmg === 0) self.dmg = 15;
  if (self.speed === 0) self.speed = 1000;

  self.svflags = SvflagsT.SVF_NOCLIENT;
}

// ---------------------------------------------------------------------------
// target_crosslevel_trigger / target_crosslevel_target
// (no deathmatch guard in the C++ source -- see the crossunit pair much
// further below, which DOES have one; a genuine asymmetry, preserved)
// ---------------------------------------------------------------------------

/** g_target.cpp:627-631: `USE(trigger_crosslevel_trigger_use)`. */
export const trigger_crosslevel_trigger_use: UseFn = RegisterUse("trigger_crosslevel_trigger_use", (self: EdictT): void => {
  game.cross_level_flags |= self.spawnflags;
  G_FreeEdict(self);
});

/** g_target.cpp:633-637: `void SP_target_crosslevel_trigger(edict_t *self)`. */
export function SP_target_crosslevel_trigger(self: EdictT): void {
  self.svflags = SvflagsT.SVF_NOCLIENT;
  self.use = trigger_crosslevel_trigger_use;
}

/** g_target.cpp:645-652: `THINK(target_crosslevel_target_think)`. */
export const target_crosslevel_target_think: ThinkFn = RegisterThink("target_crosslevel_target_think", (self: EdictT): void => {
  if (self.spawnflags === (game.cross_level_flags & SFL_CROSS_TRIGGER_MASK & self.spawnflags)) {
    G_UseTargets(self, self);
    G_FreeEdict(self);
  }
});

/** g_target.cpp:654-662: `void SP_target_crosslevel_target(edict_t *self)`. */
export function SP_target_crosslevel_target(self: EdictT): void {
  if (self.delay === 0) self.delay = 1;
  self.svflags = SvflagsT.SVF_NOCLIENT;

  self.think = target_crosslevel_target_think;
  self.nextthink = Gtime_add(level.time, Gtime_from_sec(self.delay));
}

// ---------------------------------------------------------------------------
// target_laser
// ---------------------------------------------------------------------------

const SPAWNFLAG_LASER_ON = SpawnFlags_from(0x0001);
const SPAWNFLAG_LASER_RED = SpawnFlags_from(0x0002);
const SPAWNFLAG_LASER_GREEN = SpawnFlags_from(0x0004);
const SPAWNFLAG_LASER_BLUE = SpawnFlags_from(0x0008);
const SPAWNFLAG_LASER_YELLOW = SpawnFlags_from(0x0010);
const SPAWNFLAG_LASER_ORANGE = SpawnFlags_from(0x0020);
const SPAWNFLAG_LASER_FAT = SpawnFlags_from(0x0040);
/** g_target.cpp:674: local to this file (not shared like the flags above). */
const SPAWNFLAG_LASER_STOPWINDOW = SpawnFlags_from(0x0080);
const SPAWNFLAG_LASER_LIGHTNING = SpawnFlags_from(0x10000);
const SPAWNFLAG_LASER_ZAP = SpawnFlags_from(0x80000000);
/** func_train's own spawnflag (g_func.cpp, unported) -- see the narrow N64 branch below. */
const SPAWNFLAG_TRAIN_START_ON = SpawnFlags_from(0x01);

/** g_local.h:136-139 `game_import_t::traceline` convenience wrapper. */
function giTraceline(start: Vec3, end: Vec3, passent: EdictT | null, mask: ContentsT): KexTraceT {
  return gi.trace(start, null, null, end, passent, mask);
}

// markPierce/restorePierce/pierceTrace: formerly real, local logic here
// (see this file's own header, "STUB SWAP: fire_blaster / pierce_trace /
// GetUnicastKey") -- now imported for real from src/kexgame/g_weapon.ts,
// the actual C++ home of `pierce_args_t::mark`/`::restore` and
// `pierce_trace` (g_local.h:3562-3587 / g_weapon.cpp:88-108).

/** g_target.cpp:679-728: `struct laser_pierce_t : pierce_args_t` -- its `hit()` override. */
function makeLaserHit(self: EdictT, count: number, pierce: PierceArgsT, laserState: { damaged_thing: boolean }): PierceHitFn {
  return (_mask: [ContentsT], _end: Vec3): boolean => {
    const tr = pierce.tr;
    if (tr.ent === null) return false;
    const hitEnt = traceEdict(tr.ent);

    // hurt it if we can
    if (self.dmg > 0 && hitEnt.takedamage && (hitEnt.flags & EntFlagsT.FL_IMMUNE_LASER) === 0n && self.damage_debounce_time <= level.time) {
      laserState.damaged_thing = true;
      T_Damage(hitEnt, self, requireActivator(self, "target_laser_think"), self.movedir, tr.endpos, vec3_origin, self.dmg, 1, DamageflagsT.DAMAGE_ENERGY, modFromId(ModIdT.MOD_TARGET_LASER));
    }

    // if we hit something that's not a monster or player or is immune to
    // lasers, we're done
    // ROGUE
    if ((hitEnt.svflags & SvflagsT.SVF_MONSTER) === 0 && hitEnt.client === null && (hitEnt.flags & EntFlagsT.FL_DAMAGEABLE) === 0n) {
      if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_LASER_ZAP)) {
        self.spawnflags = SpawnFlags_from(self.spawnflags & ~SPAWNFLAG_LASER_ZAP);
        gi.WriteByte(ServerCommandT.svc_temp_entity);
        gi.WriteByte(KexTempEventT.TE_LASER_SPARKS);
        gi.WriteByte(count);
        gi.WritePosition(tr.endpos);
        gi.WriteDir(tr.plane.normal);
        gi.WriteByte(self.s.skinnum);
        gi.multicast(tr.endpos, KexMulticastT.MULTICAST_PVS, false);
      }

      return false;
    }

    if (!markPierce(pierce, hitEnt)) return false;

    return true;
  };
}

/** g_target.cpp:730-768: `THINK(target_laser_think)`. */
export const target_laser_think: ThinkFn = RegisterThink("target_laser_think", (self: EdictT): void => {
  const count = SpawnFlags_has(self.spawnflags, SPAWNFLAG_LASER_ZAP) ? 8 : 4;

  if (self.enemy !== null) {
    const last_movedir = vec3(self.movedir[0], self.movedir[1], self.movedir[2]);
    const point = vec3_muls(vec3_add(self.enemy.absmin, self.enemy.absmax), 0.5);
    self.movedir = vec3_normalized(vec3_sub(point, self.s.origin));
    if (!vec3_equals(self.movedir, last_movedir)) self.spawnflags = SpawnFlags_from(self.spawnflags | SPAWNFLAG_LASER_ZAP);
  }

  const start = self.s.origin;
  const end = vec3_add(start, vec3_muls(self.movedir, 2048));

  const laserState = { damaged_thing: false };
  const pierce: PierceArgsT = {
    pierced: new Array<EdictT | null>(MAX_PIERCE).fill(null),
    pierce_solidities: new Array<number>(MAX_PIERCE).fill(0),
    num_pierced: 0,
    tr: giTraceline(start, start, self, ContentsT.CONTENTS_SOLID),
    hit: () => false,
  };
  pierce.hit = makeLaserHit(self, count, pierce, laserState);

  const mask: ContentsT = SpawnFlags_has(self.spawnflags, SPAWNFLAG_LASER_STOPWINDOW)
    ? MASK_SHOT
    : ContentsT.CONTENTS_SOLID | ContentsT.CONTENTS_MONSTER | ContentsT.CONTENTS_PLAYER | ContentsT.CONTENTS_DEADMONSTER;

  pierceTrace(start, end, self, pierce, mask);

  self.s.old_origin = pierce.tr.endpos;

  if (laserState.damaged_thing) self.damage_debounce_time = Gtime_add(level.time, Gtime_from_ms(100)); // 10_hz

  self.nextthink = Gtime_add(level.time, Gtime_from_ms(gi.frame_time_ms));
  gi.linkentity(self);

  restorePierce(pierce); // destructor-at-scope-exit timing -- see file header
});

/** g_target.cpp:770-778: `void target_laser_on(edict_t *self)`. */
export function target_laser_on(self: EdictT): void {
  if (self.activator === null) self.activator = self;
  self.spawnflags = SpawnFlags_from(self.spawnflags | SPAWNFLAG_LASER_ZAP | SPAWNFLAG_LASER_ON);
  self.svflags &= ~SvflagsT.SVF_NOCLIENT;
  self.flags |= EntFlagsT.FL_TRAP;
  target_laser_think(self);
}

/** g_target.cpp:780-786: `void target_laser_off(edict_t *self)`. */
export function target_laser_off(self: EdictT): void {
  self.spawnflags = SpawnFlags_from(self.spawnflags & ~SPAWNFLAG_LASER_ON);
  self.svflags |= SvflagsT.SVF_NOCLIENT;
  self.flags &= ~EntFlagsT.FL_TRAP;
  self.nextthink = GTIME_ZERO;
}

/** g_target.cpp:788-795: `USE(target_laser_use)`. */
export const target_laser_use: UseFn = RegisterUse("target_laser_use", (self: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
  self.activator = activator;
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_LASER_ON)) target_laser_off(self);
  else target_laser_on(self);
});

/** g_target.cpp:797-883: `THINK(target_laser_start)`. */
export const target_laser_start: ThinkFn = RegisterThink("target_laser_start", (self: EdictT): void => {
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.solid = SolidT.SOLID_NOT;
  self.s.renderfx |= RenderfxT.RF_BEAM;
  self.s.modelindex = MODELINDEX_WORLD; // must be non-zero

  // [Sam-KEX] On Q2N64, spawnflag of 128 turns it into a lightning bolt
  if (level.is_n64) {
    // Paril: fix for N64
    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_LASER_STOPWINDOW)) {
      self.spawnflags = SpawnFlags_from(self.spawnflags & ~SPAWNFLAG_LASER_STOPWINDOW);
      self.spawnflags = SpawnFlags_from(self.spawnflags | SPAWNFLAG_LASER_LIGHTNING);
    }
  }

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_LASER_LIGHTNING)) {
    self.s.renderfx |= RF_BEAM_LIGHTNING; // tell renderer it is lightning

    if (self.s.skinnum === 0) self.s.skinnum = 0xf3f3f1f1; // default lightning color
  }

  // set the beam diameter
  // [Paril-KEX] lab has this set prob before lightning was implemented
  if (!level.is_n64 && SpawnFlags_has(self.spawnflags, SPAWNFLAG_LASER_FAT)) self.s.frame = 16;
  else self.s.frame = 4;

  // set the color
  if (self.s.skinnum === 0) {
    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_LASER_RED)) self.s.skinnum = 0xf2f2f0f0;
    else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_LASER_GREEN)) self.s.skinnum = 0xd0d1d2d3;
    else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_LASER_BLUE)) self.s.skinnum = 0xf3f3f1f1;
    else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_LASER_YELLOW)) self.s.skinnum = 0xdcdddedf;
    else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_LASER_ORANGE)) self.s.skinnum = 0xe0e1e2e3;
  }

  if (self.enemy === null) {
    if (self.target !== null) {
      const ent = G_FindByString(null, "targetname", self.target);
      if (ent === null) {
        gi.Com_Print(`${self.classname ?? "?"}: ${self.target} is a bad target\n`);
      } else {
        self.enemy = ent;

        // N64 fix
        // FIXME: which map was this for again? oops
        if (level.is_n64 && ent.classname === "func_train" && !SpawnFlags_has(ent.spawnflags, SPAWNFLAG_TRAIN_START_ON)) {
          if (ent.use !== null) ent.use(ent, self, self);
        }
      }
    } else {
      G_SetMovedir(self.s.angles, self.movedir);
    }
  }
  self.use = target_laser_use;
  self.think = target_laser_think;

  if (self.dmg === 0) self.dmg = 1;

  self.mins = vec3(-8, -8, -8);
  self.maxs = vec3(8, 8, 8);
  gi.linkentity(self);

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_LASER_ON)) target_laser_on(self);
  else target_laser_off(self);
});

/** g_target.cpp:885-891: `void SP_target_laser(edict_t *self)`. */
export function SP_target_laser(self: EdictT): void {
  // let everything else get spawned before we start firing
  self.think = target_laser_start;
  self.flags |= EntFlagsT.FL_TRAP_LASER_FIELD;
  self.nextthink = Gtime_add(level.time, Gtime_from_sec(1));
}

// ---------------------------------------------------------------------------
// target_lightramp
// ---------------------------------------------------------------------------

const SPAWNFLAG_LIGHTRAMP_TOGGLE: SpawnFlags = SpawnFlags_from(1);

/** g_target.cpp:902-924: `THINK(target_lightramp_think)`. */
export const target_lightramp_think: ThinkFn = RegisterThink("target_lightramp_think", (self: EdictT): void => {
  if (self.enemy === null) throw new Error("target_lightramp_think: self.enemy is null (invariant violated -- always set by target_lightramp_use before this runs)");

  const diffOverFrame = Gtime_seconds(Gtime_subtract(level.time, self.timestamp)) / gi.frame_time_s;
  const value = Math.trunc("a".charCodeAt(0) + self.movedir[0] + diffOverFrame * self.movedir[2]);
  const style = String.fromCharCode(value & 0xff);

  gi.configstring(CS_LIGHTS + self.enemy.style, style);

  if (Gtime_seconds(Gtime_subtract(level.time, self.timestamp)) < self.speed) {
    self.nextthink = Gtime_add(level.time, Gtime_from_ms(gi.frame_time_ms));
  } else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_LIGHTRAMP_TOGGLE)) {
    const temp = self.movedir[0];
    self.movedir[0] = self.movedir[1];
    self.movedir[1] = temp;
    self.movedir[2] *= -1;
  }
});

/** g_target.cpp:926-959: `USE(target_lightramp_use)`. */
export const target_lightramp_use: UseFn = RegisterUse("target_lightramp_use", (self: EdictT): void => {
  if (self.enemy === null) {
    // check all the targets
    let e = self.target !== null ? G_FindByString(null, "targetname", self.target) : null;
    while (e !== null) {
      if (e.classname !== "light") {
        gi.Com_Print(`${self.classname ?? "?"}: target ${self.target ?? "?"} (${e.classname ?? "?"}) is not a light\n`);
      } else {
        self.enemy = e;
      }
      e = self.target !== null ? G_FindByString(e, "targetname", self.target) : null;
    }

    if (self.enemy === null) {
      gi.Com_Print(`${self.classname ?? "?"}: target ${self.target ?? "?"} not found\n`);
      G_FreeEdict(self);
      return;
    }
  }

  self.timestamp = level.time;
  target_lightramp_think(self);
});

/** g_target.cpp:961-990: `void SP_target_lightramp(edict_t *self)`. */
export function SP_target_lightramp(self: EdictT): void {
  if (self.message === null || self.message.length !== 2 || self.message[0] < "a" || self.message[0] > "z" || self.message[1] < "a" || self.message[1] > "z" || self.message[0] === self.message[1]) {
    gi.Com_Print(`${self.classname ?? "?"}: bad ramp (${self.message ?? "null string"})\n`);
    G_FreeEdict(self);
    return;
  }

  if (deathmatchEnabled()) {
    G_FreeEdict(self);
    return;
  }

  if (self.target === null) {
    gi.Com_Print(`${self.classname ?? "?"}: no target\n`);
    G_FreeEdict(self);
    return;
  }

  self.svflags |= SvflagsT.SVF_NOCLIENT;
  self.use = target_lightramp_use;
  self.think = target_lightramp_think;

  self.movedir[0] = self.message.charCodeAt(0) - "a".charCodeAt(0);
  self.movedir[1] = self.message.charCodeAt(1) - "a".charCodeAt(0);
  self.movedir[2] = (self.movedir[1] - self.movedir[0]) / (self.speed / gi.frame_time_s);
}

// ---------------------------------------------------------------------------
// target_earthquake
// ---------------------------------------------------------------------------

const SPAWNFLAGS_EARTHQUAKE_SILENT: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAGS_EARTHQUAKE_TOGGLE: SpawnFlags = SpawnFlags_from(2);
const SPAWNFLAGS_EARTHQUAKE_ONE_SHOT: SpawnFlags = SpawnFlags_from(8);

/** g_target.cpp:1006-1032: `THINK(target_earthquake_think)`. */
export const target_earthquake_think: ThinkFn = RegisterThink("target_earthquake_think", (self: EdictT): void => {
  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAGS_EARTHQUAKE_SILENT)) {
    if (self.last_move_time < level.time) {
      gi.positioned_sound(self.s.origin, self, SoundchanT.CHAN_VOICE, self.noise_index, 1.0, ATTN_NONE, 0);
      self.last_move_time = Gtime_add(level.time, Gtime_from_ms(6500));
    }
  }

  for (let i = 1; i < globals.num_edicts; i++) {
    const e = g_edicts[i];
    if (e === undefined || !e.inuse) continue;
    if (e.client === null) break;

    e.client.quake_time = Gtime_add(level.time, Gtime_from_ms(1000));
  }

  if (level.time < self.timestamp) self.nextthink = Gtime_add(level.time, Gtime_from_ms(100)); // 10_hz
});

/** g_target.cpp:1034-1073: `USE(target_earthquake_use)`. */
export const target_earthquake_use: UseFn = RegisterUse("target_earthquake_use", (self: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAGS_EARTHQUAKE_ONE_SHOT)) {
    for (let i = 1; i < globals.num_edicts; i++) {
      const e = g_edicts[i];
      if (e === undefined || !e.inuse) continue;
      if (e.client === null) break;

      e.client.v_dmg_pitch = -self.speed * 0.1;
      e.client.v_dmg_time = Gtime_add(level.time, DAMAGE_TIME(Gtime_from_ms(gi.frame_time_ms)));
    }

    return;
  }

  self.timestamp = Gtime_add(level.time, Gtime_from_sec(self.count));

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAGS_EARTHQUAKE_TOGGLE)) {
    if (self.style !== 0) self.nextthink = GTIME_ZERO;
    else self.nextthink = Gtime_add(level.time, Gtime_from_ms(gi.frame_time_ms));

    self.style = self.style !== 0 ? 0 : 1;
  } else {
    self.nextthink = Gtime_add(level.time, Gtime_from_ms(gi.frame_time_ms));
    self.last_move_time = GTIME_ZERO;
  }

  self.activator = activator;
});

/** g_target.cpp:1075-1098: `void SP_target_earthquake(edict_t *self)`. */
export function SP_target_earthquake(self: EdictT): void {
  if (self.targetname === null) gi.Com_Print(`${self.classname ?? "?"}: untargeted\n`);

  if (level.is_n64) {
    self.spawnflags = SpawnFlags_from(self.spawnflags | SPAWNFLAGS_EARTHQUAKE_TOGGLE);
    self.speed = 5;
  }

  if (self.count === 0) self.count = 5;
  if (self.speed === 0) self.speed = 200;

  self.svflags |= SvflagsT.SVF_NOCLIENT;
  self.think = target_earthquake_think;
  self.use = target_earthquake_use;

  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAGS_EARTHQUAKE_SILENT)) self.noise_index = gi.soundindex("world/quake.wav");
}

// ---------------------------------------------------------------------------
// target_camera
// ---------------------------------------------------------------------------

const HACKFLAG_TELEPORT_OUT = 2;
const HACKFLAG_SKIPPABLE = 64;
const HACKFLAG_END_OF_UNIT = 128;

/** g_target.cpp:1108-1136: `static void camera_lookat_pathtarget(...)`. */
function camera_lookat_pathtarget(self: EdictT, origin: Vec3, dest: Vec3): void {
  if (self.pathtarget === null) return;

  const pt = G_FindByString(null, "targetname", self.pathtarget);
  if (pt === null) return;

  const delta = vec3_sub(pt.s.origin, origin);
  const d = delta[0] * delta[0] + delta[1] * delta[1];
  let yaw: number;
  let pitch: number;

  if (d === 0) {
    yaw = 0;
    pitch = delta[2] > 0 ? 90 : -90;
  } else {
    yaw = Math.atan2(delta[1], delta[0]) * (180 / Math.PI);
    pitch = Math.atan2(delta[2], Math.sqrt(d)) * (180 / Math.PI);
  }

  dest[1] = yaw; // YAW
  dest[0] = -pitch; // PITCH
  dest[2] = 0; // ROLL
}

/** g_target.cpp:1138-1250: `THINK(update_target_camera)`. */
export const update_target_camera: ThinkFn = RegisterThink("update_target_camera", (self: EdictT): void => {
  let do_skip = false;

  // only allow skipping after 2 seconds
  if ((self.hackflags & HACKFLAG_SKIPPABLE) !== 0 && level.time > Gtime_from_sec(2)) {
    for (let i = 0; i < game.maxclients; i++) {
      const client = g_edicts[1 + i];
      if (client === undefined || !client.inuse || client.client === null || !client.client.pers.connected) continue;

      if ((client.client.buttons & ButtonT.BUTTON_ANY) !== 0) {
        do_skip = true;
        break;
      }
    }
  }

  if (!do_skip && self.movetarget !== null) {
    self.moveinfo.remaining_distance -= self.moveinfo.move_speed * gi.frame_time_s * 0.8;

    if (self.moveinfo.remaining_distance <= 0) {
      if ((self.movetarget.hackflags & HACKFLAG_TELEPORT_OUT) !== 0) {
        if (self.enemy !== null) {
          self.enemy.s.event = KexEntityEventT.EV_PLAYER_TELEPORT;
          self.enemy.hackflags = HACKFLAG_TELEPORT_OUT;
          const teleportTime = Gtime_from_sec(self.movetarget.wait);
          self.enemy.pain_debounce_time = teleportTime;
          self.enemy.timestamp = teleportTime;
        }
      }

      self.s.origin = vec3(self.movetarget.s.origin[0], self.movetarget.s.origin[1], self.movetarget.s.origin[2]);
      self.nextthink = Gtime_add(level.time, Gtime_from_sec(self.movetarget.wait));
      if (self.movetarget.target !== null) {
        self.movetarget = G_PickTarget(self.movetarget.target);

        if (self.movetarget !== null) {
          self.moveinfo.move_speed = self.movetarget.speed !== 0 ? self.movetarget.speed : 55;
          self.moveinfo.remaining_distance = vec3_length(vec3_sub(self.movetarget.s.origin, self.s.origin));
          self.moveinfo.distance = self.moveinfo.remaining_distance;
        }
      } else {
        self.movetarget = null;
      }

      return;
    } else {
      const frac = 1.0 - self.moveinfo.remaining_distance / self.moveinfo.distance;

      if (self.enemy !== null && (self.enemy.hackflags & HACKFLAG_TELEPORT_OUT) !== 0) {
        self.enemy.s.alpha = Math.max(1 / 255, frac);
      }

      const delta = vec3_muls(vec3_sub(self.movetarget.s.origin, self.s.origin), frac);
      const newpos = vec3_add(self.s.origin, delta);

      camera_lookat_pathtarget(self, newpos, level.intermission_angle);
      level.intermission_origin = newpos;

      // move all clients to the intermission point
      for (let i = 0; i < game.maxclients; i++) {
        const client = g_edicts[1 + i];
        if (client === undefined || !client.inuse) continue;

        MoveClientToIntermission(client);
      }
    }
  } else {
    if (self.killtarget !== null) {
      // destroy dummy player
      if (self.enemy !== null) G_FreeEdict(self.enemy);

      level.intermissiontime = GTIME_ZERO;
      level.level_intermission_set = true;

      let t = G_FindByString(null, "targetname", self.killtarget);
      while (t !== null) {
        if (t.use !== null) t.use(t, self, self.activator);
        t = G_FindByString(t, "targetname", self.killtarget);
      }

      level.intermissiontime = level.time;
      level.intermission_server_frame = gi.ServerFrame();

      // end of unit requires a wait
      if (level.changemap !== null && !level.changemap.includes("*")) level.exitintermission = true;
    }

    self.think = null;
    return;
  }

  self.nextthink = Gtime_add(level.time, Gtime_from_ms(gi.frame_time_ms));
});

/** g_target.cpp:1256-1273: `THINK(target_camera_dummy_think)`. */
export const target_camera_dummy_think: ThinkFn = RegisterThink("target_camera_dummy_think", (self: EdictT): void => {
  if (self.owner === null) throw new Error("target_camera_dummy_think: self.owner is null (invariant violated -- always set by use_target_camera before this runs)");

  // bit of a hack, but this will let the dummy move like a player
  self.client = self.owner.client;
  xyspeed = Math.sqrt(self.velocity[0] * self.velocity[0] + self.velocity[1] * self.velocity[1]);
  G_SetClientFrame(self);
  self.client = null;

  // alpha fade out for voops
  if ((self.hackflags & HACKFLAG_TELEPORT_OUT) !== 0) {
    const dec = Gtime_subtract(self.timestamp, Gtime_from_ms(100));
    self.timestamp = Gtime_seconds(dec) < 0 ? GTIME_ZERO : dec;
    self.s.alpha = Math.max(1 / 255, Gtime_seconds(self.timestamp) / Gtime_seconds(self.pain_debounce_time));
  }

  self.nextthink = Gtime_add(level.time, Gtime_from_ms(100));
});

/** g_target.cpp:1275-1353: `USE(use_target_camera)`. */
export const use_target_camera: UseFn = RegisterUse("use_target_camera", (self: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
  if (self.sounds !== 0) gi.configstring(CS_CDTRACK, `${self.sounds}`);

  if (self.target === null) return;

  self.movetarget = G_PickTarget(self.target);

  if (self.movetarget === null) return;

  level.intermissiontime = level.time;
  level.intermission_server_frame = gi.ServerFrame();
  level.exitintermission = false;

  // spawn fake player dummy where we were
  if (activator !== null && activator.client !== null) {
    const dummy = G_Spawn();
    self.enemy = dummy;
    dummy.owner = activator;
    dummy.clipmask = activator.clipmask;
    dummy.s.origin = vec3(activator.s.origin[0], activator.s.origin[1], activator.s.origin[2]);
    dummy.s.angles = vec3(activator.s.angles[0], activator.s.angles[1], activator.s.angles[2]);
    dummy.groundentity = activator.groundentity;
    dummy.groundentity_linkcount = dummy.groundentity !== null ? dummy.groundentity.linkcount : 0;
    dummy.think = target_camera_dummy_think;
    dummy.nextthink = Gtime_add(level.time, Gtime_from_ms(100));
    dummy.solid = SolidT.SOLID_BBOX;
    dummy.movetype = MovetypeT.MOVETYPE_STEP;
    dummy.mins = vec3(activator.mins[0], activator.mins[1], activator.mins[2]);
    dummy.maxs = vec3(activator.maxs[0], activator.maxs[1], activator.maxs[2]);
    dummy.s.modelindex = MODELINDEX_PLAYER;
    dummy.s.modelindex2 = MODELINDEX_PLAYER;
    dummy.s.skinnum = activator.s.skinnum;
    dummy.velocity = vec3(activator.velocity[0], activator.velocity[1], activator.velocity[2]);
    dummy.s.renderfx = RenderfxT.RF_MINLIGHT;
    dummy.s.frame = activator.s.frame;
    gi.linkentity(dummy);
  }

  camera_lookat_pathtarget(self, self.s.origin, level.intermission_angle);
  level.intermission_origin = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]);

  // move all clients to the intermission point
  for (let i = 0; i < game.maxclients; i++) {
    const client = g_edicts[1 + i];
    if (client === undefined || !client.inuse) continue;

    // respawn any dead clients
    if (client.health <= 0) {
      // give us our max health back since it will reset to pers.health; in
      // instanced items we'd lose the items we touched so we always want to
      // respawn with our max.
      if (P_UseCoopInstancedItems() && client.client !== null) {
        client.client.pers.health = client.max_health;
        client.client.pers.max_health = client.max_health;
      }

      respawn(client);
    }

    MoveClientToIntermission(client);
  }

  self.activator = activator;
  self.think = update_target_camera;
  self.nextthink = Gtime_add(level.time, Gtime_from_sec(self.wait));
  self.moveinfo.move_speed = self.speed;

  self.moveinfo.remaining_distance = vec3_length(vec3_sub(self.movetarget.s.origin, self.s.origin));
  self.moveinfo.distance = self.moveinfo.remaining_distance;

  if ((self.hackflags & HACKFLAG_END_OF_UNIT) !== 0) G_EndOfUnitMessage();
});

/** g_target.cpp:1355-1365: `void SP_target_camera(edict_t *self)`. */
export function SP_target_camera(self: EdictT): void {
  if (deathmatchEnabled()) {
    G_FreeEdict(self);
    return;
  }

  self.use = use_target_camera;
  self.svflags = SvflagsT.SVF_NOCLIENT;
}

// ---------------------------------------------------------------------------
// target_gravity (KEX-added; distinct from g_trigger.ts's trigger_gravity)
// ---------------------------------------------------------------------------

/** g_target.cpp:1371-1375: `USE(use_target_gravity)`. */
export const use_target_gravity: UseFn = RegisterUse("use_target_gravity", (self: EdictT): void => {
  gi.cvar_set("sv_gravity", `${self.gravity}`);
  level.gravity = self.gravity;
});

/** g_target.cpp:1377-1381: `void SP_target_gravity(edict_t* self)`. */
export function SP_target_gravity(self: EdictT): void {
  self.use = use_target_gravity;
  // `atof(st.gravity)` is UB in the C++ source when `st.gravity` is
  // nullptr (always true today, see file header); "0" is the closest
  // faithful behavior for a defined input, not a guess at UB.
  self.gravity = Number(st.gravity ?? "0");
}

// ---------------------------------------------------------------------------
// target_soundfx
// ---------------------------------------------------------------------------

/** g_target.cpp:1387-1390: `THINK(update_target_soundfx)`. */
export const update_target_soundfx: ThinkFn = RegisterThink("update_target_soundfx", (self: EdictT): void => {
  gi.positioned_sound(self.s.origin, self, SoundchanT.CHAN_VOICE, self.noise_index, self.volume, self.attenuation, 0);
});

/** g_target.cpp:1392-1396: `USE(use_target_soundfx)`. */
export const use_target_soundfx: UseFn = RegisterUse("use_target_soundfx", (self: EdictT): void => {
  self.think = update_target_soundfx;
  self.nextthink = Gtime_add(level.time, Gtime_from_sec(self.delay));
});

/** g_target.cpp:1398-1433: `void SP_target_soundfx(edict_t* self)`. */
export function SP_target_soundfx(self: EdictT): void {
  if (self.volume === 0) self.volume = 1.0;

  if (self.attenuation === 0) self.attenuation = 1.0;
  else if (self.attenuation === -1) self.attenuation = 0; // use -1 so 0 defaults to 1

  self.noise_index = st.noise !== null ? parseInt(st.noise, 10) : 0;

  switch (self.noise_index) {
    case 1:
      self.noise_index = gi.soundindex("world/x_alarm.wav");
      break;
    case 2:
      self.noise_index = gi.soundindex("world/flyby1.wav");
      break;
    case 4:
      self.noise_index = gi.soundindex("world/amb12.wav");
      break;
    case 5:
      self.noise_index = gi.soundindex("world/amb17.wav");
      break;
    case 7:
      self.noise_index = gi.soundindex("world/bigpump2.wav");
      break;
    default:
      gi.Com_Print(`${self.classname ?? "?"}: unknown noise ${self.noise_index}\n`);
      return;
  }

  self.use = use_target_soundfx;
}

// ---------------------------------------------------------------------------
// target_light
// ---------------------------------------------------------------------------

const SPAWNFLAG_TARGET_LIGHT_START_ON: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAG_TARGET_LIGHT_NO_LERP: SpawnFlags = SpawnFlags_from(2);
const SPAWNFLAG_TARGET_LIGHT_FLICKER: SpawnFlags = SpawnFlags_from(4);

/** g_target.cpp:1444-1450: `THINK(target_light_flicker_think)`. */
export const target_light_flicker_think: ThinkFn = RegisterThink("target_light_flicker_think", (self: EdictT): void => {
  if (brandom()) self.svflags ^= SvflagsT.SVF_NOCLIENT;

  self.nextthink = Gtime_add(level.time, Gtime_from_ms(100));
});

/** g_target.cpp:1453-1499: `THINK(target_light_think)`. */
export const target_light_think: ThinkFn = RegisterThink("target_light_think", (self: EdictT): void => {
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TARGET_LIGHT_FLICKER)) target_light_flicker_think(self);

  const style = gi.get_configstring(CS_LIGHTS + self.style);
  self.delay += self.speed;

  const index = Math.trunc(self.delay) % style.length;
  const style_value = style.charCodeAt(index);
  const current_lerp = (style_value - 97) / (122 - 97); // 'a'=97, 'z'=122
  let lerpVal: number;

  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_TARGET_LIGHT_NO_LERP)) {
    const next_index = (index + 1) % style.length;
    const next_style_value = style.charCodeAt(next_index);
    const next_lerp = (next_style_value - 97) / (122 - 97);

    const mod_lerp = self.delay % 1.0;
    lerpVal = next_lerp * mod_lerp + current_lerp * (1 - mod_lerp);
  } else {
    lerpVal = current_lerp;
  }

  const my_rgb = self.count;
  if (self.chain === null) throw new Error("target_light_think: self.chain is null (invariant violated -- see SP_target_light)");
  const target_rgb = self.chain.s.skinnum;

  const my_b = (my_rgb >> 8) & 0xff;
  const my_g = (my_rgb >> 16) & 0xff;
  const my_r = (my_rgb >> 24) & 0xff;

  const target_b = (target_rgb >> 8) & 0xff;
  const target_g = (target_rgb >> 16) & 0xff;
  const target_r = (target_rgb >> 24) & 0xff;

  const backlerp = 1.0 - lerpVal;

  const b = Math.trunc(target_b * lerpVal + my_b * backlerp);
  const g = Math.trunc(target_g * lerpVal + my_g * backlerp);
  const r = Math.trunc(target_r * lerpVal + my_r * backlerp);

  self.s.skinnum = ((b << 8) | (g << 16) | (r << 24)) >>> 0;

  self.nextthink = Gtime_add(level.time, Gtime_from_ms(100));
});

/** g_target.cpp:1501-1528: `USE(target_light_use)`. */
export const target_light_use: UseFn = RegisterUse("target_light_use", (self: EdictT): void => {
  self.health = self.health !== 0 ? 0 : 1;

  if (self.health !== 0) self.svflags &= ~SvflagsT.SVF_NOCLIENT;
  else self.svflags |= SvflagsT.SVF_NOCLIENT;

  if (self.health === 0) {
    self.think = null;
    self.nextthink = GTIME_ZERO;
    return;
  }

  // has dynamic light "target"
  if (self.chain !== null) {
    self.think = target_light_think;
    self.nextthink = Gtime_add(level.time, Gtime_from_ms(100));
  } else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TARGET_LIGHT_FLICKER)) {
    self.think = target_light_flicker_think;
    self.nextthink = Gtime_add(level.time, Gtime_from_ms(100));
  }
});

/** g_target.cpp:1530-1556: `void SP_target_light(edict_t *self)`. */
export function SP_target_light(self: EdictT): void {
  self.s.modelindex = 1;
  self.s.renderfx = RenderfxT.RF_CUSTOM_LIGHT;
  self.s.frame = st.radius !== 0 ? st.radius : 150;
  self.count = self.s.skinnum;
  self.svflags |= SvflagsT.SVF_NOCLIENT;
  self.health = 0;

  if (self.target !== null) self.chain = G_PickTarget(self.target);

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TARGET_LIGHT_START_ON)) target_light_use(self, self, self);

  if (self.speed === 0) self.speed = 1.0;
  else self.speed = 0.1 / self.speed;

  if (level.is_n64) self.style += 10;

  self.use = target_light_use;

  gi.linkentity(self);
}

// ---------------------------------------------------------------------------
// target_poi
// ---------------------------------------------------------------------------

const SPAWNFLAG_POI_NEAREST: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAG_POI_DUMMY: SpawnFlags = SpawnFlags_from(2);
const SPAWNFLAG_POI_DYNAMIC: SpawnFlags = SpawnFlags_from(4);
const SPAWNFLAG_POI_DISABLED: SpawnFlags = SpawnFlags_from(8);

/** g_target.cpp:1599-1621: `static float distance_to_poi(...)`. */
function distance_to_poi(start: Vec3, end: Vec3): number {
  const request: PathRequest = {
    start,
    goal: end,
    pathFlags: PathFlags.All,
    moveDist: 64,
    debugging: { drawTime: 0 },
    nodeSearch: { ignoreNodeFlags: true, minHeight: 128, maxHeight: 128, radius: 1024 },
    traversals: { dropHeight: 0, jumpHeight: 0 },
    pathPoints: { array: null, count: 0 },
  };

  const info: PathInfo = {
    numPathPoints: 0,
    pathDistSqr: 0,
    firstMovePoint: vec3(0, 0, 0),
    secondMovePoint: vec3(0, 0, 0),
    pathLinkType: PathLinkType.Walk,
    returnCode: PathReturnCode.StartPathErrors,
  };

  if (gi.GetPathToGoal(request, info)) return info.pathDistSqr;

  if (info.returnCode === PathReturnCode.NoNavAvailable) return vec3_lengthSquared(vec3_sub(end, start));

  return Infinity;
}

/** g_target.cpp:1623-1759: `USE(target_poi_use)`. */
export const target_poi_use: UseFn = RegisterUse("target_poi_use", (entIn: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
  let ent: EdictT | null = entIn;

  // we were disabled, so remove the disable check
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_POI_DISABLED)) ent.spawnflags = SpawnFlags_from(ent.spawnflags & ~SPAWNFLAG_POI_DISABLED);

  // early stage check
  if (ent.count !== 0 && level.current_poi_stage > ent.count) return;

  // teamed POIs work a bit differently
  if (ent.team !== null) {
    const poi_master = ent.teammaster;
    ent = null;

    let best_distance = Infinity;
    let best_style = Number.MAX_SAFE_INTEGER;
    let dummy_fallback: EdictT | null = null;

    for (let poi: EdictT | null = poi_master; poi !== null; poi = poi.teamchain) {
      if (SpawnFlags_has(poi.spawnflags, SPAWNFLAG_POI_DISABLED)) continue;

      if (SpawnFlags_has(poi.spawnflags, SPAWNFLAG_POI_DUMMY)) {
        dummy_fallback = poi;
        continue;
      } else if (poi.count !== 0 && level.current_poi_stage > poi.count) continue;
      else if (poi.style > best_style) continue;

      const dist = activator !== null ? distance_to_poi(activator.s.origin, poi.s.origin) : Infinity;

      const masterNearest = poi_master !== null && SpawnFlags_has(poi_master.spawnflags, SPAWNFLAG_POI_NEAREST);

      // we have one already and it's farther away, don't bother
      if (masterNearest && ent !== null && dist > best_distance) continue;

      // found a better style; overwrite dist
      if (poi.style < best_style) {
        // unless we weren't reachable...
        if (masterNearest && !Number.isFinite(dist)) continue;

        best_style = poi.style;
        if (masterNearest) best_distance = dist;
        ent = poi;
        continue;
      }

      // if we're picking by nearest, check distance
      if (masterNearest) {
        if (dist < best_distance) {
          best_distance = dist;
          ent = poi;
          continue;
        }
      } else {
        // not picking by distance, so it's order of appearance
        ent = poi;
      }
    }

    // no valid POI found; this isn't always an error, some valid
    // techniques may require this to happen.
    if (ent === null) {
      if (dummy_fallback !== null && SpawnFlags_has(dummy_fallback.spawnflags, SPAWNFLAG_POI_DYNAMIC)) ent = dummy_fallback;
      else return;
    }

    // copy over POI stage value
    if (ent.count !== 0) {
      if (level.current_poi_stage <= ent.count) level.current_poi_stage = ent.count;
    }
  } else {
    if (ent.count !== 0) {
      if (level.current_poi_stage <= ent.count) level.current_poi_stage = ent.count;
      else return; // this POI is not part of our current stage
    }
  }

  // dummy POI; not valid
  if (ent.classname === "target_poi" && SpawnFlags_has(ent.spawnflags, SPAWNFLAG_POI_DUMMY) && !SpawnFlags_has(ent.spawnflags, SPAWNFLAG_POI_DYNAMIC)) return;

  level.valid_poi = true;
  level.current_poi = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2]);
  level.current_poi_image = ent.noise_index;

  if (ent.classname === "target_poi" && SpawnFlags_has(ent.spawnflags, SPAWNFLAG_POI_DYNAMIC)) {
    level.current_dynamic_poi = null;

    // pick the dummy POI, since it isn't supposed to get freed
    for (let m: EdictT | null = ent.teammaster; m !== null; m = m.teamchain) {
      if (SpawnFlags_has(m.spawnflags, SPAWNFLAG_POI_DUMMY)) {
        level.current_dynamic_poi = m;
        break;
      }
    }

    if (level.current_dynamic_poi === null) gi.Com_Print(`can't activate poi for ${ent.classname ?? "?"}; need DUMMY in chain\n`);
  } else {
    level.current_dynamic_poi = null;
  }
});

/** g_target.cpp:1761-1776: `THINK(target_poi_setup)`. */
export const target_poi_setup: ThinkFn = RegisterThink("target_poi_setup", (self: EdictT): void => {
  if (self.team !== null) {
    // copy dynamic/nearest over to all teammates
    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_POI_NEAREST) || SpawnFlags_has(self.spawnflags, SPAWNFLAG_POI_DYNAMIC)) {
      for (let m: EdictT | null = self.teammaster; m !== null; m = m.teamchain) {
        m.spawnflags = SpawnFlags_from(m.spawnflags | (self.spawnflags & (SPAWNFLAG_POI_NEAREST | SPAWNFLAG_POI_DYNAMIC)));
      }
    }

    for (let m: EdictT | null = self.teammaster; m !== null; m = m.teamchain) {
      if (m.classname !== "target_poi") gi.Com_Print(`WARNING: ${m.classname ?? "?"} is teamed with target_poi's; unintentional\n`);
    }
  }
});

/** g_target.cpp:1778-1803: `void SP_target_poi(edict_t *self)`. */
export function SP_target_poi(self: EdictT): void {
  if (deathmatchEnabled()) {
    G_FreeEdict(self);
    return;
  }

  self.noise_index = st.image !== null ? gi.imageindex(st.image) : gi.imageindex("friend");

  self.use = target_poi_use;
  self.svflags |= SvflagsT.SVF_NOCLIENT;
  self.think = target_poi_setup;
  self.nextthink = Gtime_add(level.time, Gtime_from_ms(1));

  if (self.team === null) {
    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_POI_NEAREST)) gi.Com_Print(`${self.classname ?? "?"} has useless spawnflag 'NEAREST'\n`);
    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_POI_DYNAMIC)) gi.Com_Print(`${self.classname ?? "?"} has useless spawnflag 'DYNAMIC'\n`);
  }
}

// ---------------------------------------------------------------------------
// target_music
// ---------------------------------------------------------------------------

/** g_target.cpp:1809-1812: `USE(use_target_music)`. */
export const use_target_music: UseFn = RegisterUse("use_target_music", (self: EdictT): void => {
  gi.configstring(CS_CDTRACK, `${self.sounds}`);
});

/** g_target.cpp:1814-1817: `void SP_target_music(edict_t* self)`. */
export function SP_target_music(self: EdictT): void {
  self.use = use_target_music;
}

// ---------------------------------------------------------------------------
// target_healthbar
// ---------------------------------------------------------------------------

/** g_target.cpp:1826-1853: `USE(use_target_healthbar)`. */
export const use_target_healthbar: UseFn = RegisterUse("use_target_healthbar", (ent: EdictT): void => {
  const target = ent.target !== null ? G_PickTarget(ent.target) : null;

  if (target === null || ent.health !== target.spawn_count) {
    if (target !== null) gi.Com_Print(`${ent.classname ?? "?"}: target ${target.classname ?? "?"} changed from what it used to be\n`);
    else gi.Com_Print(`${ent.classname ?? "?"}: no target\n`);
    G_FreeEdict(ent);
    return;
  }

  for (let i = 0; i < MAX_HEALTH_BARS; i++) {
    if (level.health_bar_entities[i] !== null) continue;

    ent.enemy = target;
    level.health_bar_entities[i] = ent;
    gi.configstring(CONFIG_HEALTH_BAR_NAME_INDEX, ent.message ?? "");
    return;
  }

  gi.Com_Print(`${ent.classname ?? "?"}: too many health bars\n`);
  G_FreeEdict(ent);
});

/** g_target.cpp:1855-1869: `THINK(check_target_healthbar)`. */
export const check_target_healthbar: ThinkFn = RegisterThink("check_target_healthbar", (ent: EdictT): void => {
  const target = ent.target !== null ? G_PickTarget(ent.target) : null;
  if (target === null || (target.svflags & SvflagsT.SVF_MONSTER) === 0) {
    if (target !== null) gi.Com_Print(`${ent.classname ?? "?"}: target ${target.classname ?? "?"} does not appear to be a monster\n`);
    G_FreeEdict(ent);
    return;
  }

  // just for sanity check
  ent.health = target.spawn_count;
});

/** g_target.cpp:1871-1896: `void SP_target_healthbar(edict_t *self)`. */
export function SP_target_healthbar(self: EdictT): void {
  if (deathmatchEnabled()) {
    G_FreeEdict(self);
    return;
  }

  if (self.target === null || self.target === "") {
    gi.Com_Print(`${self.classname ?? "?"}: missing target\n`);
    G_FreeEdict(self);
    return;
  }

  if (self.message === null) {
    gi.Com_Print(`${self.classname ?? "?"}: missing message\n`);
    G_FreeEdict(self);
    return;
  }

  self.use = use_target_healthbar;
  self.think = check_target_healthbar;
  self.nextthink = Gtime_add(level.time, Gtime_from_ms(25));
}

// ---------------------------------------------------------------------------
// target_autosave
// ---------------------------------------------------------------------------

/** g_target.cpp:1903-1912: `USE(use_target_autosave)`. */
export const use_target_autosave: UseFn = RegisterUse("use_target_autosave", (): void => {
  const save_time = Gtime_from_sec(cvarFloat("g_athena_auto_save_min_time", "60", CvarFlagsT.CVAR_NOSET));

  if (Gtime_subtract(level.time, level.next_auto_save) > save_time) {
    gi.AddCommandString("autosave\n");
    level.next_auto_save = level.time;
  }
});

/** g_target.cpp:1914-1923: `void SP_target_autosave(edict_t *self)`. */
export function SP_target_autosave(self: EdictT): void {
  if (deathmatchEnabled()) {
    G_FreeEdict(self);
    return;
  }

  self.use = use_target_autosave;
}

// ---------------------------------------------------------------------------
// target_sky
// ---------------------------------------------------------------------------

/** g_target.cpp:1933-1956: `USE(use_target_sky)`. */
export const use_target_sky: UseFn = RegisterUse("use_target_sky", (self: EdictT): void => {
  if (self.map !== null) gi.configstring(CS_SKY, self.map);

  if ((self.count & 3) !== 0) {
    const parts = gi.get_configstring(CS_SKYROTATE).trim().split(/\s+/);
    let rotate = parts.length > 0 && parts[0] !== undefined ? Number(parts[0]) : 0;
    let autorotate = parts.length > 1 && parts[1] !== undefined ? Number(parts[1]) : 0;

    if ((self.count & 1) !== 0) rotate = self.accel;
    if ((self.count & 2) !== 0) autorotate = self.style;

    gi.configstring(CS_SKYROTATE, `${rotate} ${autorotate}`);
  }

  if ((self.count & 4) !== 0) gi.configstring(CS_SKYAXIS, `${self.movedir[0]} ${self.movedir[1]} ${self.movedir[2]}`);
});

/** g_target.cpp:1958-1978: `void SP_target_sky(edict_t *self)`. */
export function SP_target_sky(self: EdictT): void {
  self.use = use_target_sky;
  if (st.keys_specified.has("sky")) self.map = st.sky;
  if (st.keys_specified.has("skyaxis")) {
    self.count |= 4;
    self.movedir = vec3(st.skyaxis[0], st.skyaxis[1], st.skyaxis[2]);
  }
  if (st.keys_specified.has("skyrotate")) {
    self.count |= 1;
    self.accel = st.skyrotate;
  }
  if (st.keys_specified.has("skyautorotate")) {
    self.count |= 2;
    self.style = st.skyautorotate;
  }
}

// ---------------------------------------------------------------------------
// target_crossunit_trigger / target_crossunit_target
// (DOES have a deathmatch guard -- see the crosslevel pair above, which
// doesn't; a genuine asymmetry in the C++ source, preserved)
// ---------------------------------------------------------------------------

/** g_target.cpp:1985-1989: `USE(trigger_crossunit_trigger_use)`. */
export const trigger_crossunit_trigger_use: UseFn = RegisterUse("trigger_crossunit_trigger_use", (self: EdictT): void => {
  game.cross_unit_flags |= self.spawnflags;
  G_FreeEdict(self);
});

/** g_target.cpp:1991-2001: `void SP_target_crossunit_trigger(edict_t *self)`. */
export function SP_target_crossunit_trigger(self: EdictT): void {
  if (deathmatchEnabled()) {
    G_FreeEdict(self);
    return;
  }

  self.svflags = SvflagsT.SVF_NOCLIENT;
  self.use = trigger_crossunit_trigger_use;
}

/** g_target.cpp:2009-2016: `THINK(target_crossunit_target_think)`. */
export const target_crossunit_target_think: ThinkFn = RegisterThink("target_crossunit_target_think", (self: EdictT): void => {
  if (self.spawnflags === (game.cross_unit_flags & SFL_CROSS_TRIGGER_MASK & self.spawnflags)) {
    G_UseTargets(self, self);
    G_FreeEdict(self);
  }
});

/** g_target.cpp:2018-2032: `void SP_target_crossunit_target(edict_t *self)`. */
export function SP_target_crossunit_target(self: EdictT): void {
  if (deathmatchEnabled()) {
    G_FreeEdict(self);
    return;
  }

  if (self.delay === 0) self.delay = 1;
  self.svflags = SvflagsT.SVF_NOCLIENT;

  self.think = target_crossunit_target_think;
  self.nextthink = Gtime_add(level.time, Gtime_from_sec(self.delay));
}

// ---------------------------------------------------------------------------
// target_achievement
// ---------------------------------------------------------------------------

/** g_target.cpp:2039-2044: `USE(use_target_achievement)`. */
export const use_target_achievement: UseFn = RegisterUse("use_target_achievement", (self: EdictT): void => {
  gi.WriteByte(ServerCommandT.svc_achievement);
  gi.WriteString(self.map ?? "");
  gi.multicast(vec3_origin, KexMulticastT.MULTICAST_ALL, true);
});

/** g_target.cpp:2046-2056: `void SP_target_achievement(edict_t *self)`. */
export function SP_target_achievement(self: EdictT): void {
  if (deathmatchEnabled()) {
    G_FreeEdict(self);
    return;
  }

  self.map = st.achievement;
  self.use = use_target_achievement;
}

// ---------------------------------------------------------------------------
// target_story
// ---------------------------------------------------------------------------

/** g_target.cpp:2058-2066: `USE(use_target_story)`. */
export const use_target_story: UseFn = RegisterUse("use_target_story", (self: EdictT): void => {
  level.story_active = self.message !== null && self.message !== "";
  gi.configstring(CONFIG_STORY_INDEX, self.message ?? "");
});

/** g_target.cpp:2068-2077: `void SP_target_story(edict_t *self)`. */
export function SP_target_story(self: EdictT): void {
  if (deathmatchEnabled()) {
    G_FreeEdict(self);
    return;
  }

  self.use = use_target_story;
}
