// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_spawn.cpp (1,724 lines, 2023 Quake II re-release / "KEX" engine),
// ~/Projects/quake2-rerelease-dll/rerelease/g_spawn.cpp: the entity spawn
// registry (the flat `spawns` table, 190 entries measured -- see "REGISTRY
// COMPLETENESS" below), ED_NewString, ED_ParseField (the `entity_fields`/
// `temp_fields` tables and their type-dispatched loaders), ED_ParseEdict,
// G_FindTeams/G_FixTeams, G_InhibitEntity, SpawnEntities, G_InitStatusbar
// (g_statusbar.h's fluent builder, ported separately as g_statusbar.ts),
// and SP_worldspawn.
//
// This is the file every other kexgame content module's own header cited as
// "no src/kexgame/g_spawn.ts exists yet" -- it now does. This unit also owns
// the ONE shared `st` (spawn_temp_t) global: `export const st` below,
// mutated in place by `ClearSpawnTemp()`/ED_ParseField, replacing the four
// local, permanently-defaulted `st` placeholders g_monster.ts/g_misc.ts/
// g_trigger.ts/g_target.ts each carried (see those files' own updated
// headers for the exact rewire diff) and the two throwing stubs (`st`/
// ED_ParseField/ED_CallSpawn) g_cmds.ts carried for `Cmd_Spawn_f`.
//
// ============================================================================
// REGISTRY COMPLETENESS -- 190 entries measured, 108 real + 82 stubs
// ============================================================================
// Counted directly from the C++ `spawns` initializer_list (g_spawn.cpp:221-
// 437): `grep -c '{ "' ` over that exact range = 190 (the brief's "~194" was
// an estimate; 190 is the measured count). Every one of the 190 is present
// below in the SAME order, so the registry is complete: 108 real entries
// (107 distinct exported SP_ functions, plus "func_group" reusing
// SP_info_null a second time, exactly like the C++ table itself reuses it)
// call into already-ported modules (p_client.ts, g_func.ts, g_misc.ts,
// g_trigger.ts, g_target.ts, g_monster.ts, and g_turret.ts -- see below),
// and 82 entries whose real SP_ function lives in a file this port line has
// not ported yet (monster content `m_*.cpp`, `bots/bot_utils.cpp`, `ctf/`,
// `rogue/`, `xatrix/`) get a REGISTERED throwing stub via the local
// `unported()` factory below, each citing its real C++ owner by path -- so
// the registry is honest as well as complete.
//
// `g_turret.ts` (704 lines, all four `SP_turret_*` real) landed in this
// tree CONCURRENTLY with this unit's own work -- not part of this brief's
// original "not ported yet" list, discovered mid-task via `git status`
// (untracked file) and confirmed real by grepping its exports and running
// `bunx tsc --noEmit` clean against it. Wired up as real imports
// (`turret_breach`/`turret_base`/`turret_driver`/`turret_invisible_brain`)
// instead of stubbing them, since a real implementation existing makes a
// throwing stub for the same four entries strictly less honest, not more
// faithful. Flagged here as a genuine scope note for the coordinator: this
// file now has a real (not just type-level) dependency on `g_turret.ts`,
// landed by a different, unnamed concurrent unit.
// Three C++ classnames reuse the SAME (stub) function for two entries
// exactly as the C table does: "monster_tank"/"monster_tank_commander" both
// -> SP_monster_tank (m_tank.cpp), "monster_hover"/"monster_daedalus" both
// -> SP_monster_hover (m_hover.cpp), "monster_medic"/"monster_medic_commander"
// both -> SP_monster_medic (m_medic.cpp).
//
// UPDATE (bots/ unit): the "82 stubs" count above is now STALE -- a series
// of concurrent units (not this one) landed real content for nearly all of
// them without updating this header's own tally. Measured at the time this
// note was written (`grep -c 'spawn: unported('` over this file): exactly
// ONE remaining stub, "info_nav_lock". This unit's own brief named it "the
// last registry stub" and had this unit swap it for the real
// `SP_info_nav_lock` import from the new `src/kexgame/bots/bot_utils.ts`
// (bots/bot_utils.cpp) -- so as of this diff, the local `unported()`
// factory below has ZERO remaining call sites in the registry. Left
// defined (this unit's scope is "swap the info_nav_lock entry only," not a
// broader g_spawn.ts cleanup pass) but genuinely dead code; a future unit
// that touches this file's registry section should consider removing it.
// test/kexgame_g_spawn.test.ts's own sentinel test was repointed to assert
// this directly (zero `spawn: unported(` occurrences in this file's own
// source) instead of asserting "info_nav_lock throws."
//
// ============================================================================
// `st` (spawn_temp_t) -- now real, and TWO latent default-value bugs fixed
// ============================================================================
// g_local_types.ts already exports the real `SpawnTempT` interface (its own
// "types, constants, registry only" scope note); this file is simply the
// first one authorized to OWN a live instance of it, per this unit's brief.
// `export const st: SpawnTempT = defaultSpawnTemp();` is mutated in place
// (never reassigned) by `ClearSpawnTemp()`, matching PORTING.md's "shared
// mutable globals become exported const singletons mutated in place" rule
// and the C source's own `st = {};` re-initialization idiom (a fresh
// aggregate-initialized spawn_temp_t, which is exactly what
// `Object.assign(st, defaultSpawnTemp())` produces here: every nested
// object/array, e.g. `st.skyaxis`, `st.sl`, becomes a fresh reference too,
// matching C's own fresh nested `vec3_t`/`shadow_light_temp_t` on each
// `st = {};`).
//
// Cross-checking every one of `defaultSpawnTemp()`'s field defaults against
// the REAL g_local.h struct declarations (spawn_temp_t g_local.h:1269-1314,
// shadow_light_data_t game.h:2033-2044) turned up two defaults that the
// four existing local `st` placeholders (g_misc.ts/g_func.ts/g_target.ts/
// g_trigger.ts) all got WRONG, independently, before this file existed to
// give them a real source of truth:
//   - `skyautorotate`: g_local.h:1274 declares `int32_t skyautorotate = 1;`
//     (default 1, not 0). g_misc.ts's own placeholder used 0; g_target.ts's/
//     g_trigger.ts's used 1 (already correct, by luck or care). This file's
//     canonical default is 1, so rewiring g_misc.ts to import the shared
//     `st` silently FIXES that file's latent default-value bug as a side
//     effect -- flagged here since it's a real behavior change, not a
//     no-op refactor, even though it only manifests for a `worldspawn` that
//     never explicitly sets a `skyautorotate` key (the overwhelmingly
//     common case, since almost no real map bothers).
//   - `fade_start_dist`/`fade_end_dist`: g_local.h:1304-1305 declare
//     `int fade_start_dist = 96;` / `int fade_end_dist = 384;` (NOT 0/0).
//     `health_multiplier`: g_local.h:1306 declares `float health_multiplier
//     = 1.0f;` (NOT 0). `shadow_light_data_t::intensity`: game.h:2038
//     declares `float intensity = 1;` (NOT 0). All four existing local `st`
//     placeholders in this port line used 0 for all four of these fields --
//     the same latent bug, independently repeated four times. This file's
//     canonical defaults (96 / 384 / 1.0 / 1) are the first correct ones in
//     this port line; every rewired file inherits the fix.
//
// ============================================================================
// ED_ParseField type dispatch -- string/int/float/vec3/spawnflags/bigint
// cases; NO real gtime_t case exists in the actual field tables
// ============================================================================
// C++'s `type_loaders_t::load<T>` dispatches on `std::is_same_v<T, const
// char*>` (string), `is_integral_v` (int, using atoi), `is_same_v<T,
// spawnflags_t>` (spawnflags, atoi + wrap), `is_floating_point_v` (float,
// atof), `is_enum_v` (atoi if sizeof<=4, else atoll -- ONLY `s.effects`
// hits the atoll branch, since `EffectsT`/`effects_t` is the sole >32-bit
// enum touched by either field table; `s.renderfx` is a <=32-bit enum and
// uses plain atoi), and `is_same_v<T, vec3_t>` (three whitespace-separated
// floats via COM_Parse). This file ports each case as a small named
// helper (`ED_NewString`, `C_atoi`, `C_atof`, `C_atoll`, `parseVec3Field`,
// `SpawnFlags_from(C_atoi(...))`) instead of a generic reflection-based
// dispatcher (TS has no `decltype`-driven overload resolution without
// `any`), then wires each of the real table's 123 entries (41 temp_fields +
// 82 entity_fields, both counts hand-verified against g_spawn.cpp:801-850/
// 673-784) to the correct one by checking every field's REAL declared C++
// type in g_local.h/game.h rather than guessing from the field's semantic
// name (this caught real int-vs-float mistakes a name-based guess would
// have made -- e.g. `wait`/`delay`/`random` are `float` on edict_t
// (g_local.h:3153-3155) despite reading like they could be int-frame-counts,
// while `health`/`mass`/`dmg`/`sounds`/`count`/`style`/`hackflags` are all
// `int32_t` (g_local.h:3117/3092/3129/3132/3133/3165/3197) despite several
// of them having float siblings elsewhere in the same struct family, and
// `power_armor_power` is `int32_t` (g_local.h:1642), not float, unlike its
// neighboring `health_multiplier` float). Grepped BOTH field tables in the
// real g_spawn.cpp line-by-line for any entry binding a `gtime_t`-typed
// member: zero matches (`spawn_temp_t::pausetime` reads like a time value
// but is a plain `float`, g_local.h:1282; `monsterinfo_t::pausetime`,
// the only real `gtime_t pausetime` in the whole codebase, g_local.h:1628,
// is never bound through ED_ParseField at all). So there genuinely is no
// "gtime" case to wire up here -- the brief's mention of one doesn't match
// the real registry, and this file does not fabricate a field to manufacture
// one. test/kexgame_g_spawn.test.ts documents this gap explicitly instead
// of silently dropping the case.
//
// ============================================================================
// `_color` special case -- bypasses ED_ParseField entirely, per C++
// ============================================================================
// g_spawn.cpp:941-948: keys with a leading underscore are normally
// discarded as editor comments UNLESS the key is exactly `_color` (a
// [Sam-KEX] hack for shadow-casting-light RGBA), which instead calls
// `ent->s.skinnum = ED_LoadColor(value)` directly -- never reaching
// ED_ParseField, never touching `st.keys_specified`. Ported as the exact
// same special case inside `ED_ParseEdict` below, before the generic
// leading-underscore skip.
//
// ============================================================================
// Pointer-null vs JS falsy: `st.gravity`/`st.goals`/`st.start_items`/
// `st.nextmap` are `=== null` checks, not truthy checks
// ============================================================================
// SP_worldspawn's C++ source tests several `const char *` spawn_temp_t
// fields with a bare `if (st.field)` -- on a C pointer this means "was this
// key ever specified" (null-check only; a pointer to `""` is still
// truthy). A naive `if (st.field)` in TS on a `string | null` would ALSO
// treat an explicitly-specified-but-empty value as "unset", which is a
// real behavior difference from C. This file uses `st.field === null` /
// `!== null` for those four fields (`gravity`, `goals`, `start_items`,
// `nextmap`) to preserve the exact C semantics; fields tested with the C
// idiom `ptr && ptr[0]` (`st.sky`, `st.achievement`, `st.music`,
// `ent.message`) DO mean "non-null and non-empty", which is exactly what a
// plain JS truthy check on a `string | null` gives, so those four keep the
// simpler truthy form.
//
// ============================================================================
// pm_config -- two assignments dropped, per bg_local.ts's own established
// architecture (no hidden global)
// ============================================================================
// SP_worldspawn's C++ source writes `pm_config.n64_physics = true` and
// `pm_config.airaccel = sv_airaccelerate->integer` after the matching
// `gi.configstring()` calls. bg_local.ts's own header already documents
// that THIS port line deliberately does not carry `pm_config` as a hidden
// mutable global at all -- it is threaded as an explicit `Pmove()`
// parameter instead (p_client.ts's own "DEVIATION: pm_config" note is the
// established precedent, using `PM_CONFIG_DEFAULT` at every read site
// instead of a live global). g_spawn.ts is not a Pmove() call site, so
// there is nothing in this port line for `pm_config.n64_physics = true`/
// `pm_config.airaccel = ...` to write into without inventing a global that
// contradicts that architecture (and bg_local.ts is out of this unit's
// scope regardless). The two assignment statements are DROPPED; the
// `gi.configstring(CONFIG_N64_PHYSICS, ...)` / `gi.configstring(CS_AIRACCEL,
// ...)` calls themselves are real (configstrings are genuine client-visible
// state) and ARE ported faithfully. `game.airacceleration_modified =
// sv_airaccelerate->modified_count` has a real field to write
// (GameLocalsT.airacceleration_modified), but kexapi/game.ts's own header
// already documents that the REUSED `CvarT` (shared/q_shared.ts, per the
// porting brief) has no `modified_count: int32_t` change counter -- only a
// boolean `modified` flag, fixing that mismatch being out of scope (a
// "phase 2" job per that file's own note). This file assigns the boolean
// as 0/1 instead of a real counter value, an honest, documented narrowing
// rather than inventing a counter field on `CvarT` that doesn't exist.
//
// ============================================================================
// cached_soundindex/cached_modelindex/cached_imageindex::clear_all() --
// documented no-op (no shared registry exists in this port line)
// ============================================================================
// SpawnEntities' very first lines reset three static per-TYPE registries of
// every `cached_soundindex`/`cached_modelindex`/`cached_imageindex`
// instance in the whole C++ codebase, so a fresh level re-resolves every
// precache index instead of carrying stale ones from the previous level.
// This port line has no such shared registry -- every file that needs a
// cached index (e.g. g_trigger.ts's own `windsound = { index: 0 }`, cited
// in that file's own header) inlines its own private, ungoverned instance.
// `clearCachedIndices()` below is consequently a real, honest no-op (there
// is nothing to clear) -- documented rather than silently dropped. Every
// module-scoped cached index in this port line will incorrectly persist a
// stale value across a level change until a real shared registry exists.
// One concrete instance of this same gap: p_view.ts's own local `let
// snd_fry = 0` (p_view.ts:1213, unexported) is the read side of the exact
// `snd_fry.assign("player/fry.wav")` call this file's own SP_worldspawn
// ports below -- `gi.soundindex("player/fry.wav")` IS called here (so the
// precache table entry is genuinely created, matching real client-visible
// behavior), but there is no exported setter on p_view.ts's `snd_fry` for
// this file to write the resulting index into, so p_view.ts's lava-damage
// sound plays index 0 (silence/default) rather than the real fry sound
// until that file is revisited -- p_view.ts is out of this unit's scope.
//
// ============================================================================
// CTFSpawn/InitHintPaths/PrecacheForRandomRespawn/DMGame -- narrow real
// ports vs throwing stubs, decided the same way g_combat.ts's own
// CTFMatchSetup/DMGame precedent was
// ============================================================================
// - `CTFSpawn()` is called UNCONDITIONALLY at the end of every
//   SpawnEntities call (ctf/g_ctf.cpp:185), so per this codebase's own
//   "an unconditionally-reached cross-dep can't be a throwing stub" rule
//   (g_combat.ts's header), it is ported as real, narrow logic: it resets
//   a `ctfgame` struct this port line does not track anywhere (no CTF
//   state exists yet) and calls `CTFSetupTechSpawn()` (also unported,
//   ctf-only content); with no `ctfgame` to reset and no tech items in
//   this port line, the faithful behavior given current state is a true
//   no-op, ported as such (not a throw).
// - `InitHintPaths()` (rogue/g_rogue_newai.cpp:816) is called on EVERY
//   non-deathmatch spawn (the common single-player/coop case). WAS a local
//   partial port here (early-out only, `hint_paths_present`/hint-chain
//   bookkeeping unported) because `hint_path`'s own SP_ function used to be
//   a registered throwing stub, making the rest provably unreachable.
//   RESOLVED (2026-08-30, KEX demo playback unit): rogue/g_rogue_newai.ts
//   has since landed a real, exported `SP_hint_path` (wired into this
//   file's own registry) AND a real, exported `InitHintPaths` (the full
//   hint-chain-building body); this file's own local partial port is
//   removed in favor of a delegating import of the real one, closing the
//   gap .orch/followups.md previously flagged.
// - `PrecacheForRandomRespawn()` (rogue/g_rogue_newdm.cpp:141): WAS a
//   throwing stub (reached only when `deathmatch && g_dm_random_items`,
//   which defaults to "0"). rogue/g_rogue_newdm.ts has since landed a
//   real, exported version; swapped for a delegating import (2026-08-30
//   stale-comment sweep) -- see that function's own site below.
// - `DMGame` is a local, all-null `DmGameRt` default, exactly matching
//   g_combat.ts's own established copy (that file's header: "T_Damage's own
//   `if (deathmatch->integer && gamerules->integer)` guard keeps every
//   DMGame.* read unreachable as long as `gamerules` sits at its
//   registered default of 0"). `DMGame.PostInitSetup` is read behind the
//   identical `deathmatch && gamerules` guard here, so it is equally
//   unreachable by default. Not imported from g_combat.ts since that
//   file's own copy is unexported (matching precedent, not a new pattern).
//
// ============================================================================
// G_PrecacheStartItems -- COM_ParseEx has no ported equivalent; real when
// the cvar is at its default, best-effort otherwise
// ============================================================================
// `COM_ParseEx(&ptr, ";")` (a COM_Parse variant with a caller-supplied
// separator set instead of whitespace) has no port anywhere in
// src/shared/ (grepped; only plain `COM_Parse` exists, PORTING.md's cited
// home for it). `g_start_items` defaults to `""` (g_main.cpp:350), and the
// real function's very first line is `if (!*g_start_items->string) return;`
// -- so the common, default-config case is exercised exactly, faithfully,
// by this port's own early-out. For the non-default case (a server admin
// actually sets `g_start_items`), this file falls back to a plain
// `.split(";")` per top-level token instead of a true separator-aware
// COM_Parse; this differs from the real tokenizer only if an item spec
// itself contains a literal semicolon inside quotes, an edge case not
// worth blocking this unit on.
//
// ============================================================================
// Two-way circular imports with g_monster.ts/g_misc.ts/g_trigger.ts/
// g_target.ts -- safe, matching this codebase's own established pattern
// ============================================================================
// This file imports real SP_* functions FROM those four files (plain
// hoisted function declarations); each of those four files now imports the
// shared `st` FROM this file (a plain `const` value). This is a genuine
// two-way module cycle, but it is exactly the same shape the codebase
// already accepts elsewhere (g_monster.ts's own header cites
// g_monster.ts<->g_phys.ts, <->m_move.ts, <->g_utils.ts as identical,
// already-shipped cycles) for the identical reason: `st` is only ever READ
// inside function bodies in all four consuming files (never at module
// top-level), so by the time any of those functions actually runs (spawn
// time, long after the whole module graph has finished loading), `st` is
// fully initialized regardless of which side of the cycle happened to
// evaluate first. No `require()` needed.

import { vec3, type Vec3 } from "../shared/math";
// COM_Parse comes from ./q_std, which caps tokens at the re-release's 512
// (game.h:122) rather than vanilla's 128 -- see that file's own note.
import { type ComParseState, COM_Parse } from "./q_std";
import { YAW } from "../shared/q_shared";
import {
  MAX_CLIENTS,
  CvarFlagsT,
  RenderfxT,
  MODELINDEX_WORLD,
  SolidT,
  CS_NAME,
  CS_CDTRACK,
  CS_SKY,
  CS_SKYAXIS,
  CS_SKYROTATE,
  CS_STATUSBAR,
  CS_AIRACCEL,
  CS_MAXCLIENTS,
  CS_LIGHTS,
  CS_GENERAL,
  CS_CD_LOOP_COUNT,
  CS_GAME_STYLE,
  GameStyleT,
  ShadowLightTypeT,
  ServerFlagsT,
  type ShadowLightDataT,
} from "../kexapi/game";
import {
  type EdictT,
  type SpawnTempT,
  type DmGameRt,
  type LevelLocalsT,
  ItemIdT,
  MovetypeT,
  EntFlagsT,
  SPAWNFLAG_NOT_EASY,
  SPAWNFLAG_NOT_MEDIUM,
  SPAWNFLAG_NOT_HARD,
  SPAWNFLAG_NOT_DEATHMATCH,
  SPAWNFLAG_NOT_COOP,
  SPAWNFLAG_COOP_ONLY,
  SPAWNFLAG_EDITOR_MASK,
  SPAWNFLAG_TRAIN_MOVE_TEAMCHAIN,
} from "./g_local";
import { SpawnFlags_from, SpawnFlags_and, SpawnFlags_not, SpawnFlags_has } from "./spawnflags";
import { clamp } from "./q_std";
import { gi, g_edicts, game, globals, level, defaultEdict } from "./g_main_globals";
import { G_Spawn, G_FreeEdict } from "./g_utils";
import { GetItemByIndex, PrecacheItem, SetItemNames, FindItemByClassname, itemlist, SpawnItem } from "./g_items";
import { setup_shadow_lights } from "./g_misc";
import { StatusbarT } from "./g_statusbar";
import { G_TeamplayEnabled } from "./p_view";
import { PlayerStatT } from "./p_hud";
import { GTIME_ZERO } from "./gtime";

// real SP_* imports -- see file header "REGISTRY COMPLETENESS"
import {
  SP_info_player_start,
  SP_info_player_deathmatch,
  SP_info_player_coop,
  SP_info_player_intermission,
  SP_info_player_coop_lava,
  SaveClientData,
  InitBodyQue,
} from "./p_client";
import {
  SP_func_plat,
  SP_func_button,
  SP_func_door,
  SP_func_door_secret,
  SP_func_door_rotating,
  SP_func_rotating,
  SP_func_train,
  SP_func_water,
  SP_func_conveyor,
  SP_func_timer,
  SP_func_killbox,
  SP_func_eye,
  SP_func_spinning,
  SP_trigger_elevator,
} from "./g_func";
import {
  SP_func_areaportal,
  SP_func_clock,
  SP_func_wall,
  SP_func_object,
  SP_func_explosive,
  SP_func_animation,
  SP_target_character,
  SP_target_string,
  SP_dynamic_light,
  SP_light,
  SP_light_mine1,
  SP_light_mine2,
  SP_info_null,
  SP_info_notnull,
  SP_info_landmark,
  SP_info_world_text,
  SP_path_corner,
  SP_point_combat,
  SP_misc_explobox,
  SP_misc_banner,
  SP_misc_satellite_dish,
  SP_misc_player_mannequin,
  SP_misc_model,
  SP_misc_gib_arm,
  SP_misc_gib_leg,
  SP_misc_gib_head,
  SP_misc_deadsoldier,
  SP_misc_viper,
  SP_misc_viper_bomb,
  SP_misc_bigviper,
  SP_misc_strogg_ship,
  SP_misc_teleporter,
  SP_misc_teleporter_dest,
  SP_misc_blackhole,
  SP_misc_eastertank,
  SP_misc_easterchick,
  SP_misc_easterchick2,
  SP_misc_flare,
  SP_misc_hologram,
  SP_misc_lavaball,
  SP_monster_commander_body,
} from "./g_misc";
import {
  SP_trigger_always,
  SP_trigger_once,
  SP_trigger_multiple,
  SP_trigger_relay,
  SP_trigger_push,
  SP_trigger_hurt,
  SP_trigger_key,
  SP_trigger_counter,
  SP_trigger_gravity,
  SP_trigger_monsterjump,
  SP_trigger_flashlight,
  SP_trigger_fog,
  SP_trigger_coop_relay,
} from "./g_trigger";
import { SP_trigger_health_relay } from "./g_monster";
// g_turret.ts landed concurrently with this unit (704 lines, all four
// SP_turret_* real) -- see file header "REGISTRY COMPLETENESS" update.
import { SP_turret_breach, SP_turret_base, SP_turret_driver, SP_turret_invisible_brain } from "./g_turret";
import { SP_info_nav_lock } from "./bots/bot_utils";
import { SP_monster_berserk } from "./m_berserk";
import { SP_monster_gladb, SP_monster_gladiator } from "./m_gladiator";
import { SP_monster_gunner } from "./m_gunner";
import { SP_monster_infantry } from "./m_infantry";
import { SP_monster_soldier, SP_monster_soldier_hypergun, SP_monster_soldier_lasergun, SP_monster_soldier_light, SP_monster_soldier_ripper, SP_monster_soldier_ss } from "./m_soldier";
import { SP_monster_chick, SP_monster_chick_heat } from "./m_chick";
import { SP_monster_flipper } from "./m_flipper";
import { SP_monster_mutant } from "./m_mutant";
import { SP_monster_parasite } from "./m_parasite";
import { SP_monster_boss5, SP_monster_supertank } from "./m_supertank";
import { SP_monster_tank, SP_monster_tank_stand } from "./m_tank";
import { SP_misc_actor, SP_target_actor } from "./m_actor";
import { SP_monster_arachnid } from "./m_arachnid";
import { SP_monster_brain } from "./m_brain";
import { SP_monster_flyer, SP_monster_kamikaze } from "./m_flyer";
import { SP_monster_hover } from "./m_hover";
import { SP_monster_medic } from "./m_medic";
import { SP_monster_floater } from "./m_float";
import { SP_info_ctf_teleport_destination, SP_info_player_team1, SP_info_player_team2, SP_misc_ctf_banner, SP_misc_ctf_small_banner, SP_trigger_ctf_teleport, CTFPrecache as RealCTFPrecache } from "./ctf/g_ctf";
import { SP_object_repair, SP_rotating_light } from "./g_xatrix_func";
import { SP_misc_amb4, SP_misc_crashviper, SP_misc_nuke, SP_misc_transport, SP_misc_viper_missile } from "./g_xatrix_misc";
import { SP_target_mal_laser } from "./g_xatrix_target";
import { SP_monster_carrier } from "./m_rogue_carrier";
import { SP_monster_stalker } from "./m_rogue_stalker";
import { SP_monster_turret } from "./m_rogue_turret";
import { SP_monster_widow } from "./m_rogue_widow";
import { SP_monster_widow2 } from "./m_rogue_widow2";
import { SP_monster_fixbot } from "./m_xatrix_fixbot";
import { SP_monster_gekk } from "./m_xatrix_gekk";
import { SP_func_plat2 } from "./rogue/g_rogue_func";
import { SP_misc_nuke_core } from "./rogue/g_rogue_misc";
import { InitHintPaths, SP_hint_path } from "./rogue/g_rogue_newai";
import { SP_func_door_secret2, SP_func_force_wall } from "./rogue/g_rogue_newfnc";
import { SP_target_anger, SP_target_blacklight, SP_target_killplayers, SP_target_orb, SP_target_steam } from "./rogue/g_rogue_newtarg";
import { SP_info_teleport_destination, SP_trigger_disguise, SP_trigger_teleport } from "./rogue/g_rogue_newtrig";
import { SP_dm_dball_ball, SP_dm_dball_ball_start, SP_dm_dball_goal, SP_dm_dball_speed_change, SP_dm_dball_team1_start, SP_dm_dball_team2_start } from "./rogue/rogue_dm_ball";
import { SP_dm_tag_token } from "./rogue/rogue_dm_tag";
import { DoRandomRespawn as RealDoRandomRespawn, PrecacheForRandomRespawn as RealPrecacheForRandomRespawn } from "./rogue/g_rogue_newdm";
import { SP_monster_boss2 } from "./m_boss2";
import { SP_monster_boss3_stand } from "./m_boss3";
import { SP_monster_jorg } from "./m_boss31";
import { SP_monster_makron } from "./m_boss32";
import { SP_monster_guncmdr } from "./m_guncmdr";
import { SP_monster_guardian } from "./m_guardian";
import { SP_misc_insane } from "./m_insane";
import { SP_monster_shambler } from "./m_shambler";
import {
  SP_target_temp_entity,
  SP_target_speaker,
  SP_target_explosion,
  SP_target_changelevel,
  SP_target_secret,
  SP_target_goal,
  SP_target_splash,
  SP_target_spawner,
  SP_target_blaster,
  SP_target_crosslevel_trigger,
  SP_target_crosslevel_target,
  SP_target_crossunit_trigger,
  SP_target_crossunit_target,
  SP_target_laser,
  SP_target_help,
  SP_target_lightramp,
  SP_target_earthquake,
  SP_target_camera,
  SP_target_gravity,
  SP_target_soundfx,
  SP_target_light,
  SP_target_poi,
  SP_target_music,
  SP_target_healthbar,
  SP_target_autosave,
  SP_target_sky,
  SP_target_achievement,
  SP_target_story,
} from "./g_target";

// ---------------------------------------------------------------------------
// small per-file cvar helpers (this port line's established "tiny header-
// only wrapper, duplicated on purpose" idiom -- see p_client.ts/g_target.ts/
// g_combat.ts's own identical copies)
// ---------------------------------------------------------------------------

function cvarInt(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): number {
  const c = gi.cvar(name, def, flags);
  return c === null ? Math.trunc(Number(def)) : Math.trunc(c.value);
}

function cvarFloat(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): number {
  const c = gi.cvar(name, def, flags);
  return c === null ? Number(def) : c.value;
}

function cvarBool(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): boolean {
  return cvarFloat(name, def, flags) !== 0;
}

function cvarString(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): string {
  const c = gi.cvar(name, def, flags);
  return c === null ? def : c.string;
}

function deathmatchEnabled(): boolean {
  return cvarInt("deathmatch", "0") !== 0;
}
function coopEnabled(): boolean {
  return cvarInt("coop", "0", CvarFlagsT.CVAR_LATCH) !== 0;
}

// ---------------------------------------------------------------------------
// ED_NewString (g_spawn.cpp:525-552)
// ---------------------------------------------------------------------------
// Preserves the real, slightly odd backslash-escape behavior exactly: `\n`
// becomes a real newline; `\` followed by anything ELSE becomes a literal
// `\` and SILENTLY DISCARDS the character after it (the C loop advances `i`
// past both the backslash and the following char but only ever emits one
// output byte for the pair unless that char is `n`). E.g. the four
// characters `a\tb` (backslash-t, not an actual tab) become `a\b` -- the
// `t` is dropped, not preserved literally. Guarding `i < l - 1` (C) becomes
// `i < s.length - 1` here (C's `l = strlen(s) + 1` includes the null
// terminator the outer `for (i = 0; i < l; i++)` loop copies as its last,
// inert iteration; TS strings have no terminator to copy, so the loop
// simply runs over `s.length` real characters instead).
export function ED_NewString(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\\" && i < s.length - 1) {
      i++;
      out += s[i] === "n" ? "\n" : "\\";
      i++;
    } else {
      out += s[i];
      i++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// type_loaders_t -- see file header "ED_ParseField type dispatch"
// ---------------------------------------------------------------------------

/** atoi(s): leading-whitespace-tolerant, truncates at the first non-digit,
 *  0 on total failure. `Number.parseInt` matches this closely enough. */
function C_atoi(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

/** atof(s): same tolerance, but parses a float. */
function C_atof(s: string): number {
  const n = Number.parseFloat(s);
  return Number.isNaN(n) ? 0 : n;
}

/** atoll(s), as a bigint (only `s.effects` -- a >32-bit enum -- uses this). */
function C_atoll(s: string): bigint {
  const m = /^\s*[+-]?\d+/.exec(s);
  if (m === null) return 0n;
  try {
    return BigInt(m[0].trim());
  } catch {
    return 0n;
  }
}

/** vec3_t load: three whitespace-separated floats via COM_Parse, over a
 *  FRESH ComParseState scoped to just this field's value string (matching
 *  the C loader's own local `const char *s = value` walk). */
function parseVec3Field(value: string): Vec3 {
  const state: ComParseState = { data: value, index: 0 };
  const x = C_atof(COM_Parse(state));
  const y = C_atof(COM_Parse(state));
  const z = C_atof(COM_Parse(state));
  return vec3(x, y, z);
}

/** ED_LoadColor (g_spawn.cpp:627-658): "r g b a" (each 0-1 float or 0-255
 *  int, auto-detected by whether any component exceeds 1.0) or a single
 *  packed integer. Packs to the same `a | (b<<8) | (g<<16) | (r<<24)`
 *  int32 the C source produces. */
function ED_LoadColor(value: string): number {
  if (value.includes(" ")) {
    const state: ComParseState = { data: value, index: 0 };
    const raw: [number, number, number, number] = [0, 0, 0, 1.0];
    let isFloat = true;
    for (let i = 0; i < 4; i++) {
      const token = COM_Parse(state);
      if (token !== "") {
        const v = C_atof(token);
        raw[i] = v;
        if (v > 1.0) isFloat = false;
      }
    }
    if (isFloat) {
      for (let i = 0; i < 4; i++) raw[i] *= 255;
    }
    const r = Math.trunc(raw[0]) & 0xff;
    const g = Math.trunc(raw[1]) & 0xff;
    const b = Math.trunc(raw[2]) & 0xff;
    const a = Math.trunc(raw[3]) & 0xff;
    // SIGNED int32, exactly as the C++'s int32_t return (g_spawn.cpp:653):
    // r=255 makes the packed value negative. A previous `>>> 0` here
    // deviated to unsigned, and the kex savegame JSON then wrote values
    // like 4278849791 that real q2repro's reader (signed-int32 JSON field)
    // rejects on cross-load -- found by the live savegame cross-load unit.
    // JS bit-extraction on the negative form yields identical bytes.
    return (a | (b << 8) | (g << 16) | (r << 24)) | 0;
  }
  return C_atoi(value);
}

// ---------------------------------------------------------------------------
// st (spawn_temp_t) -- the shared global this file owns. See file header.
// ---------------------------------------------------------------------------

function defaultShadowLightData(): ShadowLightDataT {
  return {
    lighttype: ShadowLightTypeT.point,
    radius: 0,
    resolution: 0,
    intensity: 1, // game.h:2038 `float intensity = 1;` -- see file header
    fade_start: 0,
    fade_end: 0,
    lightstyle: -1,
    coneangle: 45,
    conedirection: vec3(0, 0, 0),
  };
}

function defaultSpawnTemp(): SpawnTempT {
  return {
    sky: null,
    skyrotate: 0,
    skyaxis: vec3(0, 0, 0),
    skyautorotate: 1, // g_local.h:1274 `= 1` -- see file header
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
    sl: { data: defaultShadowLightData(), lightstyletarget: null },
    music: null,
    instantitems: 0,
    radius: 0,
    hub_map: false,
    achievement: null,
    goals: null,
    image: null,
    fade_start_dist: 96, // g_local.h:1304 `= 96` -- see file header
    fade_end_dist: 384, // g_local.h:1305 `= 384` -- see file header
    start_items: null,
    no_grapple: 0,
    health_multiplier: 1.0, // g_local.h:1306 `= 1.0f` -- see file header
    reinforcements: null,
    noise_start: null,
    noise_middle: null,
    noise_end: null,
    loop_count: 0,
    keys_specified: new Set<string>(),
  };
}

/** `extern spawn_temp_t st;` -- the one, real, shared instance. Mutated in
 *  place; never reassigned (see file header). */
export const st: SpawnTempT = defaultSpawnTemp();

/** `st = {};` at the top of ED_ParseEdict / Cmd_Spawn_f. */
export function ClearSpawnTemp(): void {
  Object.assign(st, defaultSpawnTemp());
}

// ---------------------------------------------------------------------------
// entity_fields / temp_fields (g_spawn.cpp:673-784 / 801-850)
// ---------------------------------------------------------------------------

interface EntityFieldLoader {
  name: string;
  load: ((ent: EdictT, value: string) => void) | null;
}
interface TempFieldLoader {
  name: string;
  load: ((value: string) => void) | null;
}

const TEMP_FIELDS: readonly TempFieldLoader[] = [
  { name: "lip", load: (v) => (st.lip = C_atoi(v)) },
  { name: "distance", load: (v) => (st.distance = C_atoi(v)) },
  { name: "height", load: (v) => (st.height = C_atoi(v)) },
  { name: "noise", load: (v) => (st.noise = ED_NewString(v)) },
  { name: "pausetime", load: (v) => (st.pausetime = C_atof(v)) },
  { name: "item", load: (v) => (st.item = ED_NewString(v)) },
  { name: "gravity", load: (v) => (st.gravity = ED_NewString(v)) },
  { name: "sky", load: (v) => (st.sky = ED_NewString(v)) },
  { name: "skyrotate", load: (v) => (st.skyrotate = C_atof(v)) },
  { name: "skyaxis", load: (v) => (st.skyaxis = parseVec3Field(v)) },
  { name: "skyautorotate", load: (v) => (st.skyautorotate = C_atoi(v)) },
  { name: "minyaw", load: (v) => (st.minyaw = C_atof(v)) },
  { name: "maxyaw", load: (v) => (st.maxyaw = C_atof(v)) },
  { name: "minpitch", load: (v) => (st.minpitch = C_atof(v)) },
  { name: "maxpitch", load: (v) => (st.maxpitch = C_atof(v)) },
  { name: "nextmap", load: (v) => (st.nextmap = ED_NewString(v)) },
  { name: "music", load: (v) => (st.music = ED_NewString(v)) },
  { name: "instantitems", load: (v) => (st.instantitems = C_atoi(v)) },
  { name: "radius", load: (v) => (st.radius = C_atof(v)) },
  { name: "hub_map", load: (v) => (st.hub_map = C_atoi(v) !== 0) },
  { name: "achievement", load: (v) => (st.achievement = ED_NewString(v)) },
  { name: "shadowlightradius", load: (v) => (st.sl.data.radius = C_atof(v)) },
  { name: "shadowlightresolution", load: (v) => (st.sl.data.resolution = C_atoi(v)) },
  { name: "shadowlightintensity", load: (v) => (st.sl.data.intensity = C_atof(v)) },
  { name: "shadowlightstartfadedistance", load: (v) => (st.sl.data.fade_start = C_atof(v)) },
  { name: "shadowlightendfadedistance", load: (v) => (st.sl.data.fade_end = C_atof(v)) },
  { name: "shadowlightstyle", load: (v) => (st.sl.data.lightstyle = C_atoi(v)) },
  { name: "shadowlightconeangle", load: (v) => (st.sl.data.coneangle = C_atof(v)) },
  { name: "shadowlightstyletarget", load: (v) => (st.sl.lightstyletarget = ED_NewString(v)) },
  { name: "goals", load: (v) => (st.goals = ED_NewString(v)) },
  { name: "image", load: (v) => (st.image = ED_NewString(v)) },
  { name: "fade_start_dist", load: (v) => (st.fade_start_dist = C_atoi(v)) },
  { name: "fade_end_dist", load: (v) => (st.fade_end_dist = C_atoi(v)) },
  { name: "start_items", load: (v) => (st.start_items = ED_NewString(v)) },
  { name: "no_grapple", load: (v) => (st.no_grapple = C_atoi(v)) },
  { name: "health_multiplier", load: (v) => (st.health_multiplier = C_atof(v)) },
  { name: "reinforcements", load: (v) => (st.reinforcements = ED_NewString(v)) },
  { name: "noise_start", load: (v) => (st.noise_start = ED_NewString(v)) },
  { name: "noise_middle", load: (v) => (st.noise_middle = ED_NewString(v)) },
  { name: "noise_end", load: (v) => (st.noise_end = ED_NewString(v)) },
  { name: "loop_count", load: (v) => (st.loop_count = C_atoi(v)) },
];

const ENTITY_FIELDS: readonly EntityFieldLoader[] = [
  { name: "classname", load: (e, v) => (e.classname = ED_NewString(v)) },
  { name: "model", load: (e, v) => (e.model = ED_NewString(v)) },
  { name: "spawnflags", load: (e, v) => (e.spawnflags = SpawnFlags_from(C_atoi(v))) },
  { name: "speed", load: (e, v) => (e.speed = C_atof(v)) },
  { name: "accel", load: (e, v) => (e.accel = C_atof(v)) },
  { name: "decel", load: (e, v) => (e.decel = C_atof(v)) },
  { name: "target", load: (e, v) => (e.target = ED_NewString(v)) },
  { name: "targetname", load: (e, v) => (e.targetname = ED_NewString(v)) },
  { name: "pathtarget", load: (e, v) => (e.pathtarget = ED_NewString(v)) },
  { name: "deathtarget", load: (e, v) => (e.deathtarget = ED_NewString(v)) },
  { name: "healthtarget", load: (e, v) => (e.healthtarget = ED_NewString(v)) },
  { name: "itemtarget", load: (e, v) => (e.itemtarget = ED_NewString(v)) },
  { name: "killtarget", load: (e, v) => (e.killtarget = ED_NewString(v)) },
  { name: "combattarget", load: (e, v) => (e.combattarget = ED_NewString(v)) },
  { name: "message", load: (e, v) => (e.message = ED_NewString(v)) },
  { name: "team", load: (e, v) => (e.team = ED_NewString(v)) },
  { name: "wait", load: (e, v) => (e.wait = C_atof(v)) },
  { name: "delay", load: (e, v) => (e.delay = C_atof(v)) },
  { name: "random", load: (e, v) => (e.random = C_atof(v)) },
  { name: "move_origin", load: (e, v) => (e.move_origin = parseVec3Field(v)) },
  { name: "move_angles", load: (e, v) => (e.move_angles = parseVec3Field(v)) },
  { name: "style", load: (e, v) => (e.style = C_atoi(v)) },
  { name: "style_on", load: (e, v) => (e.style_on = ED_NewString(v)) },
  { name: "style_off", load: (e, v) => (e.style_off = ED_NewString(v)) },
  { name: "crosslevel_flags", load: (e, v) => (e.crosslevel_flags = C_atoi(v) >>> 0) },
  { name: "count", load: (e, v) => (e.count = C_atoi(v)) },
  { name: "health", load: (e, v) => (e.health = C_atoi(v)) },
  { name: "sounds", load: (e, v) => (e.sounds = C_atoi(v)) },
  { name: "light", load: null }, // editor-only; baked into the lightmap at compile time
  { name: "dmg", load: (e, v) => (e.dmg = C_atoi(v)) },
  { name: "mass", load: (e, v) => (e.mass = C_atoi(v)) },
  { name: "volume", load: (e, v) => (e.volume = C_atof(v)) },
  { name: "attenuation", load: (e, v) => (e.attenuation = C_atof(v)) },
  { name: "map", load: (e, v) => (e.map = ED_NewString(v)) },
  { name: "origin", load: (e, v) => (e.s.origin = parseVec3Field(v)) },
  { name: "angles", load: (e, v) => (e.s.angles = parseVec3Field(v)) },
  {
    name: "angle",
    load: (e, v) => {
      e.s.angles = vec3(0, 0, 0);
      e.s.angles[YAW] = C_atof(v);
    },
  },
  { name: "rgba", load: (e, v) => (e.s.skinnum = ED_LoadColor(v)) },
  { name: "hackflags", load: (e, v) => (e.hackflags = C_atoi(v)) },
  { name: "alpha", load: (e, v) => (e.s.alpha = C_atof(v)) },
  { name: "scale", load: (e, v) => (e.s.scale = C_atof(v)) },
  { name: "mangle", load: null }, // editor field
  { name: "dead_frame", load: (e, v) => (e.monsterinfo.start_frame = C_atoi(v)) },
  { name: "frame", load: (e, v) => (e.s.frame = C_atoi(v)) },
  { name: "effects", load: (e, v) => (e.s.effects = C_atoll(v)) },
  { name: "renderfx", load: (e, v) => (e.s.renderfx = C_atoi(v)) },
  { name: "fog_color", load: (e, v) => (e.fog.color = parseVec3Field(v)) },
  { name: "fog_color_off", load: (e, v) => (e.fog.color_off = parseVec3Field(v)) },
  { name: "fog_density", load: (e, v) => (e.fog.density = C_atof(v)) },
  { name: "fog_density_off", load: (e, v) => (e.fog.density_off = C_atof(v)) },
  { name: "fog_sky_factor", load: (e, v) => (e.fog.sky_factor = C_atof(v)) },
  { name: "fog_sky_factor_off", load: (e, v) => (e.fog.sky_factor_off = C_atof(v)) },
  { name: "heightfog_falloff", load: (e, v) => (e.heightfog.falloff = C_atof(v)) },
  { name: "heightfog_density", load: (e, v) => (e.heightfog.density = C_atof(v)) },
  { name: "heightfog_start_color", load: (e, v) => (e.heightfog.start_color = parseVec3Field(v)) },
  { name: "heightfog_start_dist", load: (e, v) => (e.heightfog.start_dist = C_atof(v)) },
  { name: "heightfog_end_color", load: (e, v) => (e.heightfog.end_color = parseVec3Field(v)) },
  { name: "heightfog_end_dist", load: (e, v) => (e.heightfog.end_dist = C_atof(v)) },
  { name: "heightfog_falloff_off", load: (e, v) => (e.heightfog.falloff_off = C_atof(v)) },
  { name: "heightfog_density_off", load: (e, v) => (e.heightfog.density_off = C_atof(v)) },
  { name: "heightfog_start_color_off", load: (e, v) => (e.heightfog.start_color_off = parseVec3Field(v)) },
  { name: "heightfog_start_dist_off", load: (e, v) => (e.heightfog.start_dist_off = C_atof(v)) },
  { name: "heightfog_end_color_off", load: (e, v) => (e.heightfog.end_color_off = parseVec3Field(v)) },
  { name: "heightfog_end_dist_off", load: (e, v) => (e.heightfog.end_dist_off = C_atof(v)) },
  { name: "eye_position", load: (e, v) => (e.move_origin = parseVec3Field(v)) },
  { name: "vision_cone", load: (e, v) => (e.yaw_speed = C_atof(v)) },
  { name: "message2", load: (e, v) => (e.map = ED_NewString(v)) },
  { name: "mins", load: (e, v) => (e.mins = parseVec3Field(v)) },
  { name: "maxs", load: (e, v) => (e.maxs = parseVec3Field(v)) },
  {
    name: "bmodel_anim_start",
    load: (e, v) => {
      e.bmodel_anim.enabled = true;
      e.bmodel_anim.start = C_atoi(v);
    },
  },
  {
    name: "bmodel_anim_end",
    load: (e, v) => {
      e.bmodel_anim.enabled = true;
      e.bmodel_anim.end = C_atoi(v);
    },
  },
  { name: "bmodel_anim_style", load: (e, v) => (e.bmodel_anim.style = C_atoi(v)) },
  { name: "bmodel_anim_speed", load: (e, v) => (e.bmodel_anim.speed = C_atoi(v)) },
  { name: "bmodel_anim_nowrap", load: (e, v) => (e.bmodel_anim.nowrap = C_atoi(v) !== 0) },
  { name: "bmodel_anim_alt_start", load: (e, v) => (e.bmodel_anim.alt_start = C_atoi(v)) },
  { name: "bmodel_anim_alt_end", load: (e, v) => (e.bmodel_anim.alt_end = C_atoi(v)) },
  { name: "bmodel_anim_alt_style", load: (e, v) => (e.bmodel_anim.alt_style = C_atoi(v)) },
  { name: "bmodel_anim_alt_speed", load: (e, v) => (e.bmodel_anim.alt_speed = C_atoi(v)) },
  { name: "bmodel_anim_alt_nowrap", load: (e, v) => (e.bmodel_anim.alt_nowrap = C_atoi(v) !== 0) },
  { name: "power_armor_power", load: (e, v) => (e.monsterinfo.power_armor_power = C_atoi(v)) },
  {
    name: "power_armor_type",
    load: (e, v) => {
      const type = C_atoi(v);
      if (type === 0) e.monsterinfo.power_armor_type = ItemIdT.IT_NULL;
      else if (type === 1) e.monsterinfo.power_armor_type = ItemIdT.IT_ITEM_POWER_SCREEN;
      else e.monsterinfo.power_armor_type = ItemIdT.IT_ITEM_POWER_SHIELD;
    },
  },
  { name: "monster_slots", load: (e, v) => (e.monsterinfo.monster_slots = C_atoi(v)) },
];

// case-insensitive lookup, matching C's `Q_strcasecmp`
function findTempField(key: string): TempFieldLoader | null {
  const lower = key.toLowerCase();
  for (const f of TEMP_FIELDS) if (f.name.toLowerCase() === lower) return f;
  return null;
}
function findEntityField(key: string): EntityFieldLoader | null {
  const lower = key.toLowerCase();
  for (const f of ENTITY_FIELDS) if (f.name.toLowerCase() === lower) return f;
  return null;
}

/*
===============
ED_ParseField

Takes a key/value pair and sets the binary values in an edict.
===============
*/
export function ED_ParseField(key: string, value: string, ent: EdictT): void {
  const tempField = findTempField(key);
  if (tempField !== null) {
    st.keys_specified.add(tempField.name);
    if (tempField.load !== null) tempField.load(value);
    return;
  }

  const entityField = findEntityField(key);
  if (entityField !== null) {
    st.keys_specified.add(entityField.name);
    if (entityField.load !== null) entityField.load(ent, value);
    return;
  }

  gi.Com_Print(`${key} is not a valid field\n`);
}

// ---------------------------------------------------------------------------
// ED_ParseEdict (g_spawn.cpp:908-957)
// ---------------------------------------------------------------------------
// Mutates `state.index` in place and returns void, matching this codebase's
// own established `ComParseState` idiom (src/game/g_spawn.ts's identical
// signature) rather than C's `const char *` return-the-remaining-pointer
// style.

function firstChar(token: string): string {
  return token.length > 0 ? token[0]! : "";
}

/** COM_Parse signals EOF by returning "" without having just closed a
 *  quoted empty string -- same check src/game/g_spawn.ts already
 *  established for the identical `ComParseState`-based COM_Parse. */
function comParseEOF(state: ComParseState, startIndex: number, token: string): boolean {
  const closedEmptyQuote = state.index > startIndex && state.data.charAt(state.index - 1) === '"';
  return token === "" && !closedEmptyQuote;
}

export function ED_ParseEdict(state: ComParseState, ent: EdictT): void {
  let init = false;
  ClearSpawnTemp();

  for (;;) {
    // parse key
    const keyStart = state.index;
    const keyname = COM_Parse(state);
    if (firstChar(keyname) === "}") break;
    if (comParseEOF(state, keyStart, keyname)) {
      gi.Com_Error("ED_ParseEntity: EOF without closing brace");
    }

    // parse value
    const valStart = state.index;
    const value = COM_Parse(state);
    if (comParseEOF(state, valStart, value)) {
      gi.Com_Error("ED_ParseEntity: EOF without closing brace");
    }
    if (firstChar(value) === "}") {
      gi.Com_Error("ED_ParseEntity: closing brace without data");
    }

    init = true;

    // keynames with a leading underscore are utility comments, discarded --
    // EXCEPT "_color" (see file header)
    if (firstChar(keyname) === "_") {
      if (keyname === "_color") ent.s.skinnum = ED_LoadColor(value);
      continue;
    }

    ED_ParseField(keyname, value, ent);
  }

  if (!init) Object.assign(ent, defaultEdictReset());
}

/** Mirrors `memset(ent, 0, sizeof(*ent))` for the "empty entity block"
 *  case, without importing g_main_globals.ts's own unexported
 *  `defaultEdict()` factory (out of this unit's scope to change) -- this
 *  only needs to clear the ONE field anything downstream in this file
 *  actually reads afterward (`classname`, checked by ED_CallSpawn), so it
 *  stays narrow rather than duplicating that whole factory here. */
function defaultEdictReset(): Partial<EdictT> {
  return { classname: null };
}

// ---------------------------------------------------------------------------
// the spawn registry (g_spawn.cpp:221-437) -- see file header "REGISTRY
// COMPLETENESS"
// ---------------------------------------------------------------------------

interface SpawnEntry {
  name: string;
  spawn: (ent: EdictT) => void;
}

/** Registered throwing stub factory -- see file header. */
function unported(spName: string, citation: string): (ent: EdictT) => void {
  return (ent: EdictT): void => {
    throw new Error(`${spName}: not yet ported -- see ${citation} -- classname "${ent.classname ?? "?"}"`);
  };
}

/** g_items.ts used to carry an identically-named, identically-cited local
 *  throwing stub for the same reason (DoRandomRespawn's real body lives in
 *  the ROGUE mission pack, rogue/g_rogue_newdm.cpp:126) -- that copy has
 *  since been swapped for a real import from rogue/g_rogue_newdm.ts (see
 *  g_items.ts's own "STUB SWAP" header note), but this file's separate
 *  copy was not swapped at the same time. Fixed here too (2026-08-30
 *  stale-comment sweep): real delegating import, same real function both
 *  files now call. Reached only when `g_dm_random_items` is set (default
 *  off, g_main.cpp:243). */
function DoRandomRespawn(ent: EdictT): ItemIdT {
  return RealDoRandomRespawn(ent);
}


export const spawns: readonly SpawnEntry[] = [
  { name: "info_player_start", spawn: SP_info_player_start },
  { name: "info_player_deathmatch", spawn: SP_info_player_deathmatch },
  { name: "info_player_coop", spawn: SP_info_player_coop },
  { name: "info_player_intermission", spawn: SP_info_player_intermission },

  { name: "func_plat", spawn: SP_func_plat },
  { name: "func_button", spawn: SP_func_button },
  { name: "func_door", spawn: SP_func_door },
  { name: "func_door_secret", spawn: SP_func_door_secret },
  { name: "func_door_rotating", spawn: SP_func_door_rotating },
  { name: "func_rotating", spawn: SP_func_rotating },
  { name: "func_train", spawn: SP_func_train },
  { name: "func_water", spawn: SP_func_water },
  { name: "func_conveyor", spawn: SP_func_conveyor },
  { name: "func_areaportal", spawn: SP_func_areaportal },
  { name: "func_clock", spawn: SP_func_clock },
  { name: "func_wall", spawn: SP_func_wall },
  { name: "func_object", spawn: SP_func_object },
  { name: "func_timer", spawn: SP_func_timer },
  { name: "func_explosive", spawn: SP_func_explosive },
  { name: "func_killbox", spawn: SP_func_killbox },
  { name: "func_eye", spawn: SP_func_eye },
  { name: "func_animation", spawn: SP_func_animation },
  { name: "func_spinning", spawn: SP_func_spinning },

  { name: "trigger_always", spawn: SP_trigger_always },
  { name: "trigger_once", spawn: SP_trigger_once },
  { name: "trigger_multiple", spawn: SP_trigger_multiple },
  { name: "trigger_relay", spawn: SP_trigger_relay },
  { name: "trigger_push", spawn: SP_trigger_push },
  { name: "trigger_hurt", spawn: SP_trigger_hurt },
  { name: "trigger_key", spawn: SP_trigger_key },
  { name: "trigger_counter", spawn: SP_trigger_counter },
  { name: "trigger_elevator", spawn: SP_trigger_elevator },
  { name: "trigger_gravity", spawn: SP_trigger_gravity },
  { name: "trigger_monsterjump", spawn: SP_trigger_monsterjump },
  { name: "trigger_flashlight", spawn: SP_trigger_flashlight },
  { name: "trigger_fog", spawn: SP_trigger_fog },
  { name: "trigger_coop_relay", spawn: SP_trigger_coop_relay },
  { name: "trigger_health_relay", spawn: SP_trigger_health_relay },

  { name: "target_temp_entity", spawn: SP_target_temp_entity },
  { name: "target_speaker", spawn: SP_target_speaker },
  { name: "target_explosion", spawn: SP_target_explosion },
  { name: "target_changelevel", spawn: SP_target_changelevel },
  { name: "target_secret", spawn: SP_target_secret },
  { name: "target_goal", spawn: SP_target_goal },
  { name: "target_splash", spawn: SP_target_splash },
  { name: "target_spawner", spawn: SP_target_spawner },
  { name: "target_blaster", spawn: SP_target_blaster },
  { name: "target_crosslevel_trigger", spawn: SP_target_crosslevel_trigger },
  { name: "target_crosslevel_target", spawn: SP_target_crosslevel_target },
  { name: "target_crossunit_trigger", spawn: SP_target_crossunit_trigger },
  { name: "target_crossunit_target", spawn: SP_target_crossunit_target },
  { name: "target_laser", spawn: SP_target_laser },
  { name: "target_help", spawn: SP_target_help },
  { name: "target_actor", spawn: SP_target_actor },
  { name: "target_lightramp", spawn: SP_target_lightramp },
  { name: "target_earthquake", spawn: SP_target_earthquake },
  { name: "target_character", spawn: SP_target_character },
  { name: "target_string", spawn: SP_target_string },
  { name: "target_camera", spawn: SP_target_camera },
  { name: "target_gravity", spawn: SP_target_gravity },
  { name: "target_soundfx", spawn: SP_target_soundfx },
  { name: "target_light", spawn: SP_target_light },
  { name: "target_poi", spawn: SP_target_poi },
  { name: "target_music", spawn: SP_target_music },
  { name: "target_healthbar", spawn: SP_target_healthbar },
  { name: "target_autosave", spawn: SP_target_autosave },
  { name: "target_sky", spawn: SP_target_sky },
  { name: "target_achievement", spawn: SP_target_achievement },
  { name: "target_story", spawn: SP_target_story },

  { name: "worldspawn", spawn: (ent) => SP_worldspawn(ent) },

  { name: "dynamic_light", spawn: SP_dynamic_light },
  { name: "light", spawn: SP_light },
  { name: "light_mine1", spawn: SP_light_mine1 },
  { name: "light_mine2", spawn: SP_light_mine2 },
  { name: "info_null", spawn: SP_info_null },
  { name: "func_group", spawn: SP_info_null },
  { name: "info_notnull", spawn: SP_info_notnull },
  { name: "info_landmark", spawn: SP_info_landmark },
  { name: "info_world_text", spawn: SP_info_world_text },
  { name: "path_corner", spawn: SP_path_corner },
  { name: "point_combat", spawn: SP_point_combat },
  { name: "info_nav_lock", spawn: SP_info_nav_lock },

  { name: "misc_explobox", spawn: SP_misc_explobox },
  { name: "misc_banner", spawn: SP_misc_banner },
  { name: "misc_satellite_dish", spawn: SP_misc_satellite_dish },
  { name: "misc_actor", spawn: SP_misc_actor },
  { name: "misc_player_mannequin", spawn: SP_misc_player_mannequin },
  { name: "misc_model", spawn: SP_misc_model },
  { name: "misc_gib_arm", spawn: SP_misc_gib_arm },
  { name: "misc_gib_leg", spawn: SP_misc_gib_leg },
  { name: "misc_gib_head", spawn: SP_misc_gib_head },
  { name: "misc_insane", spawn: SP_misc_insane },
  { name: "misc_deadsoldier", spawn: SP_misc_deadsoldier },
  { name: "misc_viper", spawn: SP_misc_viper },
  { name: "misc_viper_bomb", spawn: SP_misc_viper_bomb },
  { name: "misc_bigviper", spawn: SP_misc_bigviper },
  { name: "misc_strogg_ship", spawn: SP_misc_strogg_ship },
  { name: "misc_teleporter", spawn: SP_misc_teleporter },
  { name: "misc_teleporter_dest", spawn: SP_misc_teleporter_dest },
  { name: "misc_blackhole", spawn: SP_misc_blackhole },
  { name: "misc_eastertank", spawn: SP_misc_eastertank },
  { name: "misc_easterchick", spawn: SP_misc_easterchick },
  { name: "misc_easterchick2", spawn: SP_misc_easterchick2 },
  { name: "misc_flare", spawn: SP_misc_flare },
  { name: "misc_hologram", spawn: SP_misc_hologram },
  { name: "misc_lavaball", spawn: SP_misc_lavaball },

  { name: "monster_berserk", spawn: SP_monster_berserk },
  { name: "monster_gladiator", spawn: SP_monster_gladiator },
  { name: "monster_gunner", spawn: SP_monster_gunner },
  { name: "monster_infantry", spawn: SP_monster_infantry },
  { name: "monster_soldier_light", spawn: SP_monster_soldier_light },
  { name: "monster_soldier", spawn: SP_monster_soldier },
  { name: "monster_soldier_ss", spawn: SP_monster_soldier_ss },
  { name: "monster_tank", spawn: SP_monster_tank },
  { name: "monster_tank_commander", spawn: SP_monster_tank },
  { name: "monster_medic", spawn: SP_monster_medic },
  { name: "monster_flipper", spawn: SP_monster_flipper },
  { name: "monster_chick", spawn: SP_monster_chick },
  { name: "monster_parasite", spawn: SP_monster_parasite },
  { name: "monster_flyer", spawn: SP_monster_flyer },
  { name: "monster_brain", spawn: SP_monster_brain },
  { name: "monster_floater", spawn: SP_monster_floater },
  { name: "monster_hover", spawn: SP_monster_hover },
  { name: "monster_mutant", spawn: SP_monster_mutant },
  { name: "monster_supertank", spawn: SP_monster_supertank },
  { name: "monster_boss2", spawn: SP_monster_boss2 },
  { name: "monster_boss3_stand", spawn: SP_monster_boss3_stand },
  { name: "monster_jorg", spawn: SP_monster_jorg },
  { name: "monster_makron", spawn: SP_monster_makron },
  { name: "monster_tank_stand", spawn: SP_monster_tank_stand },
  { name: "monster_guardian", spawn: SP_monster_guardian },
  { name: "monster_arachnid", spawn: SP_monster_arachnid },
  { name: "monster_guncmdr", spawn: SP_monster_guncmdr },

  { name: "monster_commander_body", spawn: SP_monster_commander_body },

  { name: "turret_breach", spawn: SP_turret_breach },
  { name: "turret_base", spawn: SP_turret_base },
  { name: "turret_driver", spawn: SP_turret_driver },

  { name: "func_object_repair", spawn: SP_object_repair },
  { name: "rotating_light", spawn: SP_rotating_light },
  { name: "target_mal_laser", spawn: SP_target_mal_laser },
  { name: "misc_crashviper", spawn: SP_misc_crashviper },
  { name: "misc_viper_missile", spawn: SP_misc_viper_missile },
  { name: "misc_amb4", spawn: SP_misc_amb4 },
  { name: "misc_transport", spawn: SP_misc_transport },
  { name: "misc_nuke", spawn: SP_misc_nuke },
  { name: "monster_soldier_hypergun", spawn: SP_monster_soldier_hypergun },
  { name: "monster_soldier_lasergun", spawn: SP_monster_soldier_lasergun },
  { name: "monster_soldier_ripper", spawn: SP_monster_soldier_ripper },
  { name: "monster_fixbot", spawn: SP_monster_fixbot },
  { name: "monster_gekk", spawn: SP_monster_gekk },
  { name: "monster_chick_heat", spawn: SP_monster_chick_heat },
  { name: "monster_gladb", spawn: SP_monster_gladb },
  { name: "monster_boss5", spawn: SP_monster_boss5 },

  { name: "func_plat2", spawn: SP_func_plat2 },
  { name: "func_door_secret2", spawn: SP_func_door_secret2 },
  { name: "func_force_wall", spawn: SP_func_force_wall },
  { name: "trigger_teleport", spawn: SP_trigger_teleport },
  { name: "trigger_disguise", spawn: SP_trigger_disguise },
  { name: "info_teleport_destination", spawn: SP_info_teleport_destination },
  { name: "info_player_coop_lava", spawn: SP_info_player_coop_lava },
  { name: "monster_stalker", spawn: SP_monster_stalker },
  { name: "monster_turret", spawn: SP_monster_turret },
  { name: "target_steam", spawn: SP_target_steam },
  { name: "target_anger", spawn: SP_target_anger },
  { name: "target_killplayers", spawn: SP_target_killplayers },
  { name: "target_blacklight", spawn: SP_target_blacklight },
  { name: "target_orb", spawn: SP_target_orb },
  { name: "monster_daedalus", spawn: SP_monster_hover },
  { name: "hint_path", spawn: SP_hint_path },
  { name: "monster_carrier", spawn: SP_monster_carrier },
  { name: "monster_widow", spawn: SP_monster_widow },
  { name: "monster_widow2", spawn: SP_monster_widow2 },
  { name: "monster_medic_commander", spawn: SP_monster_medic },
  { name: "dm_tag_token", spawn: SP_dm_tag_token },
  { name: "dm_dball_goal", spawn: SP_dm_dball_goal },
  { name: "dm_dball_ball", spawn: SP_dm_dball_ball },
  { name: "dm_dball_team1_start", spawn: SP_dm_dball_team1_start },
  { name: "dm_dball_team2_start", spawn: SP_dm_dball_team2_start },
  { name: "dm_dball_ball_start", spawn: SP_dm_dball_ball_start },
  { name: "dm_dball_speed_change", spawn: SP_dm_dball_speed_change },
  { name: "monster_kamikaze", spawn: SP_monster_kamikaze },
  { name: "turret_invisible_brain", spawn: SP_turret_invisible_brain },
  { name: "misc_nuke_core", spawn: SP_misc_nuke_core },

  { name: "trigger_ctf_teleport", spawn: SP_trigger_ctf_teleport },
  { name: "info_ctf_teleport_destination", spawn: SP_info_ctf_teleport_destination },
  { name: "misc_ctf_banner", spawn: SP_misc_ctf_banner },
  { name: "misc_ctf_small_banner", spawn: SP_misc_ctf_small_banner },
  { name: "info_player_team1", spawn: SP_info_player_team1 },
  { name: "info_player_team2", spawn: SP_info_player_team2 },

  { name: "monster_shambler", spawn: SP_monster_shambler },
];

/*
===============
ED_CallSpawn (g_spawn.cpp:447-518)

Finds the spawn function for the entity and calls it.
===============
*/
export function ED_CallSpawn(ent: EdictT): void {
  if (ent.classname === null) {
    gi.Com_Print("ED_CallSpawn: nullptr classname\n");
    G_FreeEdict(ent);
    return;
  }

  // PGM - do this before calling the spawn function so it can be overridden.
  ent.gravityVector[0] = 0.0;
  ent.gravityVector[1] = 0.0;
  ent.gravityVector[2] = -1.0;
  // PGM

  ent.sv.init = false;

  // FIXME - PMM classnames hack
  if (ent.classname === "weapon_nailgun") {
    const item = GetItemByIndex(ItemIdT.IT_WEAPON_ETF_RIFLE);
    if (item !== null) ent.classname = item.classname;
  }
  if (ent.classname === "ammo_nails") {
    const item = GetItemByIndex(ItemIdT.IT_AMMO_FLECHETTES);
    if (item !== null) ent.classname = item.classname;
  }
  if (ent.classname === "weapon_heatbeam") {
    const item = GetItemByIndex(ItemIdT.IT_WEAPON_PLASMABEAM);
    if (item !== null) ent.classname = item.classname;
  }
  // pmm

  // check item spawn functions
  for (const item of itemlist) {
    if (item.classname === null) continue;
    if (item.classname === ent.classname) {
      // found it -- before spawning, pick random item replacement
      if (cvarBool("g_dm_random_items", "0")) {
        ent.item = item;
        const newItemId = DoRandomRespawn(ent);
        if (newItemId !== ItemIdT.IT_NULL) {
          const newItem = GetItemByIndex(newItemId);
          if (newItem !== null) ent.classname = newItem.classname;
        }
      }
      SpawnItem(ent, item);
      return;
    }
  }

  // check normal spawn functions
  for (const s of spawns) {
    if (s.name === ent.classname) {
      // found it
      s.spawn(ent);
      // Paril: swap classname with stored constant if we didn't change it
      if (ent.classname === s.name) ent.classname = s.name;
      return;
    }
  }

  gi.Com_Print(`${ent.classname} doesn't have a spawn function\n`);
  G_FreeEdict(ent);
}

// ---------------------------------------------------------------------------
// G_FixTeams / G_FindTeams (g_spawn.cpp:972-1067)
// ---------------------------------------------------------------------------

const FL_TEAMSLAVE: EntFlagsT = EntFlagsT.FL_TEAMSLAVE;
const FL_TEAMMASTER: EntFlagsT = EntFlagsT.FL_TEAMMASTER;

function hasFlag(flags: EntFlagsT, bit: EntFlagsT): boolean {
  return (flags & bit) !== 0n;
}

/** adjusts teams so that trains that move their children are in the front
 *  of the team. */
export function G_FixTeams(): void {
  let c = 0;
  for (let i = 1; i < globals.num_edicts; i++) {
    const e = g_edicts[i];
    if (e === undefined || !e.inuse || e.team === null) continue;
    if (e.classname !== "func_train" || !SpawnFlags_has(e.spawnflags, SPAWNFLAG_TRAIN_MOVE_TEAMCHAIN)) continue;
    if (!hasFlag(e.flags, FL_TEAMSLAVE)) continue;

    let chain: EdictT = e;
    e.teammaster = e;
    e.teamchain = null;
    e.flags = (e.flags & ~FL_TEAMSLAVE) | FL_TEAMMASTER;
    c++;
    for (let j = 1; j < globals.num_edicts; j++) {
      const e2 = g_edicts[j];
      if (e2 === undefined || e2 === e || !e2.inuse || e2.team === null) continue;
      if (e.team !== e2.team) continue;
      chain.teamchain = e2;
      e2.teammaster = e;
      e2.teamchain = null;
      chain = e2;
      e2.flags = (e2.flags | FL_TEAMSLAVE) & ~FL_TEAMMASTER;
      e2.movetype = e.movetype; // MOVETYPE_PUSH, same value e already has
      e2.speed = e.speed;
    }
  }

  gi.Com_Print(`${c} teams repaired\n`);
}

/** Chain together all entities with a matching team field. All but the
 *  first get FL_TEAMSLAVE; all but the last get `teamchain` pointing to
 *  the next one. */
export function G_FindTeams(): void {
  let c = 0;
  let c2 = 0;
  for (let i = 1; i < globals.num_edicts; i++) {
    const e = g_edicts[i];
    if (e === undefined || !e.inuse || e.team === null) continue;
    if (hasFlag(e.flags, FL_TEAMSLAVE)) continue;

    let chain: EdictT = e;
    e.teammaster = e;
    e.flags = e.flags | FL_TEAMMASTER;
    c++;
    c2++;
    for (let j = i + 1; j < globals.num_edicts; j++) {
      const e2 = g_edicts[j];
      if (e2 === undefined || !e2.inuse || e2.team === null) continue;
      if (hasFlag(e2.flags, FL_TEAMSLAVE)) continue;
      if (e.team !== e2.team) continue;
      c2++;
      chain.teamchain = e2;
      e2.teammaster = e;
      chain = e2;
      e2.flags = e2.flags | FL_TEAMSLAVE;
    }
  }

  // ROGUE
  G_FixTeams();
  // ROGUE

  gi.Com_Print(`${c} teams with ${c2} entities\n`);
}

// ---------------------------------------------------------------------------
// G_InhibitEntity (g_spawn.cpp:1070-1086)
// ---------------------------------------------------------------------------

function G_InhibitEntity(ent: EdictT): boolean {
  const spawnflags = ent.spawnflags;

  if (deathmatchEnabled()) {
    return SpawnFlags_has(spawnflags, SPAWNFLAG_NOT_DEATHMATCH);
  }

  if (coopEnabled() && SpawnFlags_has(spawnflags, SPAWNFLAG_NOT_COOP)) return true;
  if (!coopEnabled() && SpawnFlags_has(spawnflags, SPAWNFLAG_COOP_ONLY)) return true;

  const skill = cvarInt("skill", "1");
  return (
    (skill === 0 && SpawnFlags_has(spawnflags, SPAWNFLAG_NOT_EASY)) ||
    (skill === 1 && SpawnFlags_has(spawnflags, SPAWNFLAG_NOT_MEDIUM)) ||
    (skill >= 2 && SpawnFlags_has(spawnflags, SPAWNFLAG_NOT_HARD))
  );
}

// ---------------------------------------------------------------------------
// G_PrecacheInventoryItems / G_PrecacheStartItems (g_spawn.cpp:1091-1135)
// ---------------------------------------------------------------------------

function G_PrecacheInventoryItems(): void {
  if (deathmatchEnabled()) return;

  for (let i = 0; i < game.maxclients; i++) {
    const ent = g_edicts[i + 1];
    const cl = ent?.client ?? null;
    if (cl === null) continue;

    for (let id = ItemIdT.IT_NULL; id !== ItemIdT.IT_TOTAL; id++) {
      if (cl.pers.inventory[id] !== 0) PrecacheItem(GetItemByIndex(id));
    }
  }
}

/** COM_ParseEx has no ported equivalent -- see file header. */
function G_PrecacheStartItems(): void {
  const raw = cvarString("g_start_items", "", CvarFlagsT.CVAR_LATCH);
  if (raw === "") return;

  for (const rawToken of raw.split(";")) {
    const token = rawToken.trim();
    if (token === "") continue;
    const state: ComParseState = { data: token, index: 0 };
    const itemName = COM_Parse(state);
    if (itemName === "") continue;
    const item = FindItemByClassname(itemName);
    if (item === null || item.pickup === null) {
      gi.Com_Error(`Invalid g_start_item entry: ${itemName}\n`);
    } else {
      PrecacheItem(item);
    }
  }
}

// ---------------------------------------------------------------------------
// CTFSpawn / InitHintPaths / PrecacheForRandomRespawn / DMGame -- see file
// header
// ---------------------------------------------------------------------------

function CTFSpawn(): void {
  // no `ctfgame` state and no CTF tech items exist anywhere in this port
  // line -- see file header.
}

// InitHintPaths: formerly a local partial port here (an early-out-only
// stub that never built the hint-chain bookkeeping) -- rogue/g_rogue_newai.ts
// has since landed a real, exported `InitHintPaths` (rogue/g_rogue_newai.cpp:
// 814-855: sets `hint_paths_present` and walks every hint_path entity
// building `hint_path_start`/chain-link bookkeeping); swapped for a
// delegating import (2026-08-30 KEX demo playback unit, closing the gap
// .orch/followups.md flagged). `SP_hint_path` (imported above) already
// wires a real spawn function into this file's own `spawns` registry, so a
// map CAN spawn `hint_path` entities and reach this real function's
// hint-chain-building branch, not just the early-out.

// PrecacheForRandomRespawn: formerly a local throwing stub here --
// rogue/g_rogue_newdm.ts has since landed with a real, exported version;
// swapped for a delegating import (2026-08-30 stale-comment sweep). Reached
// only when `g_dm_random_items` is set (default off).
function PrecacheForRandomRespawn(): void {
  RealPrecacheForRandomRespawn();
}

/** g_local.h:3275 `extern dm_game_rt DMGame;` -- see file header. */
const DMGame: DmGameRt = {
  GameInit: null,
  PostInitSetup: null,
  ClientBegin: null,
  SelectSpawnPoint: null,
  PlayerDeath: null,
  Score: null,
  PlayerEffects: null,
  DogTag: null,
  PlayerDisconnect: null,
  ChangeDamage: null,
  ChangeKnockback: null,
  CheckDMRules: null,
};

// ---------------------------------------------------------------------------
// SpawnEntities (g_spawn.cpp:1145-1275)
// ---------------------------------------------------------------------------

function clearCachedIndices(): void {
  // cached_soundindex/cached_modelindex/cached_imageindex::clear_all() --
  // documented no-op, see file header.
}

/** LevelLocalsT's real default factory (g_main_globals.ts's own
 *  `defaultLevelLocals()`) is not exported -- this duplicates its shape
 *  locally, matching the same "local duplicate default object" idiom this
 *  port line already uses for `st` itself (g_misc.ts/g_target.ts/
 *  g_trigger.ts's own pre-rewire placeholders). Field-for-field identical
 *  to g_main_globals.ts:639-718 at the time of writing. */
function defaultLevelReset(): LevelLocalsT {
  return {
    in_frame: false,
    time: GTIME_ZERO,
    level_name: "",
    mapname: "",
    nextmap: "",
    forcemap: "",
    intermissiontime: GTIME_ZERO,
    changemap: null,
    achievement: null,
    exitintermission: false,
    intermission_eou: false,
    intermission_clear: false,
    level_intermission_set: false,
    intermission_fade: false,
    intermission_fading: false,
    intermission_fade_time: GTIME_ZERO,
    intermission_origin: vec3(),
    intermission_angle: vec3(),
    respawn_intermission: false,
    pic_health: 0,
    pic_ping: 0,
    total_secrets: 0,
    found_secrets: 0,
    total_goals: 0,
    found_goals: 0,
    total_monsters: 0,
    monsters_registered: new Array<EdictT | null>(level.monsters_registered.length).fill(null),
    killed_monsters: 0,
    current_entity: null,
    body_que: 0,
    power_cubes: 0,
    disguise_violator: null,
    disguise_violation_time: GTIME_ZERO,
    disguise_icon: 0,
    shadow_light_count: 0,
    is_n64: false,
    coop_level_restart_time: GTIME_ZERO,
    instantitems: false,
    goals: null,
    goal_num: 0,
    vwep_offset: 0,
    coop_health_scaling: 0,
    coop_scale_players: 0,
    entry: null,
    valid_poi: false,
    current_poi: vec3(),
    current_poi_image: 0,
    current_poi_stage: 0,
    current_dynamic_poi: null,
    poi_points: new Array<Vec3[] | null>(level.poi_points.length).fill(null),
    start_items: null,
    no_grapple: false,
    gravity: 0,
    hub_map: false,
    health_bar_entities: new Array<EdictT | null>(level.health_bar_entities.length).fill(null),
    intermission_server_frame: 0,
    deadly_kill_box: false,
    story_active: false,
    next_auto_save: GTIME_ZERO,
    next_match_report: GTIME_ZERO,
  };
}

export function SpawnEntities(mapname: string, entities: string, spawnpoint: string): void {
  clearCachedIndices();

  let skillLevel = clamp(cvarInt("skill", "0"), 0, 3);
  if (cvarInt("skill", "0") !== skillLevel) {
    gi.cvar_forceset("skill", String(skillLevel));
  }

  SaveClientData();

  // gi.FreeTags(TAG_LEVEL) dropped -- no tag-based allocator on this side
  // of the port (PORTING.md's Z_Malloc/Z_TagMalloc ruling; matches the
  // legacy/vanilla src/game/g_spawn.ts's own identical precedent).

  Object.assign(level, defaultLevelReset());
  // memset(g_edicts, 0, game.maxentities * sizeof(g_edicts[0])) -- same
  // `Object.assign(e, defaultEdict())` idiom g_utils.ts's own G_FreeEdict
  // uses for the identical "memset one edict" operation. The array index is
  // re-stamped into s.number afterward: the C++ needs no number pre-spawn
  // (pointer arithmetic), but this port's EDICT_NUM idiom makes s.number the
  // identity key the engine binding resolves through -- a zeroed number on a
  // preallocated client slot resolves to the world edict (found by the first
  // interactive kex client connect; see g_main.ts's matching stamp).
  for (let i = 0; i < g_edicts.length; i++) {
    Object.assign(g_edicts[i], defaultEdict());
    g_edicts[i].s.number = i;
  }

  // all other flags are not important atm
  globals.server_flags = globals.server_flags & ServerFlagsT.SERVER_FLAG_LOADING;

  level.mapname = mapname;
  // Paril: fixes a bug where autosaves will start you at the wrong
  // spawnpoint if they happen to be non-empty (mine2 -> mine3)
  if (!game.autosaved) game.spawnpoint = spawnpoint;

  level.is_n64 = mapname.startsWith("q64/");

  level.coop_scale_players = 0;
  level.coop_health_scaling = clamp(cvarFloat("g_coop_health_scaling", "0", CvarFlagsT.CVAR_LATCH), 0, 1);

  // set client fields on player ents
  for (let i = 0; i < game.maxclients; i++) {
    const ent = g_edicts[i + 1];
    if (ent !== undefined) {
      const cl = game.clients[i];
      ent.client = cl ?? null;
    }

    const cl = game.clients[i];
    if (cl !== undefined) {
      cl.pers.connected = false;
      cl.pers.spawned = false;
    }
  }

  let ent: EdictT | null = null;
  let inhibit = 0;

  InitBodyQue();

  const state: ComParseState = { data: entities, index: 0 };

  // parse ents
  for (;;) {
    const start = state.index;
    const token = COM_Parse(state);
    if (comParseEOF(state, start, token)) break;
    if (firstChar(token) !== "{") {
      gi.Com_Error(`ED_LoadFromFile: found "${token}" when expecting {`);
    }

    const current: EdictT = ent === null ? g_edicts[0]! : G_Spawn();
    ent = current;
    ED_ParseEdict(state, current);

    // remove things (except the world) from different skill levels or deathmatch
    if (current !== g_edicts[0]) {
      if (G_InhibitEntity(current)) {
        G_FreeEdict(current);
        inhibit++;
        continue;
      }

      current.spawnflags = SpawnFlags_and(current.spawnflags, SpawnFlags_not(SPAWNFLAG_EDITOR_MASK));
    }

    // PGM - do this before calling the spawn function so it can be overridden.
    current.gravityVector[0] = 0.0;
    current.gravityVector[1] = 0.0;
    current.gravityVector[2] = -1.0;
    // PGM
    ED_CallSpawn(current);

    current.s.renderfx = current.s.renderfx | RenderfxT.RF_IR_VISIBLE; // PGM
  }

  gi.Com_Print(`${inhibit} entities inhibited\n`);

  // precache start_items
  G_PrecacheStartItems();

  // precache player inventory items
  G_PrecacheInventoryItems();

  G_FindTeams();

  // ZOID
  CTFSpawn();
  // ZOID

  // ROGUE
  if (deathmatchEnabled()) {
    if (cvarBool("g_dm_random_items", "0")) {
      PrecacheForRandomRespawn();
    }
  } else {
    InitHintPaths(); // if there aren't hintpaths on this map, enable quick aborts
  }
  // ROGUE

  // ROGUE -- allow dm games to do init stuff right before game starts.
  if (deathmatchEnabled() && cvarBool("gamerules", "0", CvarFlagsT.CVAR_LATCH)) {
    if (DMGame.PostInitSetup !== null) DMGame.PostInitSetup();
  }
  // ROGUE

  setup_shadow_lights();
}

// ---------------------------------------------------------------------------
// G_InitStatusbar (g_spawn.cpp:1282-1407)
// ---------------------------------------------------------------------------

/** bg_local.h:56-73 offset chain -- see g_target.ts's own identical copy
 *  (this constant family is not exported anywhere in this port line, so
 *  every file that needs it duplicates the chain; matches the established
 *  "tiny header-only wrapper, duplicated on purpose" idiom). */
const CONFIG_CTF_PLAYER_NAME = CS_GENERAL + 2;
const CONFIG_CTF_PLAYER_NAME_END = CONFIG_CTF_PLAYER_NAME + MAX_CLIENTS;
const COOP_RESPAWN_TOTAL = 6;
const CONFIG_COOP_RESPAWN_STRING = CONFIG_CTF_PLAYER_NAME_END + 1;
const CONFIG_COOP_RESPAWN_STRING_END = CONFIG_COOP_RESPAWN_STRING + (COOP_RESPAWN_TOTAL - 1);
const CONFIG_N64_PHYSICS = CONFIG_COOP_RESPAWN_STRING_END + 1;

// CTFPrecache: formerly a local throwing stub here -- ctf/g_ctf.ts has
// since landed with a real, exported version; swapped for a delegating
// import (2026-08-30 stale-comment sweep). Reached only when
// G_TeamplayEnabled() is true (default false).
function CTFPrecache(): void {
  RealCTFPrecache();
}

function G_InitStatusbar(): void {
  const sb = new StatusbarT();

  // ---- shared stuff that every gamemode uses ----
  sb.yb(-24);

  // health
  sb.xv(0).hnum().xv(50).pic(PlayerStatT.STAT_HEALTH_ICON);

  // ammo
  sb.ifstat(PlayerStatT.STAT_AMMO_ICON).xv(100).anum().xv(150).pic(PlayerStatT.STAT_AMMO_ICON).endifstat();

  // armor
  sb.ifstat(PlayerStatT.STAT_ARMOR_ICON).xv(200).rnum().xv(250).pic(PlayerStatT.STAT_ARMOR_ICON).endifstat();

  // selected item
  sb.ifstat(PlayerStatT.STAT_SELECTED_ICON).xv(296).pic(PlayerStatT.STAT_SELECTED_ICON).endifstat();

  sb.yb(-50);

  // picked up item
  sb.ifstat(PlayerStatT.STAT_PICKUP_ICON).xv(0).pic(PlayerStatT.STAT_PICKUP_ICON).xv(26).yb(-42).loc_stat_string(PlayerStatT.STAT_PICKUP_STRING).yb(-50).endifstat();

  // selected item name
  sb.ifstat(PlayerStatT.STAT_SELECTED_ITEM_NAME).yb(-34).xv(319).loc_stat_rstring(PlayerStatT.STAT_SELECTED_ITEM_NAME).yb(-58).endifstat();

  // timer
  sb.ifstat(PlayerStatT.STAT_TIMER_ICON).xv(262).num(2, PlayerStatT.STAT_TIMER).xv(296).pic(PlayerStatT.STAT_TIMER_ICON).endifstat();

  sb.yb(-50);

  // help / weapon icon
  sb.ifstat(PlayerStatT.STAT_HELPICON).xv(150).pic(PlayerStatT.STAT_HELPICON).endifstat();

  // ---- gamemode-specific stuff ----
  if (!deathmatchEnabled()) {
    // SP/coop
    sb.ifstat(PlayerStatT.STAT_TIMER_ICON).yb(-76).endifstat();
    sb.ifstat(PlayerStatT.STAT_SELECTED_ITEM_NAME).yb(-58).ifstat(PlayerStatT.STAT_TIMER_ICON).yb(-84).endifstat().endifstat();
    sb.ifstat(PlayerStatT.STAT_KEY_A).xv(296).pic(PlayerStatT.STAT_KEY_A).endifstat();
    sb.ifstat(PlayerStatT.STAT_KEY_B).xv(272).pic(PlayerStatT.STAT_KEY_B).endifstat();
    sb.ifstat(PlayerStatT.STAT_KEY_C).xv(248).pic(PlayerStatT.STAT_KEY_C).endifstat();

    if (coopEnabled()) {
      // top of screen coop respawn display
      sb.ifstat(PlayerStatT.STAT_COOP_RESPAWN).xv(0).yt(0).loc_stat_cstring2(PlayerStatT.STAT_COOP_RESPAWN).endifstat();
      // coop lives
      sb.ifstat(PlayerStatT.STAT_LIVES).xr(-16).yt(2).lives_num(PlayerStatT.STAT_LIVES).xr(0).yt(28).loc_rstring("$g_lives").endifstat();
    }

    sb.ifstat(PlayerStatT.STAT_HEALTH_BARS).yt(24).health_bars().endifstat();
  } else if (G_TeamplayEnabled()) {
    CTFPrecache();

    // ctf/tdm -- red team
    sb.yb(-110).ifstat(PlayerStatT.STAT_CTF_TEAM1_PIC).xr(-26).pic(PlayerStatT.STAT_CTF_TEAM1_PIC).endifstat().xr(-78).num(3, PlayerStatT.STAT_CTF_TEAM1_CAPS);
    sb.ifstat(PlayerStatT.STAT_CTF_JOINED_TEAM1_PIC).yb(-112).xr(-28).pic(PlayerStatT.STAT_CTF_JOINED_TEAM1_PIC).endifstat();

    // blue team
    sb.yb(-83).ifstat(PlayerStatT.STAT_CTF_TEAM2_PIC).xr(-26).pic(PlayerStatT.STAT_CTF_TEAM2_PIC).endifstat().xr(-78).num(3, PlayerStatT.STAT_CTF_TEAM2_CAPS);
    sb.ifstat(PlayerStatT.STAT_CTF_JOINED_TEAM2_PIC).yb(-85).xr(-28).pic(PlayerStatT.STAT_CTF_JOINED_TEAM2_PIC).endifstat();

    if (cvarBool("ctf", "0", CvarFlagsT.CVAR_LATCH)) {
      sb.ifstat(PlayerStatT.STAT_CTF_FLAG_PIC).yt(26).xr(-24).pic(PlayerStatT.STAT_CTF_FLAG_PIC).endifstat();
    }

    sb.ifstat(PlayerStatT.STAT_CTF_ID_VIEW).xv(112).yb(-58).stat_pname(PlayerStatT.STAT_CTF_ID_VIEW).endifstat();
    sb.ifstat(PlayerStatT.STAT_CTF_ID_VIEW_COLOR).xv(96).yb(-58).pic(PlayerStatT.STAT_CTF_ID_VIEW_COLOR).endifstat();

    if (cvarBool("ctf", "0", CvarFlagsT.CVAR_LATCH)) {
      sb.ifstat(PlayerStatT.STAT_CTF_MATCH).xl(0).yb(-78).stat_string(PlayerStatT.STAT_CTF_MATCH).endifstat();
    }

    sb.ifstat(PlayerStatT.STAT_CTF_TEAMINFO).xl(0).yb(-88).stat_string(PlayerStatT.STAT_CTF_TEAMINFO).endifstat();
  } else {
    // dm
    sb.xr(-50).yt(2).num(3, PlayerStatT.STAT_FRAGS);
    sb.ifstat(PlayerStatT.STAT_SPECTATOR).xv(0).yb(-58).string2("SPECTATOR MODE").endifstat();
    sb.ifstat(PlayerStatT.STAT_CHASE).xv(0).yb(-68).string("CHASING").xv(64).stat_string(PlayerStatT.STAT_CHASE).endifstat();
  }

  // ---- more shared stuff ----
  if (deathmatchEnabled()) {
    sb.ifstat(PlayerStatT.STAT_CTF_TECH).yb(-137).xr(-26).pic(PlayerStatT.STAT_CTF_TECH).endifstat();
  } else {
    sb.story();
  }

  gi.configstring(CS_STATUSBAR, sb.str());
}

// ---------------------------------------------------------------------------
// SP_worldspawn (g_spawn.cpp:1410-1724)
// ---------------------------------------------------------------------------

/*QUAKED worldspawn (0 0 0) ?

Only used for the world.
"sky"	environment map name
"skyaxis"	vector axis for rotating sky
"skyrotate"	speed of rotation in degrees/second
"sounds"	music cd track number
"gravity"	800 is default gravity
"message"	text to print at user logon
*/
export function SP_worldspawn(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_PUSH;
  ent.solid = SolidT.SOLID_BSP;
  ent.inuse = true; // since the world doesn't use G_Spawn()
  ent.s.modelindex = MODELINDEX_WORLD;
  ent.gravity = 1.0;

  if (st.hub_map) {
    level.hub_map = true;

    // clear helps
    game.help1changed = 0;
    game.help2changed = 0;
    game.helpmessage1 = "";
    game.helpmessage2 = "";

    for (let i = 0; i < game.maxclients; i++) {
      const cl = game.clients[i];
      if (cl === undefined) continue;
      cl.pers.game_help1changed = 0;
      cl.pers.game_help2changed = 0;
      cl.resp.coop_respawn.game_help1changed = 0;
      cl.resp.coop_respawn.game_help2changed = 0;
    }
  }

  if (st.achievement !== null && st.achievement !== "") level.achievement = st.achievement;

  //---------------

  // set configstrings for items
  SetItemNames();

  if (st.nextmap !== null) level.nextmap = st.nextmap;

  // make some data visible to the server
  if (ent.message !== null && ent.message !== "") {
    gi.configstring(CS_NAME, ent.message);
    level.level_name = ent.message;
  } else {
    level.level_name = level.mapname;
  }

  if (st.sky !== null && st.sky !== "") gi.configstring(CS_SKY, st.sky);
  else gi.configstring(CS_SKY, "unit1_");

  gi.configstring(CS_SKYROTATE, `${st.skyrotate} ${st.skyautorotate}`);

  gi.configstring(CS_SKYAXIS, `${st.skyaxis[0]} ${st.skyaxis[1]} ${st.skyaxis[2]}`);

  if (st.music !== null && st.music !== "") {
    gi.configstring(CS_CDTRACK, st.music);
  } else {
    gi.configstring(CS_CDTRACK, String(ent.sounds));
  }

  if (level.is_n64) {
    gi.configstring(CS_CD_LOOP_COUNT, "0");
  } else if (st.keys_specified.has("loop_count")) {
    gi.configstring(CS_CD_LOOP_COUNT, String(st.loop_count));
  } else {
    gi.configstring(CS_CD_LOOP_COUNT, "");
  }

  if (st.instantitems > 0 || level.is_n64) {
    level.instantitems = true;
  }

  // [Paril-KEX]
  if (!deathmatchEnabled()) {
    gi.configstring(CS_GAME_STYLE, String(GameStyleT.GAME_STYLE_PVE));
  } else if (cvarBool("teamplay", "0", CvarFlagsT.CVAR_LATCH) || cvarBool("ctf", "0", CvarFlagsT.CVAR_LATCH)) {
    gi.configstring(CS_GAME_STYLE, String(GameStyleT.GAME_STYLE_TDM));
  } else {
    gi.configstring(CS_GAME_STYLE, String(GameStyleT.GAME_STYLE_FFA));
  }

  // [Paril-KEX]
  if (st.goals !== null) {
    level.goals = st.goals;
    game.help1changed++;
  }

  if (st.start_items !== null) level.start_items = st.start_items;

  if (st.no_grapple !== 0) level.no_grapple = st.no_grapple !== 0;

  gi.configstring(CS_MAXCLIENTS, String(game.maxclients));

  if (level.is_n64 && !deathmatchEnabled()) {
    gi.configstring(CONFIG_N64_PHYSICS, "1");
    // pm_config.n64_physics = true; -- dropped, see file header
  }

  // statusbar prog
  G_InitStatusbar();

  // [Paril-KEX] air accel handled by game DLL now, and allow it to be
  // changed in sp/coop
  const airaccel = cvarInt("sv_airaccelerate", "0");
  gi.configstring(CS_AIRACCEL, String(airaccel));
  // pm_config.airaccel = airaccel; -- dropped, see file header

  const airaccelCvar = gi.cvar("sv_airaccelerate", "0", CvarFlagsT.CVAR_NOFLAGS);
  game.airacceleration_modified = airaccelCvar !== null && airaccelCvar.modified ? 1 : 0;

  //---------------

  // help icon for statusbar
  gi.imageindex("i_help");
  level.pic_health = gi.imageindex("i_health");
  gi.imageindex("help");
  gi.imageindex("field_3");

  if (st.gravity === null) {
    level.gravity = 800;
    gi.cvar_set("sv_gravity", "800");
  } else {
    level.gravity = C_atof(st.gravity);
    gi.cvar_set("sv_gravity", st.gravity);
  }

  gi.soundindex("player/fry.wav"); // standing in lava / slime -- see file header (snd_fry gap)

  PrecacheItem(GetItemByIndex(ItemIdT.IT_ITEM_COMPASS));
  PrecacheItem(GetItemByIndex(ItemIdT.IT_WEAPON_BLASTER));

  if (cvarBool("g_dm_random_items", "0")) {
    for (let i = ItemIdT.IT_NULL + 1; i < ItemIdT.IT_TOTAL; i++) {
      PrecacheItem(GetItemByIndex(i));
    }
  }

  gi.soundindex("player/lava1.wav");
  gi.soundindex("player/lava2.wav");

  gi.soundindex("misc/pc_up.wav");
  gi.soundindex("misc/talk1.wav");

  // gibs
  gi.soundindex("misc/udeath.wav");

  gi.soundindex("items/respawn1.wav");
  gi.soundindex("misc/mon_power2.wav");

  // sexed sounds
  gi.soundindex("*death1.wav");
  gi.soundindex("*death2.wav");
  gi.soundindex("*death3.wav");
  gi.soundindex("*death4.wav");
  gi.soundindex("*fall1.wav");
  gi.soundindex("*fall2.wav");
  gi.soundindex("*gurp1.wav"); // drowning damage
  gi.soundindex("*gurp2.wav");
  gi.soundindex("*jump1.wav"); // player jump
  gi.soundindex("*pain25_1.wav");
  gi.soundindex("*pain25_2.wav");
  gi.soundindex("*pain50_1.wav");
  gi.soundindex("*pain50_2.wav");
  gi.soundindex("*pain75_1.wav");
  gi.soundindex("*pain75_2.wav");
  gi.soundindex("*pain100_1.wav");
  gi.soundindex("*pain100_2.wav");
  gi.soundindex("*drown1.wav"); // [Paril-KEX]

  // sexed models -- vwep_index reset + assignment loop
  for (const item of itemlist) item.vwep_index = 0;

  for (const item of itemlist) {
    if (item.vwep_model === null) continue;

    let found = false;
    for (const check of itemlist) {
      if (check.vwep_model !== null && check.vwep_model.toLowerCase() === item.vwep_model.toLowerCase() && check.vwep_index !== 0) {
        item.vwep_index = check.vwep_index;
        found = true;
        break;
      }
    }

    if (found) continue;

    item.vwep_index = gi.modelindex(item.vwep_model);

    if (level.vwep_offset === 0) level.vwep_offset = item.vwep_index;
  }

  //-------------------

  gi.soundindex("player/gasp1.wav"); // gasping for air
  gi.soundindex("player/gasp2.wav"); // head breaking surface, not gasping

  gi.soundindex("player/watr_in.wav"); // feet hitting water
  gi.soundindex("player/watr_out.wav"); // feet leaving water

  gi.soundindex("player/watr_un.wav"); // head going underwater

  gi.soundindex("player/u_breath1.wav");
  gi.soundindex("player/u_breath2.wav");

  gi.soundindex("player/wade1.wav");
  gi.soundindex("player/wade2.wav");
  gi.soundindex("player/wade3.wav");

  gi.soundindex("items/pkup.wav"); // bonus item pickup
  gi.soundindex("world/land.wav"); // landing thud
  gi.soundindex("misc/h2ohit1.wav"); // landing splash

  gi.soundindex("items/damage.wav");
  gi.soundindex("items/protect.wav");
  gi.soundindex("items/protect4.wav");
  gi.soundindex("weapons/noammo.wav");
  gi.soundindex("weapons/lowammo.wav");
  gi.soundindex("weapons/change.wav");

  gi.soundindex("infantry/inflies1.wav");

  // BUG FIX (task report): g_spawn.cpp:1650 is `sm_meat_index.assign(...)`,
  // where `sm_meat_index` is declared `cached_modelindex sm_meat_index;`
  // (g_local.h:3648) -- a MODEL index cache, not a sound one. This line
  // previously called `gi.soundindex()` on a model path, which registered
  // "models/objects/gibs/sm_meat/tris.md2" into the SOUNDS configstring
  // region instead of the MODELS one. The client's precache download walk
  // (src/client/cl_main.ts's CL_RequestNextDownload) later read that string
  // back out of the sounds region and requested
  // "sound/models/objects/gibs/sm_meat/tris.md2" -- a file that can never
  // exist -- while every real consumer of this gib model (ThrowGib's
  // `gi.modelindex(gibname)`, BecomeExplosion1's
  // `gi.setmodel(fireball, "models/objects/gibs/sm_meat/tris.md2")`) got a
  // modelindex that was never pre-warmed, `gi.soundindex`'s two
  // configstring writes never having touched svs.csr.models at all.
  gi.modelindex("models/objects/gibs/sm_meat/tris.md2"); // sm_meat_index -- see file header
  gi.modelindex("models/objects/gibs/arm/tris.md2");
  gi.modelindex("models/objects/gibs/bone/tris.md2");
  gi.modelindex("models/objects/gibs/bone2/tris.md2");
  gi.modelindex("models/objects/gibs/chest/tris.md2");
  gi.modelindex("models/objects/gibs/skull/tris.md2");
  gi.modelindex("models/objects/gibs/head2/tris.md2");
  gi.modelindex("models/objects/gibs/sm_metal/tris.md2");

  level.pic_ping = gi.imageindex("loc_ping");

  //
  // Setup light animation tables. 'a' is total darkness, 'z' is doublebright.
  //
  gi.configstring(CS_LIGHTS + 0, "m");
  gi.configstring(CS_LIGHTS + 1, "mmnmmommommnonmmonqnmmo");
  gi.configstring(CS_LIGHTS + 2, "abcdefghijklmnopqrstuvwxyzyxwvutsrqponmlkjihgfedcba");
  gi.configstring(CS_LIGHTS + 3, "mmmmmaaaaammmmmaaaaaabcdefgabcdefg");
  gi.configstring(CS_LIGHTS + 4, "mamamamamama");
  gi.configstring(CS_LIGHTS + 5, "jklmnopqrstuvwxyzyxwvutsrqponmlkj");
  gi.configstring(CS_LIGHTS + 6, "nmonqnmomnmomomno");
  gi.configstring(CS_LIGHTS + 7, "mmmaaaabcdefgmmmmaaaammmaamm");
  gi.configstring(CS_LIGHTS + 8, "mmmaaammmaaammmabcdefaaaammmmabcdefmmmaaaa");
  gi.configstring(CS_LIGHTS + 9, "aaaaaaaazzzzzzzz");
  gi.configstring(CS_LIGHTS + 10, "mmamammmmammamamaaamammma");
  gi.configstring(CS_LIGHTS + 11, "abcdefghijklmnopqrrqponmlkjihgfedcba");
  gi.configstring(CS_LIGHTS + 12, "zzazazzzzazzazazaaazazzza");
  gi.configstring(CS_LIGHTS + 13, "abcdefghijklmnopqrstuvwxyz");
  gi.configstring(CS_LIGHTS + 14, "abcdefghijklmnopqrstuvwxyzyxwvutsrqponmlkjihgfedcba");
  // styles 32-62 are assigned by the light program for switchable lights
  gi.configstring(CS_LIGHTS + 63, "a"); // testing

  // coop respawn strings
  if (coopEnabled()) {
    gi.configstring(CONFIG_COOP_RESPAWN_STRING + 0, "$g_coop_respawn_in_combat");
    gi.configstring(CONFIG_COOP_RESPAWN_STRING + 1, "$g_coop_respawn_bad_area");
    gi.configstring(CONFIG_COOP_RESPAWN_STRING + 2, "$g_coop_respawn_blocked");
    gi.configstring(CONFIG_COOP_RESPAWN_STRING + 3, "$g_coop_respawn_waiting");
    gi.configstring(CONFIG_COOP_RESPAWN_STRING + 4, "$g_coop_respawn_no_lives");
  }
}
