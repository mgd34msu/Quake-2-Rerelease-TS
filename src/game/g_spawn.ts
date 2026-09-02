// g_spawn.c

import { COM_Parse, type ComParseState, vec3, type Vec3, VectorCopy, VectorSet } from "../shared/math";
import {
  Com_sprintf,
  CS_CDTRACK,
  CS_LIGHTS,
  CS_MAXCLIENTS,
  CS_NAME,
  CS_SKY,
  CS_SKYAXIS,
  CS_SKYROTATE,
  CS_STATUSBAR,
  MAX_QPATH,
  Q_stricmp,
} from "../shared/q_shared";
import {
  type EdictT,
  FL_GODMODE,
  FL_NOTARGET,
  FL_POWER_ARMOR,
  FL_TEAMSLAVE,
  g_edicts,
  game,
  gameCvars,
  gameIndices,
  gi,
  globals,
  level,
  MovetypeT,
  SPAWNFLAG_COOP_ONLY,
  SPAWNFLAG_NOT_COOP,
  SPAWNFLAG_NOT_DEATHMATCH,
  SPAWNFLAG_NOT_EASY,
  SPAWNFLAG_NOT_HARD,
  SPAWNFLAG_NOT_MEDIUM,
  st,
} from "./g_local";
import { SolidT } from "./game";
import { FIELDS } from "./g_save";
import { G_FreeEdict, G_Spawn } from "./g_utils";
import { FindItem, itemlist, PrecacheItem, SetItemNames, SpawnItem } from "./g_items";
import { InitBodyQue } from "./p_client";
import { PlayerTrail_Init } from "./p_trail";

// SP_ functions from every sibling module g_spawn.c's spawns[] table lists.
import {
  SP_item_health,
  SP_item_health_large,
  SP_item_health_mega,
  SP_item_health_small,
} from "./g_items";
import {
  SP_info_player_coop,
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
import { SP_turret_base, SP_turret_breach, SP_turret_driver } from "./g_turret";
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
import { SP_monster_flyer } from "./m_flyer";
import { SP_monster_brain } from "./m_brain";
import { SP_monster_floater } from "./m_float";
import { SP_monster_hover } from "./m_hover";
import { SP_monster_mutant } from "./m_mutant";
import { SP_monster_supertank } from "./m_supertank";
import { SP_monster_boss2 } from "./m_boss2";
import { SP_monster_boss3_stand } from "./m_boss3";
import { SP_monster_jorg } from "./m_boss31";
import { SP_monster_makron } from "./m_boss32";

// >>> RERELEASE CONTENT PORT: spawn-function imports (generated) >>>
// The rerelease content set this module now spawns. Every symbol below is a
// real SP_ function in this same src/game/ tree, ported from our own
// src/rogue/, src/xatrix/, src/ctf/ and src/kexgame/ modules. Grouped by
// defining file and kept in one block so the vanilla 3.21 import list above
// stays exactly as it was.
import { SP_dm_tag_token } from "./dm_tag";
import { SP_info_player_team1, SP_info_player_team2, SP_misc_ctf_banner, SP_misc_ctf_small_banner } from "./g_ctf";
import { G_ResetShadowLights, setup_shadow_lights, SP_dynamic_light, SP_func_animation, SP_info_landmark, SP_info_world_text, SP_misc_flare, SP_misc_hologram, SP_misc_lavaball, SP_misc_model, SP_misc_player_mannequin } from "./g_kexmisc";
import { SP_target_achievement, SP_target_autosave, SP_target_camera, SP_target_crossunit_target, SP_target_crossunit_trigger, SP_target_gravity, SP_target_healthbar, SP_target_light, SP_target_music, SP_target_poi, SP_target_sky, SP_target_soundfx, SP_target_story } from "./g_kextarg";
import { SP_func_eye, SP_info_nav_lock, SP_trigger_coop_relay, SP_trigger_flashlight, SP_trigger_fog, SP_trigger_health_relay } from "./g_kextrig";
import { SP_func_plat2, SP_object_repair, SP_rotating_light } from "./g_newfnc";
import { SP_hint_path, SP_info_player_coop_lava, SP_misc_amb4, SP_misc_nuke, SP_misc_nuke_core, SP_misc_transport, SP_misc_viper_missile } from "./g_newmisc";
import { SP_target_anger, SP_target_blacklight, SP_target_killplayers, SP_target_mal_laser, SP_target_orb, SP_target_steam } from "./g_newtarg";
import { SP_info_teleport_destination, SP_trigger_disguise, SP_trigger_teleport } from "./g_newtrig";
import { SP_turret_invisible_brain } from "./g_turret";
import { SP_monster_arachnid } from "./m_arachnid";
import { SP_monster_boss5 } from "./m_boss5";
import { SP_monster_carrier } from "./m_carrier";
import { SP_monster_chick_heat } from "./m_chick";
import { SP_monster_fixbot } from "./m_fixbot";
import { SP_monster_gekk } from "./m_gekk";
import { SP_monster_gladb } from "./m_gladb";
import { SP_monster_guncmdr } from "./m_guncmdr";
import { SP_monster_shambler } from "./m_shambler";
import { SP_monster_soldier_hypergun, SP_monster_soldier_lasergun, SP_monster_soldier_ripper } from "./m_soldier";
import { SP_monster_stalker } from "./m_stalker";
import { SP_monster_tank_stand } from "./m_tank";
import { SP_monster_turret } from "./m_turret";
import { SP_monster_widow } from "./m_widow";
import { SP_monster_widow2 } from "./m_widow2";
// <<< RERELEASE CONTENT PORT: spawn-function imports <<<

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
// FieldSpawn type it's typed with) now lives in src/game/g_save.ts and is
// imported here; ED_ParseField's behavior is unchanged.

// Unknown-field / unknown-classname spawn noise, gated behind the
// "developer" cvar. Mike's ruling (2026-08-31): "quiet it" -- see
// .orch/followups.md finding 14: the LEGACY game family is a frozen
// v3.19/v3.20/v3.21 game DLL, and it dprintfs "<field> is not a field" /
// "<classname> doesn't have a spawn function" for every KEX-era key/entity
// a rerelease-authored map carries (fog_*, shadowlight*, mangle,
// mapversion, dynamic_light, info_landmark, target_poi, ...). That per-line
// output is faithful -- a real 3.21 game DLL prints exactly this when fed
// KEX-era entities -- but at developer 0 it is hundreds of lines of
// unusable console flooding on rerelease data. Both message classes are
// counted instead of printed and rolled into one summary line at spawn
// completion (see SpawnEntities below); developer 1 restores the
// byte-identical vanilla per-line output. This is a LEGACY-module-only
// deviation: src/kexgame/g_spawn.ts knows every KEX field and classname
// and has no such spam to gate, so it is untouched. Not added to
// gameCvars (g_local.ts) because that table mirrors only the cvar_t*
// externs the real game DLL declares in g_local.h/game.h, and vanilla has
// no such extern -- resolved dynamically here instead.
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

// RERELEASE CONTENT PORT: `rgba` packs four colour components into
// s.skinnum. Ported from src/kexgame/g_spawn.ts's ED_LoadColor: components
// may be written either as 0..1 floats or as 0..255 bytes -- if every one
// of the four is <= 1.0 the value is taken as float and scaled by 255 --
// and the result is packed r,g,b,a most-significant-first as a SIGNED
// int32 (an r of 255 makes the packed value negative), matching the C++
// int32_t return exactly. A bare integer with no spaces is passed through.
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
    return (a | (b << 8) | (g << 16) | (r << 24)) | 0;
  }
  return C_atoi(value);
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

    // RERELEASE CONTENT PORT: this switch used to assume every non-"edict"
    // target was "spawntemp", because vanilla's fields[] only ever had
    // those two (plus "edict_s" for origin/angles). The rerelease key set
    // also writes onto monsterinfo, onto the fog/heightfog/bmodel_anim
    // sub-structs, and onto numeric entity_state_t members, so each type
    // case now dispatches on the target explicitly. Vanilla's own rows
    // take exactly the same paths they always did.
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
        else if (f.target === "spawntemp") st[f.prop] = n;
        else if (f.target === "edict_s") ent.s[f.prop] = n;
        else if (f.target === "monsterinfo") ent.monsterinfo[f.prop] = n;
        else {
          ent.bmodel_anim[f.prop] = n;
          // kexgame/g_spawn.ts:860-869: the start/end keys are what arm the
          // animation -- their loaders set `bmodel_anim.enabled = true`.
          // Without this every func_animation freed itself at spawn with
          // "has no animation data" (g_kexmisc.ts) under the classic module.
          if (f.prop === "start" || f.prop === "end") ent.bmodel_anim.enabled = true;
        }
        break;
      }
      case "F_FLOAT": {
        const n = C_atof(value);
        if (f.target === "edict") ent[f.prop] = n;
        else if (f.target === "spawntemp") st[f.prop] = n;
        else if (f.target === "edict_s") ent.s[f.prop] = n;
        else if (f.target === "monsterinfo") ent.monsterinfo[f.prop] = n;
        else if (f.target === "fog") ent.fog[f.prop] = n;
        else ent.heightfog[f.prop] = n;
        break;
      }
      case "F_BOOL": {
        // kexgame/g_spawn.ts parses these with `C_atoi(v) !== 0`.
        ent.bmodel_anim[f.prop] = C_atoi(value) !== 0;
        break;
      }
      case "F_COLOR": {
        ent.s[f.prop] = ED_LoadColor(value);
        break;
      }
      case "F_VECTOR": {
        const vec = parseVector3(value);
        const dest =
          f.target === "edict"
            ? ent[f.prop]
            : f.target === "spawntemp"
              ? st[f.prop]
              : f.target === "edict_s"
                ? ent.s[f.prop]
                : f.target === "fog"
                  ? ent.fog[f.prop]
                  : ent.heightfog[f.prop];
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
    if (firstChar(keyname) === "_") {
      // ...EXCEPT `_color` on a WIDE session. The rerelease parser carves
      // this one key out of the underscore rule (src/kexgame/g_spawn.ts:979,
      // `if (keyname === "_color") ent.s.skinnum = ED_LoadColor(value)`)
      // because it is how a map tints a shadow light: cl_fx.ts's
      // unpackShadowLightColor reads the light entity's skinnum, and base1's
      // 37 dynamic_lights carry their color in nothing but `_color`. Without
      // this, every one of them would come out white.
      //
      // Gated on the layout, not just on the classname, for the same reason
      // everything else in this change is: a narrow (1997-data) session must
      // stay byte-for-byte what it was, and vanilla 3.21 really does discard
      // `_color` on every entity. Widening only ever happens for content the
      // classic wire cannot carry (sv_init.ts's SV_ContentNeedsWideLayout),
      // so this can never fire on a 1997 map.
      if (keyname === "_color" && gi.extended_layout?.() === true) ent.s.skinnum = ED_LoadColor(valToken);
      continue;
    }

    ED_ParseField(keyname, valToken, ent);
  }

  if (!init) ent.clear();
}

//===================================================================
// spawns[]
//===================================================================

interface SpawnT {
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
  // RERELEASE CONTENT PORT: vanilla 3.21's spawns[] table has no
  // monster_makron row -- in the original game Makron is never placed by a
  // mapper, he is spawned in code by MakronSpawn() when Jorg dies at the
  // end of boss2. The rerelease campaigns DO place monster_makron directly
  // in the .bsp, so the already-present SP_monster_makron (m_boss32.ts,
  // ported long before this task) just needed registering here.
  { name: "monster_makron", spawn: SP_monster_makron },

  { name: "monster_commander_body", spawn: SP_monster_commander_body },

  { name: "turret_breach", spawn: SP_turret_breach },
  { name: "turret_base", spawn: SP_turret_base },
  { name: "turret_driver", spawn: SP_turret_driver },

  // >>> RERELEASE CONTENT PORT: spawn table rows (generated) >>>
  // Rerelease content. ED_CallSpawn scans itemlist() BEFORE this table, so
  // the ported ammo_*/weapon_*/item_*/key_* classnames resolve as itemlist
  // rows in g_items.ts and deliberately do not appear here.

  // --- dm_tag ---
  { name: "dm_tag_token", spawn: SP_dm_tag_token },

  // --- g_ctf ---
  { name: "info_player_team1", spawn: SP_info_player_team1 },
  { name: "info_player_team2", spawn: SP_info_player_team2 },
  { name: "misc_ctf_banner", spawn: SP_misc_ctf_banner },
  { name: "misc_ctf_small_banner", spawn: SP_misc_ctf_small_banner },

  // --- g_kexmisc ---
  { name: "dynamic_light", spawn: SP_dynamic_light },
  { name: "func_animation", spawn: SP_func_animation },
  { name: "info_landmark", spawn: SP_info_landmark },
  { name: "info_world_text", spawn: SP_info_world_text },
  { name: "misc_flare", spawn: SP_misc_flare },
  { name: "misc_hologram", spawn: SP_misc_hologram },
  { name: "misc_lavaball", spawn: SP_misc_lavaball },
  { name: "misc_model", spawn: SP_misc_model },
  { name: "misc_player_mannequin", spawn: SP_misc_player_mannequin },

  // --- g_kextarg ---
  { name: "target_achievement", spawn: SP_target_achievement },
  { name: "target_autosave", spawn: SP_target_autosave },
  { name: "target_camera", spawn: SP_target_camera },
  { name: "target_crossunit_target", spawn: SP_target_crossunit_target },
  { name: "target_crossunit_trigger", spawn: SP_target_crossunit_trigger },
  { name: "target_gravity", spawn: SP_target_gravity },
  { name: "target_healthbar", spawn: SP_target_healthbar },
  { name: "target_light", spawn: SP_target_light },
  { name: "target_music", spawn: SP_target_music },
  { name: "target_poi", spawn: SP_target_poi },
  { name: "target_sky", spawn: SP_target_sky },
  { name: "target_soundfx", spawn: SP_target_soundfx },
  { name: "target_story", spawn: SP_target_story },

  // --- g_kextrig ---
  { name: "func_eye", spawn: SP_func_eye },
  { name: "info_nav_lock", spawn: SP_info_nav_lock },
  { name: "trigger_coop_relay", spawn: SP_trigger_coop_relay },
  { name: "trigger_flashlight", spawn: SP_trigger_flashlight },
  { name: "trigger_fog", spawn: SP_trigger_fog },
  { name: "trigger_health_relay", spawn: SP_trigger_health_relay },

  // --- g_newfnc ---
  { name: "func_object_repair", spawn: SP_object_repair },
  { name: "func_plat2", spawn: SP_func_plat2 },
  { name: "rotating_light", spawn: SP_rotating_light },

  // --- g_newmisc ---
  { name: "hint_path", spawn: SP_hint_path },
  { name: "info_player_coop_lava", spawn: SP_info_player_coop_lava },
  { name: "misc_amb4", spawn: SP_misc_amb4 },
  { name: "misc_nuke", spawn: SP_misc_nuke },
  { name: "misc_nuke_core", spawn: SP_misc_nuke_core },
  { name: "misc_transport", spawn: SP_misc_transport },
  { name: "misc_viper_missile", spawn: SP_misc_viper_missile },

  // --- g_newtarg ---
  { name: "target_anger", spawn: SP_target_anger },
  { name: "target_blacklight", spawn: SP_target_blacklight },
  { name: "target_killplayers", spawn: SP_target_killplayers },
  { name: "target_mal_laser", spawn: SP_target_mal_laser },
  { name: "target_orb", spawn: SP_target_orb },
  { name: "target_steam", spawn: SP_target_steam },

  // --- g_newtrig ---
  { name: "info_teleport_destination", spawn: SP_info_teleport_destination },
  { name: "trigger_disguise", spawn: SP_trigger_disguise },
  { name: "trigger_teleport", spawn: SP_trigger_teleport },

  // --- g_turret ---
  { name: "turret_invisible_brain", spawn: SP_turret_invisible_brain },

  // --- m_arachnid ---
  { name: "monster_arachnid", spawn: SP_monster_arachnid },

  // --- m_boss5 ---
  { name: "monster_boss5", spawn: SP_monster_boss5 },

  // --- m_carrier ---
  { name: "monster_carrier", spawn: SP_monster_carrier },

  // --- m_chick ---
  { name: "monster_chick_heat", spawn: SP_monster_chick_heat },

  // --- m_fixbot ---
  { name: "monster_fixbot", spawn: SP_monster_fixbot },

  // --- m_gekk ---
  { name: "monster_gekk", spawn: SP_monster_gekk },

  // --- m_gladb ---
  { name: "monster_gladb", spawn: SP_monster_gladb },

  // --- m_guncmdr ---
  { name: "monster_guncmdr", spawn: SP_monster_guncmdr },

  // --- m_hover ---
  { name: "monster_daedalus", spawn: SP_monster_hover },

  // --- m_medic ---
  { name: "monster_medic_commander", spawn: SP_monster_medic },

  // --- m_shambler ---
  { name: "monster_shambler", spawn: SP_monster_shambler },

  // --- m_soldier ---
  { name: "monster_soldier_hypergun", spawn: SP_monster_soldier_hypergun },
  { name: "monster_soldier_lasergun", spawn: SP_monster_soldier_lasergun },
  { name: "monster_soldier_ripper", spawn: SP_monster_soldier_ripper },

  // --- m_stalker ---
  { name: "monster_stalker", spawn: SP_monster_stalker },

  // --- m_tank ---
  { name: "monster_tank_stand", spawn: SP_monster_tank_stand },

  // --- m_turret ---
  { name: "monster_turret", spawn: SP_monster_turret },

  // --- m_widow ---
  { name: "monster_widow", spawn: SP_monster_widow },

  // --- m_widow2 ---
  { name: "monster_widow2", spawn: SP_monster_widow2 },
  // <<< RERELEASE CONTENT PORT: spawn table rows <<<
];

/*
===============
G_SpawnableClassnames

RERELEASE CONTENT PORT -- not a C function. Returns every classname
ED_CallSpawn can resolve: the itemlist classnames it scans first, plus the
spawns[] table it falls through to, in that same order.

This exists so the rerelease-content coverage gate
(test/g_spawn_rerelease_coverage.test.ts) can assert "the classic module
resolves every classname the shipped rerelease maps place" without booting
a server or reaching into module-private state. It reads the same two
sources ED_CallSpawn does, so it cannot drift from actual spawn behavior.

Note this reads itemlist() unguarded by game.num_items, unlike ED_CallSpawn:
the item table is a static array literal, so its classnames are knowable
before InitItems has run.
===============
*/
export function G_SpawnableClassnames(): string[] {
  // The three names ED_CallSpawn's "PMM classnames hack" remaps onto
  // shipped items before consulting either lookup. They resolve just as
  // surely as a table row, so the contract of this function includes them.
  const out: string[] = ["weapon_nailgun", "ammo_nails", "weapon_heatbeam"];
  for (const item of itemlist()) {
    if (item.classname !== null) out.push(item.classname);
  }
  for (const s of spawns) out.push(s.name);
  return out;
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
  // RERELEASE CONTENT PORT -- the "PMM classnames hack", present in BOTH
  // rogue/g_spawn.c and the rerelease's own ED_CallSpawn
  // (src/kexgame/g_spawn.ts). Three classnames from pre-release rogue beta
  // maps are remapped onto the shipped item names rather than dropped.
  //
  // This matters for real shipped content, not just betas: mgu3m2 (Call of
  // the Machine) places a `weapon_heatbeam`, and without this remap it was
  // the ONE remaining "unknown classname" across all 28 CotM maps. The
  // rerelease does not drop it either -- it renames it to the Plasma Beam,
  // which is why the map plays correctly there.
  if (ent.classname === "weapon_nailgun") {
    const item = FindItem("ETF Rifle");
    if (item !== null && item.classname !== null) ent.classname = item.classname;
  }
  if (ent.classname === "ammo_nails") {
    const item = FindItem("Flechettes");
    if (item !== null && item.classname !== null) ent.classname = item.classname;
  }
  if (ent.classname === "weapon_heatbeam") {
    const item = FindItem("Plasma Beam");
    if (item !== null && item.classname !== null) ent.classname = item.classname;
  }
  // pmm

  const classname = ent.classname;

  // RERELEASE CONTENT PORT (rogue/g_spawn.c's ROGUE_GRAVITY block): reset
  // the gravity direction before the spawn function runs so the spawn
  // function can override it. Also covers g_edicts[0] (worldspawn), which
  // ED_LoadFromFile does not allocate through G_Spawn/G_InitEdict.
  VectorSet(ent.gravityVector, 0, 0, -1);

  // check item spawn functions -- guarded on game.num_items (set by the
  // still-pending g_items.c:InitItems) so this never calls the pending
  // itemlist() accessor when there are no items to check, exactly as the
  // C loop's `i < game.num_items` condition never dereferences `itemlist`
  // when num_items is 0.
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
    unknownClassnames.add(classname);
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

  // Is this session delivering re-release presentation? Read ONCE, here,
  // rather than per entity: SV_SpawnServer settles the layout before it
  // calls ge.SpawnEntities (sv_init.ts's "CONTENT-DRIVEN LAYOUT CHOICE"
  // block), but a mid-parse *Index overflow can still widen the session
  // while this loop runs, and half a map inhibited under one answer and
  // half under the other would be a rule that depends on precache order.
  // This is the content gate on the SPAWNFLAG_NOT_COOP arm below -- see
  // its comment for why this signal and not the other candidate.
  const rereleaseContent = gi.extended_layout?.() === true;

  // Mike's ruling (2026-08-31): "quiet it" -- reset the unknown-field/
  // unknown-classname counters (see the deviation comment above C_atoi) for
  // this map's parse pass before ED_ParseEdict/ED_CallSpawn can add to them.
  unknownFieldKeys.clear();
  unknownClassnames.clear();

  // [Sam-KEX] shadow lights are collected during this parse pass and
  // published after it (see setup_shadow_lights below); clear last level's
  // collection first. No-op on a narrow session, which never collects any.
  G_ResetShadowLights();

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

    // remove things (except the world) from different skill levels or deathmatch
    if (current !== g_edicts[0]) {
      if (cvarNum(gameCvars.deathmatch) !== 0) {
        if ((current.spawnflags & SPAWNFLAG_NOT_DEATHMATCH) !== 0) {
          G_FreeEdict(current);
          inhibit++;
          continue;
        }
      } else {
        // RERELEASE-ONLY ARMS. g_spawn.cpp's G_InhibitEntity (ported verbatim
        // as src/kexgame/g_spawn.ts's own G_InhibitEntity) has a coop pair
        // vanilla 3.21 does not:
        //
        //     if ( coop && spawnflags & SPAWNFLAG_NOT_COOP)  -> inhibit
        //     if (!coop && spawnflags & SPAWNFLAG_COOP_ONLY) -> inhibit
        //
        // Both are reproduced here, but they are gated differently, and that
        // is a deliberate split, not an omission:
        //
        //   SPAWNFLAG_COOP_ONLY (0x00004000, g_local.h:262 /
        //   src/kexgame/g_local.ts:192) is a bit vanilla assigns no meaning
        //   to anywhere -- it is not in vanilla's g_local.h, not read by any
        //   spawn function, and not in the editor mask cleared below. Every
        //   entity carrying it was authored by the rerelease, so honoring it
        //   is gated by the rerelease key itself and cannot move a single
        //   1997-authored entity. Across the shipped map set it inhibits 239
        //   entities in 20 maps: coop-extra monsters and ammo on ten Rogue
        //   maps (rbase1/rbase2/rboss/rhangar1/rhangar2/rlava1/rmine1/
        //   rmine2/rware1/rware2), two Q64 maps, and eight Call of the
        //   Machine maps -- and NONE in base1/base2/..., whose inhibit
        //   counts stay exactly where they were.
        //
        //   SPAWNFLAG_NOT_COOP (0x00001000) is the opposite case, and needs
        //   a gate of its own. It is a 1997 flag with 1997 semantics, and
        //   vanilla's own decision was to leave the check commented out (the
        //   `/* ((coop->value) && ... */` in g_spawn.c's ED_LoadFromFile).
        //   Honoring it unconditionally would rewrite coop on original
        //   content -- 15 maps in a 1997 install carry the bit, 961 entities
        //   between them, every one of which vanilla spawns in coop -- so it
        //   is honored only when the session is carrying RE-RELEASE content,
        //   which is what `rereleaseContent` (gi.extended_layout(), settled
        //   by sv_init.ts's SV_ContentNeedsWideLayout before this runs) says.
        //
        //   WHY THAT SIGNAL AND NOT "THE MAP CARRIES A COOP_ONLY ENTITY".
        //   Both candidates were measured against the two installs on this
        //   machine by running SV_ContentNeedsWideLayout itself over every
        //   map's entity lump. 31 of the 222 shipped re-release maps carry
        //   NOT_COOP entities. The COOP_ONLY-presence gate reaches 20 of
        //   them and CANNOT reach the rest at any threshold: mgu6m1,
        //   q64/command and q64/jail use NOT_COOP without placing a single
        //   COOP_ONLY entity anywhere, so there is nothing for it to key
        //   on. mgu6m1 is not a corner case -- the bit is on its
        //   info_player_start, its trigger_teleport and its
        //   info_teleport_destination, the same start/drop-pod scripting
        //   mgu4m1 has. The wide-session gate reaches all 31.
        //
        //   WHY IT CANNOT FIRE ON 1997 CONTENT. The predicate is a
        //   statement about re-release-only presentation entities and keys,
        //   and no 1997-authored map has any: all 656 readable map entity
        //   lumps in this machine's classic tree (baseq2/ctf/rogue/xatrix/
        //   lmctf paks plus loose maps) were run through
        //   SV_ContentNeedsWideLayout and produced zero matches, so a
        //   classic-tree session never widens and this arm is dead code
        //   there. Re-run, not inherited: sv_init.ts's own header records
        //   the same scan for the WIRE choice, and this arm now leans on it
        //   as a GAME RULE. Confirmed empirically as well -- 27 maps booted
        //   from the 1997 tree under both builds (all 15 rogue maps that
        //   carry the bit, 961 entities between them) produced byte-
        //   identical spawn records.
        //
        //   THE PREDICATE IS SHARED, AND IT GROWS. SV_ContentNeedsWideLayout
        //   gains entries as more re-release presentation gets ported (the
        //   fog and world-text entries were added after this arm landed,
        //   which is what took its coverage from 24 of 31 maps to all 31).
        //   That is the intended direction -- every map it newly recognises
        //   is a map it just proved carries re-release authoring -- but it
        //   does mean this arm's reach is not local to this file. Its ONE
        //   invariant is the 1997 scan above, which the predicate's own
        //   header re-checks on every addition.
        //
        //   KNOWN CONSEQUENCE, one map. mgu6m1's only info_player_start
        //   carries NOT_COOP, so once it is honored the classic module has
        //   no start left for client 0 and falls back to the world origin.
        //   The re-release lands in the map instead, but for a DIFFERENT
        //   rule this arm does not touch: vanilla's SelectCoopSpawnPoint
        //   returns NULL outright for client 0, where p_client.cpp:1270-1372
        //   falls back to the map's info_player_coop spots (mgu6m1 has
        //   four). That fallback belongs in p_client.ts and is the open
        //   follow-up; test/spawn_start_rerelease.test.ts pins both halves.
        //
        // Together these two arms are what makes re-release content play
        // correctly under this ruleset. Live case that found the pair:
        // mgu4m1 places an info_player_start AND a trigger_always that fires
        // the drop-pod teleporter, both COOP_ONLY; without them the classic
        // ruleset both started the player at the coop spot and immediately
        // ran the coop-only landing script.
        if (rereleaseContent && (current.spawnflags & SPAWNFLAG_NOT_COOP) !== 0 && cvarNum(gameCvars.coop) !== 0) {
          G_FreeEdict(current);
          inhibit++;
          continue;
        }

        if ((current.spawnflags & SPAWNFLAG_COOP_ONLY) !== 0 && cvarNum(gameCvars.coop) === 0) {
          G_FreeEdict(current);
          inhibit++;
          continue;
        }

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

    ED_CallSpawn(current);
  }

  gi.dprintf(`${inhibit} entities inhibited\n`);

  // Mike's ruling (2026-08-31): "quiet it" -- see the deviation comment on
  // unknownFieldKeys/developerMode above C_atoi. developer 0 rolls up every
  // "<field> is not a field" / "<classname> doesn't have a spawn function"
  // ED_ParseField/ED_CallSpawn suppressed during this parse pass into one
  // line; developer 1 already printed each one and skips this line entirely
  // (byte-identical to vanilla otherwise).
  if (!developerMode()) {
    // Only when something was actually suppressed -- a 0/0 summary is noise.
    if (unknownFieldKeys.size + unknownClassnames.size > 0)
      gi.dprintf(
      `SpawnEntities: ${unknownFieldKeys.size} unknown fields, ${unknownClassnames.size} unknown classnames suppressed (developer 1 for detail)\n`,
    );
  }

  // #ifdef DEBUG entity-validity scan dropped per PORTING.md's #ifdef
  // ruling (portable path only; Com_DPrintf sanity check, not behavior).

  G_FindTeams();

  // [Sam-KEX] g_spawn.cpp's own `setup_shadow_lights()` sits at this exact
  // point in SpawnEntities (src/kexgame/g_spawn.ts:1697) -- after every
  // entity exists, because each light resolves its cone direction and its
  // driving lightstyle by targetname. Zero-iteration on a narrow session.
  setup_shadow_lights();

  PlayerTrail_Init();
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

// RERELEASE CONTENT: target_healthbar's boss bars.
//
// src/kexgame/g_spawn.ts:1776 puts `ifstat 52 yt 24 health_bars endifstat`
// into the SP/coop statusbar; the classic layout program spells the same
// conditional `if 52 ... endif` (client/cgame/classic_hud.ts's interpreter
// has `if`/`endif`, not the rerelease's `ifstat`/`endifstat`), and the
// `health_bars` token itself is implemented there with the same geometry
// cg_screen.cpp draws.
//
// APPENDED ONLY ON A WIDE SESSION. CS_STATUSBAR is compared byte-for-byte by
// nothing, but it IS a configstring that goes on the wire, so a narrow
// (protocol 34) session must keep the exact string the classic module has
// always sent -- that is what keeps a 1997-content session's traffic, and its
// rendered frame, identical. On a narrow session STAT_HEALTH_BARS cannot
// travel anyway (p_hud.ts's G_SetHealthBarStat), so the block would only ever
// evaluate false; leaving it out entirely makes that provable rather than
// incidental.
//
// The suffix opens with a leading space because single_statusbar ends with
// one already ("...\tpic\t11 endif "), so the concatenation is
// "endif  if 52 ..." -- two spaces, which COM_Parse treats as one separator.
// Kept rather than trimmed so single_statusbar itself is untouched.
function wide_statusbar_suffix(): string {
  if (gi.extended_layout?.() !== true) return "";
  return " if 52 " + "\tyt\t24 " + "\thealth_bars " + "endif ";
}

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

  // Client-side gate (cl_view.ts's CL_SetSky / cl_parse.ts's
  // CL_ParseConfigString): `cls.csr.extended` decides whether CS_SKYROTATE
  // is parsed as "<rotate>" or "<rotate> <autorotate>" (q2repro
  // precache.c:380-383). `gi.extended_layout()` is this module's mirror of
  // that same session-wide layout decision (sv_init.ts's "CONTENT-DRIVEN
  // LAYOUT CHOICE"), so it has to be the gate here too: a classic-module
  // session running 1997 map data always runs on the narrow layout, and
  // MUST keep emitting exactly the bare `%f` string it always has -- that
  // byte-for-byte content is what keeps a narrow session's traffic (and
  // rendered frame) identical to the pre-existing build. Only a WIDE
  // session (rerelease content through the classic module) gets the
  // two-token form, matching src/kexgame/g_spawn.ts:1877's own
  // `${st.skyrotate} ${st.skyautorotate}` write for the kex module.
  if (gi.extended_layout?.() === true) {
    gi.configstring(CS_SKYROTATE, `${st.skyrotate} ${st.skyautorotate}`);
  } else {
    gi.configstring(CS_SKYROTATE, Com_sprintf("%f", st.skyrotate));
  }

  gi.configstring(CS_SKYAXIS, Com_sprintf("%f %f %f", st.skyaxis[0], st.skyaxis[1], st.skyaxis[2]));

  gi.configstring(CS_CDTRACK, Com_sprintf("%i", ent.sounds));

  gi.configstring(CS_MAXCLIENTS, Com_sprintf("%i", cvarNum(gameCvars.maxclients) | 0));

  // status bar program
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    gi.configstring(CS_STATUSBAR, dm_statusbar);
  } else {
    gi.configstring(CS_STATUSBAR, single_statusbar + wide_statusbar_suffix());
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

  // sexed models
  // THIS ORDER MUST MATCH THE DEFINES IN g_local.h
  // you can add more, max 15
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
