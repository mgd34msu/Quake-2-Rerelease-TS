// Ports lmctf60/g_spawn.c -- diff-derived from src/ctf/g_spawn.ts
// (lmctf60/g_spawn.c vs quake-2/ctf/g_spawn.c: 1008-line diff of 1484
// total).
//
// STATUS: ED_NewString/ED_ParseField/ED_ParseEdict/ED_CallSpawn/
// G_FindTeams/SpawnEntities/SP_worldspawn are ported (the parse-and-spawn
// engine every map load needs). The spawns[] registry below wires every
// classname to a real function where one exists in this family; where the
// true C function belongs to a file genuinely out of this unit's SCOPE
// (unit B's g_runes.c, or monster/turret code dropped per the foundation's
// MONSTERS_OK ruling), the registry entry is either omitted (monsters/
// turrets -- dead code, see below) or points at a documented throwing
// stub (unit B's damage_rune, and item_health/small/large/mega, which this
// port's partial ITEMLIST never populates -- see g_items.ts's own header).
//
// NOT PORTED: WriteEntFile/ReadEntFile (lmctf60's .ent-file map-override
// I/O, gated on q2pro/R1Q2 server detection via a `version` cvar this port
// has no equivalent engine-detection story for -- genuinely out of SCOPE,
// no test or call site in this unit needs it) and the entire "CTF CODE --
// LM_JORM" tail of SpawnEntities (ctf_validateflags -- "the only function
// allowed to spawn flags" per its own C comment, SpawnTourneyClock,
// SpawnRune x5, Reset_MVP, sl_GameStart/StdLog) -- all live in files this
// unit does not own or in g_ctffunc.ts sections explicitly documented as
// out of SCOPE there (flag home/reset/spawn). PlayerTrail_Init (p_trail.c)
// also has no port anywhere in this family (not this unit's SCOPE, not
// unit B's either) and is skipped with the same citation style. Every
// omission is called out inline at its call site below, not silently
// dropped.

import { COM_Parse, type ComParseState, vec3, type Vec3, VectorCopy } from "../shared/math";
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
  FL_TEAMSLAVE,
  g_edicts,
  game,
  gameCvars,
  gameIndices,
  gi,
  globals,
  level,
  MovetypeT,
  SetBlueFlag,
  SetRedFlag,
  SPAWNFLAG_NOT_DEATHMATCH,
  SPAWNFLAG_NOT_EASY,
  SPAWNFLAG_NOT_HARD,
  SPAWNFLAG_NOT_MEDIUM,
  st,
} from "./g_local";
import { SolidT } from "./game";
import { type EdictStringKey, G_FreeEdict, G_Spawn } from "./g_utils";
import { FIELDS } from "./g_save";
import { FindItem, itemlist, PrecacheItem, SetItemNames, SP_flag, SP_item_health, SP_item_health_large, SP_item_health_mega, SP_item_health_small } from "./g_items";
import { InitBodyQue, SaveClientData, SP_info_player_blue, SP_info_player_coop, SP_info_player_deathmatch, SP_info_player_intermission, SP_info_player_red, SP_info_player_start } from "./p_client";
import {
  SP_func_areaportal,
  SP_func_clock,
  SP_func_explosive,
  SP_func_object,
  SP_func_wall,
  SP_info_notnull,
  SP_info_null,
  SP_info_position,
  SP_light,
  SP_light_mine1,
  SP_light_mine2,
  SP_misc_banner,
  SP_misc_bigviper,
  SP_misc_blackhole,
  SP_misc_ctf_banner,
  SP_misc_ctf_small_banner,
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
  SP_path_corner,
  SP_point_combat,
  SP_target_character,
  SP_target_string,
  SP_viewthing,
  SP_monster_commander_body,
} from "./g_misc";
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

function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

// -------------------------------------------------------------------------
// ED_NewString / ED_ParseField / ED_ParseEdict -- identical design to
// src/ctf/g_spawn.ts (lmctf60's own diff here is purely a `int i,l` ->
// `int i; int len` split with no behavior change, plus a default-case
// compiler-warning silencer on the field-type switch -- both no-ops here).
// -------------------------------------------------------------------------

// Unknown-field / unknown-classname spawn noise, gated behind the
// "developer" cvar. Mike's ruling (2026-08-31): "quiet it" -- see
// .orch/followups.md finding 14, extended to every LEGACY-family module
// (coordinator follow-up, same day: the ruling covers the family, and
// LM-CTF loads rerelease-authored maps through the New Game selector the
// same way baseq2 does). Identical mechanism to src/game/g_spawn.ts's
// ED_ParseField/ED_CallSpawn/SpawnEntities: the frozen LM-CTF game DLL
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

function parseVector3(value: string): Vec3 {
  const parts = value.trim().length > 0 ? value.trim().split(/\s+/) : [];
  const v = vec3();
  for (let i = 0; i < 3; i++) {
    const part = parts[i];
    v[i] = part === undefined ? 0 : C_atof(part);
  }
  return v;
}

export function ED_NewString(value: string): string {
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

function firstChar(token: string): string {
  return token.length > 0 ? token[0] : "";
}

function comParseEOF(state: ComParseState, startIndex: number, token: string): boolean {
  const closedEmptyQuote = state.index > startIndex && state.data.charAt(state.index - 1) === '"';
  return token === "" && !closedEmptyQuote;
}

export function ED_ParseEdict(state: ComParseState, ent: EdictT): void {
  let init = false;
  st.clear();

  for (;;) {
    const keyStart = state.index;
    const keyToken = COM_Parse(state);
    if (firstChar(keyToken) === "}") break;
    if (comParseEOF(state, keyStart, keyToken)) {
      gi.error("ED_ParseEntity: EOF without closing brace");
    }
    const keyname = keyToken;

    const valStart = state.index;
    const valToken = COM_Parse(state);
    if (comParseEOF(state, valStart, valToken)) {
      gi.error("ED_ParseEntity: EOF without closing brace");
    }
    if (firstChar(valToken) === "}") {
      gi.error("ED_ParseEntity: closing brace without data");
    }

    init = true;

    if (firstChar(keyname) === "_") continue;

    ED_ParseField(keyname, valToken, ent);
  }

  if (!init) ent.clear();
}

//===================================================================
// spawns[] (lmctf60/g_spawn.c) -- see file header for the omission/stub
// policy applied below.
//===================================================================

interface SpawnT {
  name: string;
  spawn: (ent: EdictT) => void;
}

// `item_health`/`item_health_small`/`item_health_large`/`item_health_mega`
// (lmctf60/g_items.c SP_item_health family) -- now ported for real
// (g_items.ts). These classnames are NOT intercepted by ED_CallSpawn's
// item-table-wins check below because the health ITEMLIST entry's
// `classname` is NULL in the C source (see g_items.ts's makeHealthItem doc
// comment) -- unlike "flag", these genuinely reach the spawns[] entries
// below.
//
// `damage_rune` (lmctf60/g_runes.c SP_damage_rune) is now ported for real
// too (g_runes.ts). resist_rune/haste_rune/regen_rune are now real too
// (g_items.ts's makeResistRuneItem/makeHasteRuneItem/makeRegenRuneItem) --
// none of the three get a spawns[] entry below because the C source's own
// spawns[] table doesn't have one for them either (confirmed by direct
// read of g_spawn.c: only "damage_rune" is registered there); ED_CallSpawn
// below finds them via the item table first, same as "flag"/"damage_rune".
import { RUNE_DAMAGE, RUNE_HASTE, RUNE_REGEN, RUNE_RESIST, RUNE_VAMP, SP_damage_rune, SpawnRune } from "./g_runes";
import { ctf_validateflags } from "./g_ctffunc";
import { sl_GameStart } from "./gslog";

// =========================================================================
// RERELEASE CONTENT PORT -- the spawn functions for the classnames the
// shipped re-release maps place. Every one of them lives in a file copied
// verbatim from src/game/ (which is itself the merged baseq2 + mission-pack
// + re-release entity set); none replaces anything LM-CTF already spawns.
// =========================================================================
import {
  SP_dm_tag_token,
} from "./dm_tag";
import {
  SP_dynamic_light,
  SP_func_animation,
  SP_info_landmark,
  SP_info_world_text,
  SP_misc_flare,
  SP_misc_hologram,
  SP_misc_lavaball,
  SP_misc_model,
  SP_misc_player_mannequin,
} from "./g_kexmisc";
import {
  SP_target_autosave,
  SP_target_camera,
  SP_target_crossunit_target,
  SP_target_crossunit_trigger,
  SP_target_gravity,
  SP_target_healthbar,
  SP_target_light,
  SP_target_music,
  SP_target_poi,
  SP_target_sky,
  SP_target_soundfx,
  SP_target_story,
} from "./g_kextarg";
import {
  SP_func_eye,
  SP_info_nav_lock,
  SP_trigger_coop_relay,
  SP_trigger_flashlight,
  SP_trigger_fog,
  SP_trigger_health_relay,
} from "./g_kextrig";
import {
  SP_func_plat2,
  SP_object_repair,
  SP_rotating_light,
} from "./g_newfnc";
import {
  SP_hint_path,
  SP_info_player_coop_lava,
  SP_misc_amb4,
  SP_misc_nuke,
  SP_misc_nuke_core,
  SP_misc_transport,
  SP_misc_viper_missile,
} from "./g_newmisc";
import {
  SP_target_anger,
  SP_target_blacklight,
  SP_target_killplayers,
  SP_target_mal_laser,
  SP_target_orb,
  SP_target_steam,
} from "./g_newtarg";
import {
  SP_info_teleport_destination,
  SP_trigger_disguise,
  SP_trigger_teleport,
} from "./g_newtrig";
import {
  SP_turret_base,
  SP_turret_breach,
  SP_turret_driver,
  SP_turret_invisible_brain,
} from "./g_turret";
import {
  SP_target_actor,
} from "./m_actor";
import {
  SP_monster_arachnid,
} from "./m_arachnid";
import {
  SP_monster_berserk,
} from "./m_berserk";
import {
  SP_monster_boss2,
} from "./m_boss2";
import {
  SP_monster_boss3_stand,
} from "./m_boss3";
import {
  SP_monster_jorg,
} from "./m_boss31";
import {
  SP_monster_makron,
} from "./m_boss32";
import {
  SP_monster_boss5,
} from "./m_boss5";
import {
  SP_monster_brain,
} from "./m_brain";
import {
  SP_monster_carrier,
} from "./m_carrier";
import {
  SP_monster_chick,
  SP_monster_chick_heat,
} from "./m_chick";
import {
  SP_monster_fixbot,
} from "./m_fixbot";
import {
  SP_monster_flipper,
} from "./m_flipper";
import {
  SP_monster_floater,
} from "./m_float";
import {
  SP_monster_flyer,
} from "./m_flyer";
import {
  SP_monster_gekk,
} from "./m_gekk";
import {
  SP_monster_gladb,
} from "./m_gladb";
import {
  SP_monster_gladiator,
} from "./m_gladiator";
import {
  SP_monster_guncmdr,
} from "./m_guncmdr";
import {
  SP_monster_gunner,
} from "./m_gunner";
import {
  SP_monster_hover,
} from "./m_hover";
import {
  SP_monster_infantry,
} from "./m_infantry";
import {
  SP_misc_insane,
} from "./m_insane";
import {
  SP_monster_medic,
} from "./m_medic";
import {
  SP_monster_mutant,
} from "./m_mutant";
import {
  SP_monster_parasite,
} from "./m_parasite";
import {
  SP_monster_shambler,
} from "./m_shambler";
import {
  SP_monster_soldier,
  SP_monster_soldier_hypergun,
  SP_monster_soldier_lasergun,
  SP_monster_soldier_light,
  SP_monster_soldier_ripper,
  SP_monster_soldier_ss,
} from "./m_soldier";
import {
  SP_monster_stalker,
} from "./m_stalker";
import {
  SP_monster_supertank,
} from "./m_supertank";
import {
  SP_monster_tank,
  SP_monster_tank_stand,
} from "./m_tank";
import {
  SP_monster_turret,
} from "./m_turret";
import {
  SP_monster_widow,
} from "./m_widow";
import {
  SP_monster_widow2,
} from "./m_widow2";

export const spawns: SpawnT[] = [
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
  // target_actor: #ifdef MONSTERS_OK, dead code, dropped (see file header).
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
  // misc_actor, misc_insane: #ifdef MONSTERS_OK, dead code, dropped.
  { name: "misc_gib_arm", spawn: SP_misc_gib_arm },
  { name: "misc_gib_leg", spawn: SP_misc_gib_leg },
  { name: "misc_gib_head", spawn: SP_misc_gib_head },
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

  // monster_* / turret_*: #ifdef MONSTERS_OK, dead code (MONSTERS_OK is
  // never defined by the Makefile, per the foundation's g_local.ts/
  // g_combat.ts ruling) -- dropped entirely, not stubbed, matching every
  // other monster-only entity in this family.

  // CTF CODE -- LM_JORM
  { name: "flag", spawn: SP_flag },
  { name: "info_flag_red", spawn: SP_info_flag_red },
  { name: "item_flag_team1", spawn: SP_info_flag_red },
  { name: "info_flag_blue", spawn: SP_info_flag_blue },
  { name: "item_flag_team2", spawn: SP_info_flag_blue },
  { name: "info_player_red", spawn: SP_info_player_red },
  { name: "info_player_team1", spawn: SP_info_player_red },
  { name: "info_player_blue", spawn: SP_info_player_blue },
  { name: "info_player_team2", spawn: SP_info_player_blue },
  { name: "damage_rune", spawn: SP_damage_rune },
  { name: "misc_ctf_banner", spawn: SP_misc_ctf_banner },
  { name: "misc_ctf_small_banner", spawn: SP_misc_ctf_small_banner },
  { name: "info_position", spawn: SP_info_position },
  // END CTF CODE -- LM_JORM

  // =====================================================================
  // RERELEASE CONTENT PORT -- appended in src/game/g_spawn.ts's own row
  // order. Every row is inert until a map places its classname, and no
  // 1997 map names any of them.
  // =====================================================================
  { name: "target_actor", spawn: SP_target_actor },
  { name: "misc_insane", spawn: SP_misc_insane },
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
  { name: "monster_commander_body", spawn: SP_monster_commander_body },
  { name: "turret_breach", spawn: SP_turret_breach },
  { name: "turret_base", spawn: SP_turret_base },
  { name: "turret_driver", spawn: SP_turret_driver },
  { name: "dm_tag_token", spawn: SP_dm_tag_token },
  { name: "dynamic_light", spawn: SP_dynamic_light },
  { name: "func_animation", spawn: SP_func_animation },
  { name: "info_landmark", spawn: SP_info_landmark },
  { name: "info_world_text", spawn: SP_info_world_text },
  { name: "misc_flare", spawn: SP_misc_flare },
  { name: "misc_hologram", spawn: SP_misc_hologram },
  { name: "misc_lavaball", spawn: SP_misc_lavaball },
  { name: "misc_model", spawn: SP_misc_model },
  { name: "misc_player_mannequin", spawn: SP_misc_player_mannequin },
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
  { name: "func_eye", spawn: SP_func_eye },
  { name: "info_nav_lock", spawn: SP_info_nav_lock },
  { name: "trigger_coop_relay", spawn: SP_trigger_coop_relay },
  { name: "trigger_flashlight", spawn: SP_trigger_flashlight },
  { name: "trigger_fog", spawn: SP_trigger_fog },
  { name: "trigger_health_relay", spawn: SP_trigger_health_relay },
  { name: "func_object_repair", spawn: SP_object_repair },
  { name: "func_plat2", spawn: SP_func_plat2 },
  { name: "rotating_light", spawn: SP_rotating_light },
  { name: "hint_path", spawn: SP_hint_path },
  { name: "info_player_coop_lava", spawn: SP_info_player_coop_lava },
  { name: "misc_amb4", spawn: SP_misc_amb4 },
  { name: "misc_nuke", spawn: SP_misc_nuke },
  { name: "misc_nuke_core", spawn: SP_misc_nuke_core },
  { name: "misc_transport", spawn: SP_misc_transport },
  { name: "misc_viper_missile", spawn: SP_misc_viper_missile },
  { name: "target_anger", spawn: SP_target_anger },
  { name: "target_blacklight", spawn: SP_target_blacklight },
  { name: "target_killplayers", spawn: SP_target_killplayers },
  { name: "target_mal_laser", spawn: SP_target_mal_laser },
  { name: "target_orb", spawn: SP_target_orb },
  { name: "target_steam", spawn: SP_target_steam },
  { name: "info_teleport_destination", spawn: SP_info_teleport_destination },
  { name: "trigger_disguise", spawn: SP_trigger_disguise },
  { name: "trigger_teleport", spawn: SP_trigger_teleport },
  { name: "turret_invisible_brain", spawn: SP_turret_invisible_brain },
  { name: "monster_arachnid", spawn: SP_monster_arachnid },
  { name: "monster_boss5", spawn: SP_monster_boss5 },
  { name: "monster_carrier", spawn: SP_monster_carrier },
  { name: "monster_chick_heat", spawn: SP_monster_chick_heat },
  { name: "monster_fixbot", spawn: SP_monster_fixbot },
  { name: "monster_gekk", spawn: SP_monster_gekk },
  { name: "monster_gladb", spawn: SP_monster_gladb },
  { name: "monster_guncmdr", spawn: SP_monster_guncmdr },
  { name: "monster_daedalus", spawn: SP_monster_hover },
  { name: "monster_medic_commander", spawn: SP_monster_medic },
  { name: "monster_shambler", spawn: SP_monster_shambler },
  { name: "monster_soldier_hypergun", spawn: SP_monster_soldier_hypergun },
  { name: "monster_soldier_lasergun", spawn: SP_monster_soldier_lasergun },
  { name: "monster_soldier_ripper", spawn: SP_monster_soldier_ripper },
  { name: "monster_stalker", spawn: SP_monster_stalker },
  { name: "monster_tank_stand", spawn: SP_monster_tank_stand },
  { name: "monster_turret", spawn: SP_monster_turret },
  { name: "monster_widow", spawn: SP_monster_widow },
  { name: "monster_widow2", spawn: SP_monster_widow2 },
];

/*
===============
G_SpawnableClassnames

RERELEASE CONTENT PORT -- not a C function. Returns every classname
ED_CallSpawn can resolve in THIS module: the itemlist classnames it scans
first, plus the spawns[] table it falls through to, in that same order.

Mirrors src/game/g_spawn.ts's function of the same name so the shipped-map
coverage gate (test/g_spawn_module_coverage.test.ts) can assert "this
module resolves every classname its own shipped maps place" without
booting a server or reaching into module-private state. It reads the same
two sources ED_CallSpawn does, so it cannot drift from actual spawn
behavior.

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
ED_CallSpawn (lmctf60/g_spawn.c:399) -- byte-identical dispatch order to
src/ctf/g_spawn.ts's ED_CallSpawn (item table checked before spawns[],
preserving the "flag"/item_health "item table wins" quirk documented above
and on g_items.ts's SP_flag).
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

  if (game.num_items > 0) {
    const item = FindItemByClassnameInList(classname);
    if (item !== null) {
      SpawnItemLazy(ent, item);
      return;
    }
  }

  for (const s of spawns) {
    if (s.name === classname) {
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

// Lazy require, not a static import, for SpawnItem specifically: g_items.ts
// already imports SP_flag from... no it doesn't -- this file imports
// SP_flag FROM g_items.ts, so a static import of SpawnItem from g_items.ts
// here is not a cycle. Kept as a plain re-export wrapper anyway so
// FindItemByClassname's own module (g_items.ts) is the single source of
// truth for the ITEMLIST contents this loop walks, matching
// src/ctf/g_spawn.ts's use of an `itemlist()` accessor for the same reason.
import { FindItemByClassname, SpawnItem } from "./g_items";
function FindItemByClassnameInList(classname: string) {
  return FindItemByClassname(classname);
}
function SpawnItemLazy(ent: EdictT, item: ReturnType<typeof FindItemByClassname>): void {
  SpawnItem(ent, item);
}

// info_player_red/info_player_team1 and info_player_blue/info_player_team2
// (lmctf60/g_spawn.c:284-287, byte-identical: all four classnames map to
// just two functions, "team1"/"team2" being old-map aliases for
// "red"/"blue") now route to p_client.ts's real SP_info_player_red/blue --
// this was a genuine wiring bug, not an intentional stub: nothing in this
// spawns[] table (or anywhere else) had a real entry for these four
// classnames before this fix, so every lmctf map placing a team-start
// marker under any of these names threw at boot.

/*
================
G_FindTeams (lmctf60/g_spawn.c) -- byte-identical to src/ctf/g_spawn.ts's
G_FindTeams.
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

/*
==============
SpawnEntities (lmctf60/g_spawn.c) -- see file header for what's dropped
from the tail (ctf_validateflags/SpawnTourneyClock/SpawnRune x5/
Reset_MVP/sl_GameStart, all out of this unit's SCOPE). The parse loop
itself matches lmctf60 exactly, including the DROPPED coop-based
SPAWNFLAG_NOT_COOP removal (the C source comments that whole clause out --
"((coop->value) && ...) ||" wrapped in a comment marker -- so it is
genuinely inactive code in the original, not something this port removed).
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

  level.clear();
  for (const e of g_edicts) e.clear();

  level.mapname = mapname.slice(0, MAX_QPATH - 1);
  game.spawnpoint = spawnpoint.slice(0, 511);

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

  for (;;) {
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

    if (current !== g_edicts[0]) {
      if (cvarNum(gameCvars.deathmatch) !== 0) {
        if ((current.spawnflags & SPAWNFLAG_NOT_DEATHMATCH) !== 0) {
          G_FreeEdict(current);
          inhibit++;
          continue;
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

  G_FindTeams();

  // PlayerTrail_Init() (p_trail.c) -- no port anywhere in this family
  // (not this unit's SCOPE, not unit B's either); skipped, not stubbed,
  // since nothing in this unit's ported files calls PlayerTrail_* at all.

  // lmctf60/g_spawn.c:1007-1045 ("CTF CODE -- LM_JORM" SpawnEntities
  // tail) -- ctf_validateflags/SpawnRune x5/sl_GameStart now real; two
  // pieces still NOT ported and cited individually rather than silently
  // dropped: SpawnTourneyClock (only reached when Match_Mode() is true,
  // which it never is by default -- matchstate starts and stays
  // MATCH_NONE unless g_tourney.ts's own still-unported StartMatch/
  // SetPause advance it, so this branch is exactly as unreachable here as
  // it is in a freshly booted real server) and Reset_MVP (g_tourney.ts's
  // own header scopes the whole MVP subsystem out; omvp/dmvp don't exist
  // anywhere in this port to reset).
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    SetRedFlag(null);
    SetBlueFlag(null);
    ctf_validateflags(); // this is the only function allowed to spawn flags
  }

  // in case you want to play single player runes
  const runesVal = gameCvars.runes === null ? 0 : gameCvars.runes.value;
  if ((runesVal & RUNE_DAMAGE) !== 0) SpawnRune(RUNE_DAMAGE);
  if ((runesVal & RUNE_HASTE) !== 0) SpawnRune(RUNE_HASTE);
  if ((runesVal & RUNE_RESIST) !== 0) SpawnRune(RUNE_RESIST);
  if ((runesVal & RUNE_REGEN) !== 0) SpawnRune(RUNE_REGEN);
  if ((runesVal & RUNE_VAMP) !== 0) SpawnRune(RUNE_VAMP); // added by Vampire

  sl_GameStart();
}

//===================================================================

const single_statusbar =
  "yb -24 " +
  "xv 0 " +
  "hnum " +
  "xv 50 " +
  "pic 0 " +
  "if 2 " +
  "xv 100 " +
  "anum " +
  "xv 150 " +
  "pic 2 " +
  "endif " +
  "if 4 " +
  "xv 200 " +
  "rnum " +
  "xv 250 " +
  "pic 4 " +
  "endif " +
  "if 6 " +
  "xv 296 " +
  "pic 6 " +
  "endif " +
  "yb -50 " +
  "if 7 " +
  "xv 0 " +
  "pic 7 " +
  "xv 26 " +
  "yb -42 " +
  "stat_string 8 " +
  "yb -50 " +
  "endif " +
  "if 9 " +
  "xv 262 " +
  "num 2 10 " +
  "xv 296 " +
  "pic 9 " +
  "endif " +
  "if 11 " +
  "xv 148 " +
  "pic 11 " +
  "endif ";

const dm_statusbar =
  "yb -24 " +
  "xv 0 " +
  "hnum " +
  "xv 50 " +
  "pic 0 " +
  "if 2 " +
  "xv 100 " +
  "anum " +
  "xv 150 " +
  "pic 2 " +
  "endif " +
  "if 4 " +
  "xv 200 " +
  "rnum " +
  "xv 250 " +
  "pic 4 " +
  "endif " +
  "if 6 " +
  "xv 296 " +
  "pic 6 " +
  "endif " +
  "yb -50 " +
  "if 7 " +
  "xv 0 " +
  "pic 7 " +
  "xv 26 " +
  "yb -42 " +
  "stat_string 8 " +
  "yb -50 " +
  "endif " +
  "if 9 " +
  "xv 246 " +
  "num 2 10 " +
  "xv 296 " +
  "pic 9 " +
  "endif " +
  "if 11 " +
  "xv 148 " +
  "pic 11 " +
  "endif " +
  // CTF MOD -- LM_JORM
  "if 23 " +
  "xr -33 " +
  "yb -152 " +
  "pic 23 " +
  "endif " +
  // RED TEAM
  "xr -71 " +
  "yb -84 " +
  "pic 21 " +
  "yb -79 " +
  "xr -144 " +
  "num 4 19 " +
  "xr -38 " +
  "yb -82 " +
  "num 2 24 " +
  // BLUE TEAM
  "xr -71 " +
  "yb -118 " +
  "pic 22 " +
  "yb -113 " +
  "xr -144 " +
  "num 4 20 " +
  "xr -38 " +
  "yb -116 " +
  "num 2 25 " +
  "xr -38 " +
  "yt 50 " +
  "num 2 26 " +
  // Score
  "xr -33 " +
  "yt 2 " +
  "pic 18 " +
  "yt 7 " +
  "xr -106 " +
  "num 4 14 " +
  // END CTF MOD -- LM_JORM
  // spectator
  "if 17 " +
  "xv 0 " +
  "yb -58 " +
  'string2 "" ' +
  "endif " +
  // chase camera
  "if 16 " +
  "xv 0 " +
  "yb -68 " +
  'string "Chasing" ' +
  "xv 64 " +
  "stat_string 16 " +
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

  InitBodyQue();

  SetItemNames();

  if (st.nextmap !== null) level.nextmap = st.nextmap;

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

  // status bar program -- lmctf60 drops ctf's `ctf->value` CS_STATUSBAR
  // branch entirely (confirmed: no equivalent branch anywhere in this
  // function), always using dm_statusbar/single_statusbar directly.
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    gi.configstring(CS_STATUSBAR, dm_statusbar);
  } else {
    gi.configstring(CS_STATUSBAR, single_statusbar);
  }

  //---------------

  gi.imageindex("i_help");
  level.pic_health = gi.imageindex("i_health");
  gi.imageindex("help");
  gi.imageindex("field_3");

  if (st.gravity === null) {
    gi.cvar_set("sv_gravity", "800");
  } else {
    gi.cvar_set("sv_gravity", st.gravity);
  }

  gameIndices.snd_fry = gi.soundindex("player/fry.wav");

  PrecacheItem(FindItem("Blaster"));

  gi.soundindex("player/lava1.wav");
  gi.soundindex("player/lava2.wav");
  gi.soundindex("misc/pc_up.wav");
  gi.soundindex("misc/talk1.wav");
  gi.soundindex("misc/udeath.wav");
  gi.soundindex("items/respawn1.wav");

  gi.soundindex("*death1.wav");
  gi.soundindex("*death2.wav");
  gi.soundindex("*death3.wav");
  gi.soundindex("*death4.wav");
  gi.soundindex("*fall1.wav");
  gi.soundindex("*fall2.wav");
  gi.soundindex("*gurp1.wav");
  gi.soundindex("*gurp2.wav");
  gi.soundindex("*jump1.wav");
  gi.soundindex("*pain25_1.wav");
  gi.soundindex("*pain25_2.wav");
  gi.soundindex("*pain50_1.wav");
  gi.soundindex("*pain50_2.wav");
  gi.soundindex("*pain75_1.wav");
  gi.soundindex("*pain75_2.wav");
  gi.soundindex("*pain100_1.wav");
  gi.soundindex("*pain100_2.wav");

  // sexed models -- lmctf60 (SKWiD MOD) replaces ctf's `#w_grapple.md2`
  // slot with `#w_plasma.md2`; WEAP_HOOK's grapple is a NEW slot in this
  // mod (see g_local.ts's header comment) so no #w_hook.md2 belongs here.
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
  gi.modelindex("#w_plasma.md2"); // SKWiD MOD

  //-------------------

  gi.soundindex("player/gasp1.wav");
  gi.soundindex("player/gasp2.wav");
  gi.soundindex("player/watr_in.wav");
  gi.soundindex("player/watr_out.wav");
  gi.soundindex("player/watr_un.wav");
  gi.soundindex("player/u_breath1.wav");
  gi.soundindex("player/u_breath2.wav");
  gi.soundindex("items/pkup.wav");
  gi.soundindex("world/land.wav");
  gi.soundindex("misc/h2ohit1.wav");
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
  gi.configstring(CS_LIGHTS + 63, "a");
}

//===================================================================
// CTF CODE -- LM_JORM: putonfloor / SP_info_flag_red / SP_info_flag_blue
// (lmctf60/g_spawn.c -- these three genuinely live in g_spawn.c, not
// g_ctffunc.c or g_misc.c, confirmed by direct source read).
//===================================================================

import { MASK_SOLID } from "../shared/q_shared";

/*
=================
putonfloor (lmctf60/g_spawn.c) -- drops an entity straight down by 128
units if the destination isn't solid; used by SP_info_flag_red/blue to
settle the flag-marker entity onto the ground after SP_misc_teleporter_dest
sets its model/solid.
=================
*/
export function putonfloor(ent: EdictT): void {
  const v = vec3(0, 0, -128);
  const dest = vec3();
  VectorCopy(ent.s.origin, dest);
  dest[0] += v[0];
  dest[1] += v[1];
  dest[2] += v[2];

  const tr = gi.trace(ent.s.origin, ent.mins, ent.maxs, dest, ent, MASK_SOLID);
  if (tr.startsolid) {
    // If we start solid, don't move us
    return;
  }

  VectorCopy(tr.endpos, ent.s.origin);
}

/*
=================
SP_info_flag_red / SP_info_flag_blue (lmctf60/g_spawn.c:733/748)

Map-placed flag marker entities: reskins a teleporter-destination model
(SP_misc_teleporter_dest, g_misc.ts) with a colored shell, renames the
classname, and records the global redflag/blueflag reference other code
reads (g_ctffunc.ts's ctf_flagwave, g_chase.ts, etc). These are the two
"info_flag_red"/"info_flag_blue" markers a real map places -- separate
from the "flag" pickup entity itself (g_items.ts's SP_flag/SpawnItem path).
=================
*/
export function SP_info_flag_red(self: EdictT): void {
  const deathmatch = gameCvars.deathmatch !== null && gameCvars.deathmatch.value !== 0;
  if (!deathmatch) {
    G_FreeEdict(self);
    return;
  }
  SP_misc_teleporter_dest(self);
  self.s.effects |= 0x00000100; // EF_COLOR_SHELL
  self.s.renderfx |= 1024; // RF_SHELL_RED
  self.classname = "info_flag_red";
  SetRedFlag(self);
  putonfloor(self);
}

export function SP_info_flag_blue(self: EdictT): void {
  const deathmatch = gameCvars.deathmatch !== null && gameCvars.deathmatch.value !== 0;
  if (!deathmatch) {
    G_FreeEdict(self);
    return;
  }
  SP_misc_teleporter_dest(self);
  self.s.effects |= 0x00000100; // EF_COLOR_SHELL
  self.s.renderfx |= 4096; // RF_SHELL_BLUE
  self.classname = "info_flag_blue";
  SetBlueFlag(self);
  putonfloor(self);
}

