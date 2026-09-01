// g_spawn.c
//
// rogue/g_spawn.c vs baseq2/g_spawn.c: the spawns[] registry grows by
// roughly 30 entries for the pack's new entities (owned by this unit and
// the two sibling units RG-monsters/RG-systems -- see each entry's comment
// below for which file actually implements it), ED_CallSpawn/SpawnEntities
// gain rogue's ROGUE_GRAVITY reset-before-spawn (`ent->gravityVector` set
// to (0,0,-1) immediately before every spawn-function call, so a spawn
// function can still override it) plus a PMM classname-compat hack
// (weapon_nailgun/ammo_nails/weapon_heatbeam legacy map entities remap to
// the pack's real item classnames), a coop skill-flag filter block (absent
// from baseq2's g_spawn.c -- coop-only spawn filtering), an rhangar2 map
// hack, RF_IR_VISIBLE tagging on every spawned entity, deathmatch
// gamerules/randomrespawn hooks, and a large new block of monster-spawning
// helpers (CreateMonster/CreateFlyMonster/CreateGroundMonster/
// FindSpawnPoint/CheckSpawnPoint/CheckGroundSpawnPoint/DetermineBBox) plus
// two standalone debris-prop spawners (SpawnGrow_Spawn/Widowlegs_Spawn)
// used by the carrier/medic-commander/widow family (RG-monsters' SCOPE).
//
// G_FixTeams (a new func_train-team-repair pass) is appended to the end of
// G_FindTeams's body, called once right before G_FindTeams's own dprintf --
// preserved in that exact order even though it duplicates most of
// G_FindTeams's own team-chaining loop (that duplication is in the C
// source itself, not introduced by this port).

import {
  AngleVectors,
  COM_Parse,
  type ComParseState,
  random,
  vec3,
  vec3_origin,
  type Vec3,
  VectorAdd,
  VectorCompare,
  VectorCopy,
  VectorSet,
} from "../shared/math";
import {
  Com_sprintf,
  CONTENTS_PLAYERCLIP,
  CONTENTS_SOLID,
  CS_CDTRACK,
  CS_LIGHTS,
  CS_MAXCLIENTS,
  CS_NAME,
  CS_SKY,
  CS_SKYAXIS,
  CS_SKYROTATE,
  CS_STATUSBAR,
  EF_SPHERETRANS,
  MASK_MONSTERSOLID,
  MASK_WATER,
  MAX_QPATH,
  MulticastT,
  Q_stricmp,
  RF_IR_VISIBLE,
  TempEventT,
} from "../shared/q_shared";
import {
  AI_DO_NOT_COUNT,
  DMGame,
  type EdictT,
  FL_GODMODE,
  FL_NOTARGET,
  FL_POWER_ARMOR,
  FL_TEAMSLAVE,
  FRAMETIME,
  GIB_METALLIC,
  g_edicts,
  game,
  gameCvars,
  gameIndices,
  gi,
  globals,
  level,
  MovetypeT,
  SPAWNFLAG_NOT_COOP,
  SPAWNFLAG_NOT_DEATHMATCH,
  SPAWNFLAG_NOT_EASY,
  SPAWNFLAG_NOT_HARD,
  SPAWNFLAG_NOT_MEDIUM,
  st,
  svc_temp_entity,
  world,
} from "./g_local";
import { SolidT } from "./game";
import { FIELDS } from "./g_save";
import { G_FreeEdict, G_ProjectSource2, G_Spawn } from "./g_utils";
import { FindItem, itemlist, PrecacheItem, SetItemNames, SpawnItem } from "./g_items";
import { InitBodyQue } from "./p_client";
import { PlayerTrail_Init } from "./p_trail";

// SP_ functions from every sibling module g_spawn.c's spawns[] table lists.
import {
  SP_item_health,
  SP_item_health_large,
  SP_item_health_mega,
  SP_item_health_small,
  SP_xatrix_item,
} from "./g_items";
import {
  SP_info_player_coop,
  SP_info_player_coop_lava,
  SP_info_player_deathmatch,
  SP_info_player_intermission,
  SP_info_player_start,
} from "./p_client";
import {
  SP_func_button,
  SP_func_conveyor,
  SP_func_door,
  SP_func_door_rotating,
  SP_func_door_secret,
  SP_func_killbox,
  SP_func_plat,
  SP_func_plat2,
  SP_func_rotating,
  SP_func_timer,
  SP_func_train,
  SP_func_water,
  SP_trigger_elevator,
} from "./g_func";
import {
  SP_func_areaportal,
  SP_func_clock,
  SP_func_explosive,
  SP_func_object,
  SP_func_wall,
  SP_info_notnull,
  SP_info_null,
  SP_light,
  SP_light_mine1,
  SP_light_mine2,
  SP_misc_banner,
  SP_misc_bigviper,
  SP_misc_blackhole,
  SP_misc_deadsoldier,
  SP_misc_easterchick,
  SP_misc_easterchick2,
  SP_misc_eastertank,
  SP_misc_explobox,
  SP_misc_gib_arm,
  SP_misc_gib_head,
  SP_misc_gib_leg,
  SP_misc_nuke_core,
  SP_misc_satellite_dish,
  SP_misc_strogg_ship,
  SP_misc_teleporter,
  SP_misc_teleporter_dest,
  SP_misc_viper,
  SP_misc_viper_bomb,
  SP_monster_commander_body,
  SP_path_corner,
  SP_point_combat,
  SP_target_character,
  SP_target_string,
  SP_viewthing,
} from "./g_misc";
import {
  SP_trigger_always,
  SP_trigger_counter,
  SP_trigger_gravity,
  SP_trigger_hurt,
  SP_trigger_key,
  SP_trigger_monsterjump,
  SP_trigger_multiple,
  SP_trigger_once,
  SP_trigger_push,
  SP_trigger_relay,
} from "./g_trigger";
import {
  SP_target_blaster,
  SP_target_changelevel,
  SP_target_crosslevel_target,
  SP_target_crosslevel_trigger,
  SP_target_earthquake,
  SP_target_explosion,
  SP_target_goal,
  SP_target_help,
  SP_target_laser,
  SP_target_lightramp,
  SP_target_secret,
  SP_target_spawner,
  SP_target_speaker,
  SP_target_splash,
  SP_target_temp_entity,
} from "./g_target";
import { SP_turret_base, SP_turret_breach, SP_turret_driver, SP_turret_invisible_brain } from "./g_turret";
import { SP_misc_actor, SP_target_actor } from "./m_actor";
import { SP_misc_insane } from "./m_insane";
import { SP_monster_berserk } from "./m_berserk";
import { SP_monster_gladiator } from "./m_gladiator";
import { SP_monster_gunner } from "./m_gunner";
import { SP_monster_infantry } from "./m_infantry";
import { SP_monster_soldier, SP_monster_soldier_light, SP_monster_soldier_ss } from "./m_soldier";
import { SP_monster_tank } from "./m_tank";
import { SP_monster_medic } from "./m_medic";
import { SP_monster_flipper } from "./m_flipper";
import { SP_monster_chick } from "./m_chick";
import { SP_monster_parasite } from "./m_parasite";
import { SP_monster_flyer, SP_monster_kamikaze } from "./m_flyer";
import { SP_monster_brain } from "./m_brain";
import { SP_monster_floater } from "./m_float";
import { SP_monster_hover } from "./m_hover";
import { SP_monster_mutant } from "./m_mutant";
import { SP_monster_supertank } from "./m_supertank";
import { SP_monster_boss2 } from "./m_boss2";
import { SP_monster_boss3_stand } from "./m_boss3";
import { SP_monster_jorg } from "./m_boss31";

// RG-monsters' SCOPE (pack-only monster files) -- imported as if present
// per this pack's cross-unit convention.
import { SP_monster_stalker } from "./m_stalker";
import { SP_monster_turret } from "./m_turret";
import { SP_monster_carrier } from "./m_carrier";
import { SP_monster_widow } from "./m_widow";
import { SP_monster_widow2, ThrowSmallStuff, ThrowWidowGibSized } from "./m_widow2";

// RG-systems' SCOPE (pack-only new-systems files) -- imported as if
// present per this pack's cross-unit convention.
import {
  SP_func_door_secret2,
  SP_func_force_wall,
} from "./g_newfnc";
import {
  SP_info_teleport_destination,
  SP_trigger_disguise,
  SP_trigger_teleport,
} from "./g_newtrig";
import {
  SP_target_anger,
  SP_target_blacklight,
  SP_target_killplayers,
  SP_target_orb,
  SP_target_steam,
} from "./g_newtarg";
import { InitHintPaths, SP_hint_path } from "./g_newai";
import { SP_dm_tag_token } from "./dm_tag";
import {
  SP_dm_dball_ball,
  SP_dm_dball_ball_start,
  SP_dm_dball_goal,
  SP_dm_dball_speed_change,
  SP_dm_dball_team1_start,
  SP_dm_dball_team2_start,
} from "./dm_ball";
import { PrecacheForRandomRespawn } from "./g_newdm";

// gameCvars entries are `CvarT | null` until InitGame resolves them (see
// g_main.ts's identical helper and comment). Mirrored locally here since
// g_main.ts does not export it and this file needs the same "not resolved
// yet reads as 0" behavior C gets for free from a live cvar_t pointer.
function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

//===================================================================
// field_t / fields[] (owned by g_save.c, not g_spawn.c)
//===================================================================

// g_local.h declares `field_t fields[]` as an extern read by both
// g_spawn.c's ED_ParseField (spawn-time parsing) and g_save.c's
// WriteEdict/ReadEdict (save-game (de)serialization); the array itself is
// *defined* in g_save.c, not g_spawn.c. Per PORTING.md ("g_save.c's fields[]
// table gets the same property-name redesign"), the table (and the
// FieldSpawn type it's typed with) now lives in src/rogue/g_save.ts and is
// imported here; ED_ParseField's behavior is unchanged.

// Unknown-field / unknown-classname spawn noise, gated behind the
// "developer" cvar. Mike's ruling (2026-08-31): "quiet it" -- see
// .orch/followups.md finding 14, extended to every LEGACY-family module
// (coordinator follow-up, same day: the ruling covers the family, and
// Rogue loads rerelease-authored maps through the New Game selector the
// same way baseq2 does). Identical mechanism to src/game/g_spawn.ts's
// ED_ParseField/ED_CallSpawn/SpawnEntities: the frozen Rogue game DLL
// dprintfs "<field> is not a field" / "<classname> doesn't have a spawn
// function" for every KEX-era key/entity a rerelease map carries; that
// per-line output is faithful, but at developer 0 it is unusable console
// flooding on rerelease data. Both message classes are counted instead of
// printed and rolled into one summary line at spawn completion (see
// SpawnEntities below); developer 1 restores the byte-identical vanilla
// per-line output. This module's own counter state (not shared with
// src/game/g_spawn.ts or any other sibling). Not added to gameCvars
// (g_local.ts) because that table mirrors only the cvar_t* externs the
// real game DLL declares in g_local.h/game.h, and vanilla has no such
// extern -- resolved dynamically here instead.
const unknownFieldKeys = new Set<string>();
const unknownClassnames = new Set<string>();

function developerMode(): boolean {
  return cvarNum(gi.cvar("developer", "0", 0)) !== 0;
}

function C_atoi(value: string): number {
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? 0 : n;
}

function C_atof(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isNaN(n) ? 0 : n;
}

// sscanf (value, "%f %f %f", &vec[0], &vec[1], &vec[2]) -- components past
// what the string actually contains are left as 0 rather than C's
// uninitialized stack garbage (there is no equivalent UB to reproduce in
// JS, and every real map file supplies exactly three numbers here).
function parseVector3(value: string): Vec3 {
  const parts = value.trim().length > 0 ? value.trim().split(/\s+/) : [];
  const v = vec3();
  for (let i = 0; i < 3; i++) {
    const part = parts[i];
    v[i] = part === undefined ? 0 : C_atof(part);
  }
  return v;
}

/*
=============
ED_NewString
=============
*/
export function ED_NewString(value: string): string {
  // gi.TagMalloc(l, TAG_LEVEL) is dropped: memory tags are omitted per
  // PORTING.md ("Z_Malloc/Z_Free/Hunk_*/Z_TagMalloc -> plain allocation");
  // JS strings need no backing allocation call.
  let out = "";
  const len = value.length;
  for (let i = 0; i < len; i++) {
    if (value[i] === "\\" && i < len - 1) {
      i++;
      out += value[i] === "n" ? "\n" : "\\";
    } else {
      out += value[i];
    }
  }
  return out;
}

/*
===============
ED_ParseField

Takes a key/value pair and sets the binary values
in an edict
===============
*/
export function ED_ParseField(key: string, value: string, ent: EdictT): void {
  for (const f of FIELDS) {
    if (Q_stricmp(f.key, key) !== 0) continue;

    switch (f.type) {
      case "F_LSTRING": {
        const s = ED_NewString(value);
        if (f.target === "edict") ent[f.prop] = s;
        else st[f.prop] = s;
        break;
      }
      case "F_INT": {
        const n = C_atoi(value);
        if (f.target === "edict") ent[f.prop] = n;
        else st[f.prop] = n;
        break;
      }
      case "F_FLOAT": {
        const n = C_atof(value);
        if (f.target === "edict") ent[f.prop] = n;
        else st[f.prop] = n;
        break;
      }
      case "F_VECTOR": {
        const vec = parseVector3(value);
        const dest = f.target === "edict" ? ent[f.prop] : f.target === "spawntemp" ? st[f.prop] : ent.s[f.prop];
        VectorCopy(vec, dest);
        break;
      }
      case "F_ANGLEHACK": {
        const yaw = C_atof(value);
        const dest = f.target === "edict" ? ent[f.prop] : f.target === "spawntemp" ? st[f.prop] : ent.s[f.prop];
        dest[0] = 0;
        dest[1] = yaw;
        dest[2] = 0;
        break;
      }
      case "F_IGNORE":
        break;
    }
    return;
  }
  // Mike's ruling (2026-08-31): "quiet it" -- see the deviation comment on
  // unknownFieldKeys/developerMode above C_atoi. developer 1 keeps the
  // byte-identical vanilla line; developer 0 counts it silently and
  // SpawnEntities prints one summary line instead.
  if (developerMode()) {
    gi.dprintf(`${key} is not a field\n`);
  } else {
    unknownFieldKeys.add(key);
  }
}

//===================================================================

function firstChar(token: string): string {
  return token.length > 0 ? token[0] : "";
}

// COM_Parse's C original sets *data_p = NULL when the scan hits
// end-of-string before finding anything; our COM_Parse (a mutable
// { data, index } state rather than a char**) signals the same case by
// returning "" without having just closed a quote -- see qcommon/cmd.ts's
// Cmd_MacroExpandString, the established precedent for this exact check.
function comParseEOF(state: ComParseState, startIndex: number, token: string): boolean {
  const closedEmptyQuote = state.index > startIndex && state.data.charAt(state.index - 1) === '"';
  return token === "" && !closedEmptyQuote;
}

/*
====================
ED_ParseEdict

Parses an edict out of the given string, advancing state.index past it.
ent should be a properly initialized empty edict.
====================
*/
export function ED_ParseEdict(state: ComParseState, ent: EdictT): void {
  let init = false;
  st.clear();

  for (;;) {
    // parse key
    const keyStart = state.index;
    const keyToken = COM_Parse(state);
    if (firstChar(keyToken) === "}") break;
    if (comParseEOF(state, keyStart, keyToken)) {
      gi.error("ED_ParseEntity: EOF without closing brace");
    }
    const keyname = keyToken;

    // parse value
    const valStart = state.index;
    const valToken = COM_Parse(state);
    if (comParseEOF(state, valStart, valToken)) {
      gi.error("ED_ParseEntity: EOF without closing brace");
    }
    if (firstChar(valToken) === "}") {
      gi.error("ED_ParseEntity: closing brace without data");
    }

    init = true;

    // keynames with a leading underscore are used for utility comments,
    // and are immediately discarded by quake
    if (firstChar(keyname) === "_") continue;

    ED_ParseField(keyname, valToken, ent);
  }

  if (!init) ent.clear();
}

//===================================================================
// spawns[]
//===================================================================

export interface SpawnT {
  name: string;
  spawn: (ent: EdictT) => void;
}

const spawns: SpawnT[] = [
  { name: "item_health", spawn: SP_item_health },
  { name: "item_health_small", spawn: SP_item_health_small },
  { name: "item_health_large", spawn: SP_item_health_large },
  { name: "item_health_mega", spawn: SP_item_health_mega },

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
  { name: "target_laser", spawn: SP_target_laser },
  { name: "target_help", spawn: SP_target_help },
  { name: "target_actor", spawn: SP_target_actor },
  { name: "target_lightramp", spawn: SP_target_lightramp },
  { name: "target_earthquake", spawn: SP_target_earthquake },
  { name: "target_character", spawn: SP_target_character },
  { name: "target_string", spawn: SP_target_string },

  { name: "worldspawn", spawn: SP_worldspawn },
  { name: "viewthing", spawn: SP_viewthing },

  { name: "light", spawn: SP_light },
  { name: "light_mine1", spawn: SP_light_mine1 },
  { name: "light_mine2", spawn: SP_light_mine2 },
  { name: "info_null", spawn: SP_info_null },
  { name: "func_group", spawn: SP_info_null },
  { name: "info_notnull", spawn: SP_info_notnull },
  { name: "path_corner", spawn: SP_path_corner },
  { name: "point_combat", spawn: SP_point_combat },

  { name: "misc_explobox", spawn: SP_misc_explobox },
  { name: "misc_banner", spawn: SP_misc_banner },
  { name: "misc_satellite_dish", spawn: SP_misc_satellite_dish },
  { name: "misc_actor", spawn: SP_misc_actor },
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

  { name: "monster_commander_body", spawn: SP_monster_commander_body },

  { name: "turret_breach", spawn: SP_turret_breach },
  { name: "turret_base", spawn: SP_turret_base },
  { name: "turret_driver", spawn: SP_turret_driver },

  // ROGUE
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
  // C: `//{"target_spawn", SP_target_spawn},` -- commented out in the
  // source itself, not ported.
  { name: "target_killplayers", spawn: SP_target_killplayers },
  // PMM - experiment
  { name: "target_blacklight", spawn: SP_target_blacklight },
  { name: "target_orb", spawn: SP_target_orb },
  // pmm
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
  // C: `//{"monster_chick2", SP_monster_chick2},` -- commented out in the
  // source itself, not ported.
  { name: "turret_invisible_brain", spawn: SP_turret_invisible_brain },
  { name: "misc_nuke_core", spawn: SP_misc_nuke_core },

  { name: "ammo_magslug", spawn: SP_xatrix_item },
  { name: "ammo_trap", spawn: SP_xatrix_item },
  { name: "item_quadfire", spawn: SP_xatrix_item },
  { name: "weapon_boomer", spawn: SP_xatrix_item },
  { name: "weapon_phalanx", spawn: SP_xatrix_item },
  // ROGUE
];

// Exposed the same way g_items.ts's `itemlist()` exposes its private
// table -- a readonly accessor rather than the mutable array itself, so
// the coordinator's unit test (test/rogue_core.test.ts) can assert this
// unit's spawns[] registry entry count against rogue/g_spawn.c's real
// `spawn_t spawns[]` array (143 real entries, not counting the
// `{NULL, NULL}` terminator, verified by hand against the C source).
export function spawnRegistry(): readonly SpawnT[] {
  return spawns;
}

/*
===============
ED_CallSpawn

Finds the spawn function for the entity and calls it
===============
*/
export function ED_CallSpawn(ent: EdictT): void {
  if (ent.classname === null) {
    gi.dprintf("ED_CallSpawn: NULL classname\n");
    return;
  }

  // PGM - do this before calling the spawn function so it can be
  // overridden. rogue/g_local.h defines ROGUE_GRAVITY unconditionally, so
  // this branch is always live.
  VectorSet(ent.gravityVector, 0, 0, -1);

  // FIXME - PMM classnames hack: legacy map entities from pre-release
  // rogue betas get remapped to the shipped item names.
  if (ent.classname === "weapon_nailgun") {
    const item = FindItem("ETF Rifle");
    if (item !== null) ent.classname = item.classname;
  }
  if (ent.classname === "ammo_nails") {
    const item = FindItem("Flechettes");
    if (item !== null) ent.classname = item.classname;
  }
  if (ent.classname === "weapon_heatbeam") {
    const item = FindItem("Plasma Beam");
    if (item !== null) ent.classname = item.classname;
  }
  // pmm

  const classname = ent.classname;

  // check item spawn functions -- guarded on game.num_items (set by
  // g_items.c:InitItems) so this never calls the itemlist() accessor when
  // there are no items to check, exactly as the C loop's `i <
  // game.num_items` condition never dereferences `itemlist` when
  // num_items is 0.
  if (game.num_items > 0) {
    const items = itemlist();
    for (let i = 0; i < game.num_items; i++) {
      const item = items[i];
      if (item === undefined || item.classname === null) continue;
      if (item.classname === classname) {
        // found it
        SpawnItem(ent, item);
        return;
      }
    }
  }

  // check normal spawn functions
  for (const s of spawns) {
    if (s.name === classname) {
      // found it
      s.spawn(ent);
      return;
    }
  }
  // Mike's ruling (2026-08-31): "quiet it" -- see the deviation comment on
  // unknownFieldKeys/developerMode above C_atoi (same rationale, same
  // gate). developer 1 keeps the byte-identical vanilla line; developer 0
  // counts it silently and SpawnEntities prints one summary line instead.
  if (developerMode()) {
    gi.dprintf(`${classname} doesn't have a spawn function\n`);
  } else {
    // `classname` is `string | null` here (not `string`, unlike the other
    // three legacy modules' ED_CallSpawn): the FIXME PMM-classname-hack
    // block above reassigns `ent.classname` from `FindItem(...).classname`
    // (typed `string | null` even though these three lookups never
    // actually miss), which widens TS's narrowing of the post-null-check
    // `ent.classname`. String(classname) matches the exact stringification
    // the `${classname}` template literal above already performs on a
    // (never-in-practice) null value, so this changes no observable
    // behavior -- it only satisfies the Set<string> element type.
    unknownClassnames.add(String(classname));
  }
}

/*
================
G_FindTeams

Chain together all entities with a matching team field.

All but the first will have the FL_TEAMSLAVE flag set.
All but the last will have the teamchain field set to the next one
================
*/

// ROGUE: func_train teams whose master lost FL_TEAMSLAVE (e.g. its
// teamslave-ness was never re-derived after a save/load or a map-hack
// classname swap) get their chain rebuilt here -- called from the tail of
// G_FindTeams below, matching the C source's placement exactly (including
// the duplicated chaining loop; that duplication is in g_spawn.c itself).
export function G_FixTeams(): void {
  let c = 0;
  let c2 = 0;
  for (let i = 1; i < globals.num_edicts; i++) {
    const e = g_edicts[i];
    if (e === undefined || !e.inuse) continue;
    if (e.team === null) continue;
    if (e.classname !== "func_train") continue;
    if ((e.flags & FL_TEAMSLAVE) === 0) continue;

    let chain = e;
    e.teammaster = e;
    e.teamchain = null;
    e.flags &= ~FL_TEAMSLAVE;
    c++;
    c2++;
    for (let j = 1; j < globals.num_edicts; j++) {
      const e2 = g_edicts[j];
      if (e2 === undefined || e2 === e) continue;
      if (!e2.inuse) continue;
      if (e2.team === null) continue;
      if (e.team === e2.team) {
        c2++;
        chain.teamchain = e2;
        e2.teammaster = e;
        e2.teamchain = null;
        chain = e2;
        e2.flags |= FL_TEAMSLAVE;
        e2.movetype = MovetypeT.MOVETYPE_PUSH;
        e2.speed = e.speed;
      }
    }
  }
  gi.dprintf(`${c} teams repaired\n`);
}

export function G_FindTeams(): void {
  let c = 0;
  let c2 = 0;
  for (let i = 1; i < globals.num_edicts; i++) {
    const e = g_edicts[i];
    if (e === undefined || !e.inuse) continue;
    if (e.team === null) continue;
    if ((e.flags & FL_TEAMSLAVE) !== 0) continue;
    let chain = e;
    e.teammaster = e;
    c++;
    c2++;
    for (let j = i + 1; j < globals.num_edicts; j++) {
      const e2 = g_edicts[j];
      if (e2 === undefined || !e2.inuse) continue;
      if (e2.team === null) continue;
      if ((e2.flags & FL_TEAMSLAVE) !== 0) continue;
      if (e.team === e2.team) {
        c2++;
        chain.teamchain = e2;
        e2.teammaster = e;
        chain = e2;
        e2.flags |= FL_TEAMSLAVE;
      }
    }
  }

  // ROGUE
  G_FixTeams();
  // ROGUE

  gi.dprintf(`${c} teams with ${c2} entities\n`);
}

import { SaveClientData } from "./p_client";

/*
==============
SpawnEntities

Creates a server's entity / program execution context by
parsing textual entity definitions out of an ent file.
==============
*/
export function SpawnEntities(mapname: string, entities: string, spawnpoint: string): void {
  let skillLevel = Math.floor(cvarNum(gameCvars.skill));
  if (skillLevel < 0) skillLevel = 0;
  if (skillLevel > 3) skillLevel = 3;
  if (cvarNum(gameCvars.skill) !== skillLevel) {
    gi.cvar_forceset("skill", Com_sprintf("%f", skillLevel));
  }

  SaveClientData();

  // gi.FreeTags(TAG_LEVEL) dropped: no tag-based allocator on this side of
  // the port (see g_main.ts's ShutdownGame comment for the same ruling).

  level.clear();
  for (const e of g_edicts) e.clear();

  // strncpy(level.mapname, mapname, sizeof(level.mapname)-1) /
  // strncpy(game.spawnpoint, spawnpoint, sizeof(game.spawnpoint)-1): both
  // are fixed C buffers (char[MAX_QPATH], char[512] per g_local.h); the
  // truncation is preserved even though JS strings aren't buffer-bound.
  level.mapname = mapname.slice(0, MAX_QPATH - 1);
  game.spawnpoint = spawnpoint.slice(0, 511);

  // set client fields on player ents
  const maxclients = cvarNum(gameCvars.maxclients);
  for (let i = 0; i < maxclients; i++) {
    const target = g_edicts[i + 1];
    if (target !== undefined) target.client = game.clients[i] ?? null;
  }

  let ent: EdictT | null = null;
  let inhibit = 0;

  // Mike's ruling (2026-08-31): "quiet it" -- reset the unknown-field/
  // unknown-classname counters (see the deviation comment above C_atoi) for
  // this map's parse pass before ED_ParseEdict/ED_CallSpawn can add to them.
  unknownFieldKeys.clear();
  unknownClassnames.clear();

  const state: ComParseState = { data: entities, index: 0 };

  // parse ents
  for (;;) {
    // parse the opening brace
    const start = state.index;
    const token = COM_Parse(state);
    if (comParseEOF(state, start, token)) break;
    if (firstChar(token) !== "{") {
      gi.error(`ED_LoadFromFile: found ${token} when expecting {`);
    }

    const current: EdictT = ent === null ? g_edicts[0] : G_Spawn();
    ent = current;
    ED_ParseEdict(state, current);

    // yet another map hack
    if (
      Q_stricmp(level.mapname, "command") === 0 &&
      current.classname !== null &&
      Q_stricmp(current.classname, "trigger_once") === 0 &&
      current.model !== null &&
      Q_stricmp(current.model, "*27") === 0
    ) {
      current.spawnflags &= ~SPAWNFLAG_NOT_HARD;
    }

    // ROGUE -- ahh, the joys of map hacks
    if (
      Q_stricmp(level.mapname, "rhangar2") === 0 &&
      Q_stricmp(current.classname ?? "", "func_door_rotating") === 0 &&
      current.targetname !== null &&
      Q_stricmp(current.targetname, "t265") === 0
    ) {
      current.spawnflags &= ~SPAWNFLAG_NOT_COOP;
    }
    if (
      Q_stricmp(level.mapname, "rhangar2") === 0 &&
      Q_stricmp(current.classname ?? "", "trigger_always") === 0 &&
      current.target !== null &&
      Q_stricmp(current.target, "t265") === 0
    ) {
      current.spawnflags |= SPAWNFLAG_NOT_COOP;
    }
    if (
      Q_stricmp(level.mapname, "rhangar2") === 0 &&
      Q_stricmp(current.classname ?? "", "func_wall") === 0 &&
      Q_stricmp(current.model ?? "", "*15") === 0
    ) {
      current.spawnflags |= SPAWNFLAG_NOT_COOP;
    }
    // rogue

    // remove things (except the world) from different skill levels or deathmatch
    if (current !== g_edicts[0]) {
      if (cvarNum(gameCvars.deathmatch) !== 0) {
        if ((current.spawnflags & SPAWNFLAG_NOT_DEATHMATCH) !== 0) {
          G_FreeEdict(current);
          inhibit++;
          continue;
        }
      } else if (cvarNum(gameCvars.coop) !== 0) {
        // ROGUE: coop-only spawn filtering (absent from baseq2's g_spawn.c)
        if ((current.spawnflags & SPAWNFLAG_NOT_COOP) !== 0) {
          G_FreeEdict(current);
          inhibit++;
          continue;
        }

        // stuff marked !easy & !med & !hard are coop only, all levels
        const notAllDifficulties =
          (current.spawnflags & SPAWNFLAG_NOT_EASY) !== 0 &&
          (current.spawnflags & SPAWNFLAG_NOT_MEDIUM) !== 0 &&
          (current.spawnflags & SPAWNFLAG_NOT_HARD) !== 0;
        if (!notAllDifficulties) {
          const skill = cvarNum(gameCvars.skill);
          if (
            (skill === 0 && (current.spawnflags & SPAWNFLAG_NOT_EASY) !== 0) ||
            (skill === 1 && (current.spawnflags & SPAWNFLAG_NOT_MEDIUM) !== 0) ||
            ((skill === 2 || skill === 3) && (current.spawnflags & SPAWNFLAG_NOT_HARD) !== 0)
          ) {
            G_FreeEdict(current);
            inhibit++;
            continue;
          }
        }
      } else {
        const skill = cvarNum(gameCvars.skill);
        if (
          (skill === 0 && (current.spawnflags & SPAWNFLAG_NOT_EASY) !== 0) ||
          (skill === 1 && (current.spawnflags & SPAWNFLAG_NOT_MEDIUM) !== 0) ||
          ((skill === 2 || skill === 3) && (current.spawnflags & SPAWNFLAG_NOT_HARD) !== 0)
        ) {
          G_FreeEdict(current);
          inhibit++;
          continue;
        }
      }

      current.spawnflags &= ~(
        SPAWNFLAG_NOT_EASY |
        SPAWNFLAG_NOT_MEDIUM |
        SPAWNFLAG_NOT_HARD |
        SPAWNFLAG_NOT_COOP |
        SPAWNFLAG_NOT_DEATHMATCH
      );
    }

    // PGM - do this before calling the spawn function so it can be
    // overridden. rogue/g_local.h defines ROGUE_GRAVITY unconditionally,
    // so this branch is always live (this duplicates the reset
    // ED_CallSpawn itself does -- both are in the C source).
    VectorSet(current.gravityVector, 0, 0, -1);

    ED_CallSpawn(current);

    current.s.renderfx |= RF_IR_VISIBLE; // PGM
  }

  gi.dprintf(`${inhibit} entities inhibited\n`);

  // Mike's ruling (2026-08-31): "quiet it" -- see the deviation comment on
  // unknownFieldKeys/developerMode above C_atoi. developer 0 rolls up every
  // "<field> is not a field" / "<classname> doesn't have a spawn function"
  // ED_ParseField/ED_CallSpawn suppressed during this parse pass into one
  // line; developer 1 already printed each one and skips this line entirely
  // (byte-identical to vanilla otherwise).
  if (!developerMode()) {
    gi.dprintf(
      `SpawnEntities: ${unknownFieldKeys.size} unknown fields, ${unknownClassnames.size} unknown classnames suppressed (developer 1 for detail)\n`,
    );
  }

  // #ifdef DEBUG entity-validity scan dropped per PORTING.md's #ifdef
  // ruling (portable path only; Com_DPrintf sanity check, not behavior).

  G_FindTeams();

  PlayerTrail_Init();

  // ROGUE
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    if (gameCvars.randomrespawn !== null && gameCvars.randomrespawn.value !== 0) {
      PrecacheForRandomRespawn();
    }
  } else {
    InitHintPaths(); // if there aren't hintpaths on this map, enable quick aborts
  }
  // ROGUE

  // ROGUE -- allow dm games to do init stuff right before game starts.
  if (
    cvarNum(gameCvars.deathmatch) !== 0 &&
    gameCvars.gamerules !== null &&
    gameCvars.gamerules.value !== 0
  ) {
    if (DMGame.PostInitSetup !== null) DMGame.PostInitSetup();
  }
  // ROGUE
}

//===================================================================

const single_statusbar =
  "yb\t-24 " +
  // health
  "xv\t0 " +
  "hnum " +
  "xv\t50 " +
  "pic 0 " +
  // ammo
  "if 2 " +
  "\txv\t100 " +
  "\tanum " +
  "\txv\t150 " +
  "\tpic 2 " +
  "endif " +
  // armor
  "if 4 " +
  "\txv\t200 " +
  "\trnum " +
  "\txv\t250 " +
  "\tpic 4 " +
  "endif " +
  // selected item
  "if 6 " +
  "\txv\t296 " +
  "\tpic 6 " +
  "endif " +
  "yb\t-50 " +
  // picked up item
  "if 7 " +
  "\txv\t0 " +
  "\tpic 7 " +
  "\txv\t26 " +
  "\tyb\t-42 " +
  "\tstat_string 8 " +
  "\tyb\t-50 " +
  "endif " +
  // timer
  "if 9 " +
  "\txv\t262 " +
  "\tnum\t2\t10 " +
  "\txv\t296 " +
  "\tpic\t9 " +
  "endif " +
  //  help / weapon icon
  "if 11 " +
  "\txv\t148 " +
  "\tpic\t11 " +
  "endif ";

const dm_statusbar =
  "yb\t-24 " +
  // health
  "xv\t0 " +
  "hnum " +
  "xv\t50 " +
  "pic 0 " +
  // ammo
  "if 2 " +
  "\txv\t100 " +
  "\tanum " +
  "\txv\t150 " +
  "\tpic 2 " +
  "endif " +
  // armor
  "if 4 " +
  "\txv\t200 " +
  "\trnum " +
  "\txv\t250 " +
  "\tpic 4 " +
  "endif " +
  // selected item
  "if 6 " +
  "\txv\t296 " +
  "\tpic 6 " +
  "endif " +
  "yb\t-50 " +
  // picked up item
  "if 7 " +
  "\txv\t0 " +
  "\tpic 7 " +
  "\txv\t26 " +
  "\tyb\t-42 " +
  "\tstat_string 8 " +
  "\tyb\t-50 " +
  "endif " +
  // timer
  "if 9 " +
  "\txv\t246 " +
  "\tnum\t2\t10 " +
  "\txv\t296 " +
  "\tpic\t9 " +
  "endif " +
  //  help / weapon icon
  "if 11 " +
  "\txv\t148 " +
  "\tpic\t11 " +
  "endif " +
  //  frags
  "xr\t-50 " +
  "yt 2 " +
  "num 3 14 " +
  // spectator
  "if 17 " +
  'xv 0 yb -58 string2 "SPECTATOR MODE" ' +
  "endif " +
  // chase camera
  "if 16 " +
  'xv 0 yb -68 string "Chasing" xv 64 stat_string 16 ' +
  "endif ";

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
  ent.s.modelindex = 1; // world model is always index 1

  //---------------

  // reserve some spots for dead player bodies for coop / deathmatch
  InitBodyQue();

  // set configstrings for items
  SetItemNames();

  if (st.nextmap !== null) level.nextmap = st.nextmap;

  // make some data visible to the server

  if (ent.message !== null && ent.message.length > 0) {
    gi.configstring(CS_NAME, ent.message);
    level.level_name = ent.message;
  } else {
    level.level_name = level.mapname;
  }

  if (st.sky !== null && st.sky.length > 0) {
    gi.configstring(CS_SKY, st.sky);
  } else {
    gi.configstring(CS_SKY, "unit1_");
  }

  gi.configstring(CS_SKYROTATE, Com_sprintf("%f", st.skyrotate));

  gi.configstring(CS_SKYAXIS, Com_sprintf("%f %f %f", st.skyaxis[0], st.skyaxis[1], st.skyaxis[2]));

  gi.configstring(CS_CDTRACK, Com_sprintf("%i", ent.sounds));

  gi.configstring(CS_MAXCLIENTS, Com_sprintf("%i", cvarNum(gameCvars.maxclients) | 0));

  // status bar program
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    gi.configstring(CS_STATUSBAR, dm_statusbar);
  } else {
    gi.configstring(CS_STATUSBAR, single_statusbar);
  }

  //---------------

  // help icon for statusbar
  gi.imageindex("i_help");
  level.pic_health = gi.imageindex("i_health");
  gi.imageindex("help");
  gi.imageindex("field_3");

  if (st.gravity === null) {
    gi.cvar_set("sv_gravity", "800");
  } else {
    gi.cvar_set("sv_gravity", st.gravity);
  }

  gameIndices.snd_fry = gi.soundindex("player/fry.wav"); // standing in lava / slime

  PrecacheItem(FindItem("Blaster"));

  gi.soundindex("player/lava1.wav");
  gi.soundindex("player/lava2.wav");

  gi.soundindex("misc/pc_up.wav");
  gi.soundindex("misc/talk1.wav");

  gi.soundindex("misc/udeath.wav");

  // gibs
  gi.soundindex("items/respawn1.wav");

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

  // ROGUE -- double damage
  gi.soundindex("misc/ddamage1.wav");
  // rogue

  // sexed models
  // THIS ORDER MUST MATCH THE DEFINES IN g_local.h
  // you can add more, max 19 (pete change)
  // these models are only loaded in coop or deathmatch. not singleplayer.
  if (cvarNum(gameCvars.coop) !== 0 || cvarNum(gameCvars.deathmatch) !== 0) {
    gi.modelindex("#w_blaster.md2");
    gi.modelindex("#w_shotgun.md2");
    gi.modelindex("#w_sshotgun.md2");
    gi.modelindex("#w_machinegun.md2");
    gi.modelindex("#w_chaingun.md2");
    gi.modelindex("#a_grenades.md2");
    gi.modelindex("#w_glauncher.md2");
    gi.modelindex("#w_rlauncher.md2");
    gi.modelindex("#w_hyperblaster.md2");
    gi.modelindex("#w_railgun.md2");
    gi.modelindex("#w_bfg.md2");

    gi.modelindex("#w_disrupt.md2"); // PGM
    gi.modelindex("#w_etfrifle.md2"); // PGM
    gi.modelindex("#w_plasma.md2"); // PGM
    gi.modelindex("#w_plauncher.md2"); // PGM
    gi.modelindex("#w_chainfist.md2"); // PGM
  }

  //-------------------

  gi.soundindex("player/gasp1.wav"); // gasping for air
  gi.soundindex("player/gasp2.wav"); // head breaking surface, not gasping

  gi.soundindex("player/watr_in.wav"); // feet hitting water
  gi.soundindex("player/watr_out.wav"); // feet leaving water

  gi.soundindex("player/watr_un.wav"); // head going underwater

  gi.soundindex("player/u_breath1.wav");
  gi.soundindex("player/u_breath2.wav");

  gi.soundindex("items/pkup.wav"); // bonus item pickup
  gi.soundindex("world/land.wav"); // landing thud
  gi.soundindex("misc/h2ohit1.wav"); // landing splash

  gi.soundindex("items/damage.wav");
  gi.soundindex("items/protect.wav");
  gi.soundindex("items/protect4.wav");
  gi.soundindex("weapons/noammo.wav");

  gi.soundindex("infantry/inflies1.wav");

  gameIndices.sm_meat_index = gi.modelindex("models/objects/gibs/sm_meat/tris.md2");
  gi.modelindex("models/objects/gibs/arm/tris.md2");
  gi.modelindex("models/objects/gibs/bone/tris.md2");
  gi.modelindex("models/objects/gibs/bone2/tris.md2");
  gi.modelindex("models/objects/gibs/chest/tris.md2");
  gi.modelindex("models/objects/gibs/skull/tris.md2");
  gi.modelindex("models/objects/gibs/head2/tris.md2");

  //
  // Setup light animation tables. 'a' is total darkness, 'z' is doublebright.
  //

  // 0 normal
  gi.configstring(CS_LIGHTS + 0, "m");

  // 1 FLICKER (first variety)
  gi.configstring(CS_LIGHTS + 1, "mmnmmommommnonmmonqnmmo");

  // 2 SLOW STRONG PULSE
  gi.configstring(CS_LIGHTS + 2, "abcdefghijklmnopqrstuvwxyzyxwvutsrqponmlkjihgfedcba");

  // 3 CANDLE (first variety)
  gi.configstring(CS_LIGHTS + 3, "mmmmmaaaaammmmmaaaaaabcdefgabcdefg");

  // 4 FAST STROBE
  gi.configstring(CS_LIGHTS + 4, "mamamamamama");

  // 5 GENTLE PULSE 1
  gi.configstring(CS_LIGHTS + 5, "jklmnopqrstuvwxyzyxwvutsrqponmlkj");

  // 6 FLICKER (second variety)
  gi.configstring(CS_LIGHTS + 6, "nmonqnmomnmomomno");

  // 7 CANDLE (second variety)
  gi.configstring(CS_LIGHTS + 7, "mmmaaaabcdefgmmmmaaaammmaamm");

  // 8 CANDLE (third variety)
  gi.configstring(CS_LIGHTS + 8, "mmmaaammmaaammmabcdefaaaammmmabcdefmmmaaaa");

  // 9 SLOW STROBE (fourth variety)
  gi.configstring(CS_LIGHTS + 9, "aaaaaaaazzzzzzzz");

  // 10 FLUORESCENT FLICKER
  gi.configstring(CS_LIGHTS + 10, "mmamammmmammamamaaamammma");

  // 11 SLOW PULSE NOT FADE TO BLACK
  gi.configstring(CS_LIGHTS + 11, "abcdefghijklmnopqrrqponmlkjihgfedcba");

  // styles 32-62 are assigned by the light program for switchable lights

  // 63 testing
  gi.configstring(CS_LIGHTS + 63, "a");
}

//===================================================================
// ROGUE -- monster-spawning helpers, used by the carrier/medic_commander/
// black widow (RG-monsters' SCOPE). See the C's own block comment: the
// sequence to create a flying monster is FindSpawnPoint then
// CreateFlyMonster; for a ground monster, FindSpawnPoint then
// CreateGroundMonster.
//===================================================================

/*
CreateMonster
*/
export function CreateMonster(origin: Vec3, angles: Vec3, classname: string): EdictT {
  const newEnt = G_Spawn();

  VectorCopy(origin, newEnt.s.origin);
  VectorCopy(angles, newEnt.s.angles);
  newEnt.classname = ED_NewString(classname);
  newEnt.monsterinfo.aiflags |= AI_DO_NOT_COUNT;

  VectorSet(newEnt.gravityVector, 0, 0, -1);
  ED_CallSpawn(newEnt);
  newEnt.s.renderfx |= RF_IR_VISIBLE;

  return newEnt;
}

export function CreateFlyMonster(origin: Vec3, angles: Vec3, mins: Vec3, maxs: Vec3, classname: string): EdictT | null {
  if (VectorCompare(mins, vec3_origin) !== 0 || VectorCompare(maxs, vec3_origin) !== 0) {
    DetermineBBox(classname, mins, maxs);
  }

  if (!CheckSpawnPoint(origin, mins, maxs)) return null;

  return CreateMonster(origin, angles, classname);
}

// This is just a wrapper for CreateMonster that looks down height # of CMUs
// and sees if there are bad things down there or not
//
// this is from m_move.c
const STEPSIZE = 18;

export function CreateGroundMonster(
  origin: Vec3,
  angles: Vec3,
  entMins: Vec3,
  entMaxs: Vec3,
  classname: string,
  height: number,
): EdictT | null {
  let mins = entMins;
  let maxs = entMaxs;

  // if they don't provide us a bounding box, figure it out
  if (VectorCompare(entMins, vec3_origin) !== 0 || VectorCompare(entMaxs, vec3_origin) !== 0) {
    mins = vec3();
    maxs = vec3();
    DetermineBBox(classname, mins, maxs);
  }

  // check the ground to make sure it's there, it's relatively flat, and it's not toxic
  if (!CheckGroundSpawnPoint(origin, mins, maxs, height, -1)) return null;

  return CreateMonster(origin, angles, classname);
}

// FindSpawnPoint
// PMM - this is used by the medic commander (possibly by the carrier) to
// find a good spawn point if the startpoint is bad, try above the
// startpoint for a bit
export function FindSpawnPoint(startpoint: Vec3, mins: Vec3, maxs: Vec3, spawnpoint: Vec3, maxMoveUp: number): boolean {
  const tr = gi.trace(startpoint, mins, maxs, startpoint, null, MASK_MONSTERSOLID | CONTENTS_PLAYERCLIP);
  if (tr.startsolid || tr.allsolid || tr.ent !== world()) {
    const top = vec3();
    VectorCopy(startpoint, top);
    top[2] += maxMoveUp;

    const tr2 = gi.trace(top, mins, maxs, startpoint, null, MASK_MONSTERSOLID);
    if (tr2.startsolid || tr2.allsolid) {
      return false;
    }
    VectorCopy(tr2.endpos, spawnpoint);
    return true;
  }
  VectorCopy(startpoint, spawnpoint);
  return true;
}

// FIXME - all of this needs to be tweaked to handle the new gravity rules
// if we ever want to spawn stuff on the roof

// CheckSpawnPoint
// PMM - checks volume to make sure we can spawn a monster there (is it
// solid?) This is all fliers should need
export function CheckSpawnPoint(origin: Vec3, mins: Vec3, maxs: Vec3): boolean {
  if (VectorCompare(mins, vec3_origin) !== 0 || VectorCompare(maxs, vec3_origin) !== 0) {
    return false;
  }

  const tr = gi.trace(origin, mins, maxs, origin, null, MASK_MONSTERSOLID);
  if (tr.startsolid || tr.allsolid) {
    return false;
  }
  if (tr.ent !== world()) {
    return false;
  }
  return true;
}

// CheckGroundSpawnPoint
// PMM - used for walking monsters: is there a ground within the specified
// height of the origin, is the ground non-water, and is the ground flat
// enough to walk on?
export function CheckGroundSpawnPoint(
  origin: Vec3,
  entMins: Vec3,
  entMaxs: Vec3,
  height: number,
  gravity: number,
): boolean {
  if (!CheckSpawnPoint(origin, entMins, entMaxs)) return false;

  // FIXME - this is too conservative about angled surfaces
  const stop = vec3();
  VectorCopy(origin, stop);
  // FIXME - gravity vector
  stop[2] = origin[2] + entMins[2] - height;

  let tr = gi.trace(origin, entMins, entMaxs, stop, null, MASK_MONSTERSOLID | MASK_WATER);
  // it's not going to be all solid or start solid, since that's checked above

  if (tr.fraction < 1 && (tr.contents & MASK_MONSTERSOLID) !== 0) {
    // we found a non-water surface down there somewhere. now we need to
    // check to make sure it's not too sloped -- algorithm straight out of
    // m_move.c:M_CheckBottom()

    // first, do the midpoint trace
    const mins = vec3();
    const maxs = vec3();
    VectorAdd(tr.endpos, entMins, mins);
    VectorAdd(tr.endpos, entMaxs, maxs);

    // first, do the easy flat check
    const start = vec3();
    // FIXME - this will only handle 0,0,1 and 0,0,-1 gravity vectors
    if (gravity > 0) {
      start[2] = maxs[2] + 1;
    } else {
      start[2] = mins[2] - 1;
    }

    let allSolid = true;
    for (let x = 0; x <= 1 && allSolid; x++) {
      for (let y = 0; y <= 1 && allSolid; y++) {
        start[0] = x !== 0 ? maxs[0] : mins[0];
        start[1] = y !== 0 ? maxs[1] : mins[1];
        if (gi.pointcontents(start) !== CONTENTS_SOLID) allSolid = false;
      }
    }
    if (allSolid) {
      // if it passed all four above checks, we're done
      return true;
    }

    // check it for real
    const start2 = vec3();
    const stop2 = vec3();
    start2[0] = stop2[0] = (mins[0] + maxs[0]) * 0.5;
    start2[1] = stop2[1] = (mins[1] + maxs[1]) * 0.5;
    start2[2] = mins[2];

    tr = gi.trace(start2, vec3_origin, vec3_origin, stop2, null, MASK_MONSTERSOLID);

    if (tr.fraction === 1) return false;
    let mid: number;
    let bottom: number;

    if (gravity < 0) {
      start2[2] = mins[2];
      stop2[2] = start2[2] - STEPSIZE - STEPSIZE;
      mid = bottom = tr.endpos[2] + entMins[2];
    } else {
      start2[2] = maxs[2];
      stop2[2] = start2[2] + STEPSIZE + STEPSIZE;
      mid = bottom = tr.endpos[2] - entMaxs[2];
    }

    for (let x = 0; x <= 1; x++) {
      for (let y = 0; y <= 1; y++) {
        start2[0] = stop2[0] = x !== 0 ? maxs[0] : mins[0];
        start2[1] = stop2[1] = y !== 0 ? maxs[1] : mins[1];

        tr = gi.trace(start2, vec3_origin, vec3_origin, stop2, null, MASK_MONSTERSOLID);

        // PGM
        // FIXME - this will only handle 0,0,1 and 0,0,-1 gravity vectors
        if (gravity > 0) {
          if (tr.fraction !== 1 && tr.endpos[2] < bottom) bottom = tr.endpos[2];
          if (tr.fraction === 1 || tr.endpos[2] - mid > STEPSIZE) {
            return false;
          }
        } else {
          if (tr.fraction !== 1 && tr.endpos[2] > bottom) bottom = tr.endpos[2];
          if (tr.fraction === 1 || mid - tr.endpos[2] > STEPSIZE) {
            return false;
          }
        }
      }
    }

    return true; // we can land on it, it's ok
  }

  // otherwise, it's either water (bad) or not there (too far)
  return false;
}

export function DetermineBBox(classname: string, mins: Vec3, maxs: Vec3): void {
  // FIXME - cache this stuff
  const newEnt = G_Spawn();

  VectorCopy(vec3_origin, newEnt.s.origin);
  VectorCopy(vec3_origin, newEnt.s.angles);
  newEnt.classname = ED_NewString(classname);
  newEnt.monsterinfo.aiflags |= AI_DO_NOT_COUNT;

  ED_CallSpawn(newEnt);

  VectorCopy(newEnt.mins, mins);
  VectorCopy(newEnt.maxs, maxs);

  G_FreeEdict(newEnt);
}

// ****************************
// SPAWNGROW stuff
// ****************************

const SPAWNGROW_LIFESPAN = 0.3;

function spawngrow_think(self: EdictT): void {
  for (let i = 0; i < 2; i++) {
    self.s.angles[0] = Math.floor(random() * 360);
    self.s.angles[1] = Math.floor(random() * 360);
    self.s.angles[2] = Math.floor(random() * 360);
  }
  if (level.time < self.wait && self.s.frame < 2) self.s.frame++;
  if (level.time >= self.wait) {
    if ((self.s.effects & EF_SPHERETRANS) !== 0) {
      G_FreeEdict(self);
      return;
    } else if (self.s.frame > 0) {
      self.s.frame--;
    } else {
      G_FreeEdict(self);
      return;
    }
  }
  self.nextthink += FRAMETIME;
}

export function SpawnGrow_Spawn(startpos: Vec3, size: number): void {
  const ent = G_Spawn();
  VectorCopy(startpos, ent.s.origin);
  for (let i = 0; i < 2; i++) {
    ent.s.angles[0] = Math.floor(random() * 360);
    ent.s.angles[1] = Math.floor(random() * 360);
    ent.s.angles[2] = Math.floor(random() * 360);
  }
  ent.solid = SolidT.SOLID_NOT;
  ent.s.renderfx = RF_IR_VISIBLE;
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.classname = "spawngro";

  let lifespan: number;
  if (size <= 1) {
    lifespan = SPAWNGROW_LIFESPAN;
    ent.s.modelindex = gi.modelindex("models/items/spawngro2/tris.md2");
  } else if (size === 2) {
    ent.s.modelindex = gi.modelindex("models/items/spawngro3/tris.md2");
    lifespan = 2;
  } else {
    ent.s.modelindex = gi.modelindex("models/items/spawngro/tris.md2");
    lifespan = SPAWNGROW_LIFESPAN;
  }

  ent.think = spawngrow_think;

  ent.wait = level.time + lifespan;
  ent.nextthink = level.time + FRAMETIME;
  if (size !== 2) ent.s.effects |= EF_SPHERETRANS;
  gi.linkentity(ent);
}

// ****************************
// WidowLeg stuff
// ****************************

const MAX_LEGSFRAME = 23;
const LEG_WAIT_TIME = 1;

function widowlegs_think(self: EdictT): void {
  const point = vec3();

  if (self.s.frame === 17) {
    const offset = vec3(11.77, -7.24, 23.31);
    const f = vec3();
    const r = vec3();
    const u = vec3();
    AngleVectors(self.s.angles, f, r, u);
    G_ProjectSource2(self.s.origin, offset, f, r, u, point);
    gi.WriteByte(svc_temp_entity);
    gi.WriteByte(TempEventT.TE_EXPLOSION1);
    gi.WritePosition(point);
    gi.multicast(point, MulticastT.MULTICAST_ALL);
    ThrowSmallStuff(self, point);
  }

  if (self.s.frame < MAX_LEGSFRAME) {
    self.s.frame++;
    self.nextthink = level.time + FRAMETIME;
    return;
  } else if (self.wait === 0) {
    self.wait = level.time + LEG_WAIT_TIME;
  }
  if (level.time > self.wait) {
    const f = vec3();
    const r = vec3();
    const u = vec3();
    AngleVectors(self.s.angles, f, r, u);

    const offset1 = vec3(-65.6, -8.44, 28.59);
    G_ProjectSource2(self.s.origin, offset1, f, r, u, point);
    gi.WriteByte(svc_temp_entity);
    gi.WriteByte(TempEventT.TE_EXPLOSION1);
    gi.WritePosition(point);
    gi.multicast(point, MulticastT.MULTICAST_ALL);
    ThrowSmallStuff(self, point);

    ThrowWidowGibSized(
      self,
      "models/monsters/blackwidow/gib1/tris.md2",
      80 + Math.floor(random() * 20.0),
      GIB_METALLIC,
      point,
      0,
      true,
    );
    ThrowWidowGibSized(
      self,
      "models/monsters/blackwidow/gib2/tris.md2",
      80 + Math.floor(random() * 20.0),
      GIB_METALLIC,
      point,
      0,
      true,
    );

    const offset2 = vec3(-1.04, -51.18, 7.04);
    G_ProjectSource2(self.s.origin, offset2, f, r, u, point);
    gi.WriteByte(svc_temp_entity);
    gi.WriteByte(TempEventT.TE_EXPLOSION1);
    gi.WritePosition(point);
    gi.multicast(point, MulticastT.MULTICAST_ALL);
    ThrowSmallStuff(self, point);

    ThrowWidowGibSized(
      self,
      "models/monsters/blackwidow/gib1/tris.md2",
      80 + Math.floor(random() * 20.0),
      GIB_METALLIC,
      point,
      0,
      true,
    );
    ThrowWidowGibSized(
      self,
      "models/monsters/blackwidow/gib2/tris.md2",
      80 + Math.floor(random() * 20.0),
      GIB_METALLIC,
      point,
      0,
      true,
    );
    ThrowWidowGibSized(
      self,
      "models/monsters/blackwidow/gib3/tris.md2",
      80 + Math.floor(random() * 20.0),
      GIB_METALLIC,
      point,
      0,
      true,
    );

    G_FreeEdict(self);
    return;
  }
  if (level.time > self.wait - 0.5 && self.count === 0) {
    self.count = 1;
    const f = vec3();
    const r = vec3();
    const u = vec3();
    AngleVectors(self.s.angles, f, r, u);

    const offset1 = vec3(31, -88.7, 10.96);
    G_ProjectSource2(self.s.origin, offset1, f, r, u, point);
    gi.WriteByte(svc_temp_entity);
    gi.WriteByte(TempEventT.TE_EXPLOSION1);
    gi.WritePosition(point);
    gi.multicast(point, MulticastT.MULTICAST_ALL);

    const offset2 = vec3(-12.67, -4.39, 15.68);
    G_ProjectSource2(self.s.origin, offset2, f, r, u, point);
    gi.WriteByte(svc_temp_entity);
    gi.WriteByte(TempEventT.TE_EXPLOSION1);
    gi.WritePosition(point);
    gi.multicast(point, MulticastT.MULTICAST_ALL);

    self.nextthink = level.time + FRAMETIME;
    return;
  }
  self.nextthink = level.time + FRAMETIME;
}

export function Widowlegs_Spawn(startpos: Vec3, angles: Vec3): void {
  const ent = G_Spawn();
  VectorCopy(startpos, ent.s.origin);
  VectorCopy(angles, ent.s.angles);
  ent.solid = SolidT.SOLID_NOT;
  ent.s.renderfx = RF_IR_VISIBLE;
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.classname = "widowlegs";

  ent.s.modelindex = gi.modelindex("models/monsters/legs/tris.md2");
  ent.think = widowlegs_think;

  ent.nextthink = level.time + FRAMETIME;
  gi.linkentity(ent);
}
