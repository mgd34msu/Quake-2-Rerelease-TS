// g_spawn.c

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
  CVAR_SERVERINFO,
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
  SP_info_position,
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
import {
  CTFPrecache,
  CTFSpawn,
  ctf_statusbar,
  SP_info_player_team1,
  SP_info_player_team2,
  SP_info_teleport_destination,
  SP_misc_ctf_banner,
  SP_misc_ctf_small_banner,
  SP_trigger_teleport,
} from "./g_ctf";

// gameCvars entries are `CvarT | null` until InitGame resolves them (see
// g_main.ts's identical helper and comment). Mirrored locally here since
// g_main.ts does not export it and this file needs the same "not resolved
// yet reads as 0" behavior C gets for free from a live cvar_t pointer.
function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

// ctf/g_ctf.h: `extern cvar_t *ctf;` -- g_ctf.ts registers this cvar in
// CTFInit() but keeps the resulting CvarT reference module-local (per
// .orch/decisions.tsv's g_ctf.ts cvar-ownership note, same pattern as
// g_main.ts's ctfCvar()), so this file -- which only reads it -- re-fetches
// the same cvar object via gi.cvar() at each read site. gi.cvar() is
// idempotent (Cvar_Get semantics): once CTFInit() has registered "ctf",
// every later gi.cvar("ctf", ...) call returns that same CvarT.
function ctfCvar(): number {
  const c = gi.cvar("ctf", "1", CVAR_SERVERINFO);
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
// .orch/followups.md finding 14, extended to every LEGACY-family module
// (coordinator follow-up, same day: the ruling covers the family, and CTF
// loads rerelease-authored maps through the New Game selector the same way
// baseq2 does). Identical mechanism to src/game/g_spawn.ts's ED_ParseField/
// ED_CallSpawn/SpawnEntities: the frozen CTF game DLL dprintfs "<field> is
// not a field" / "<classname> doesn't have a spawn function" for every
// KEX-era key/entity a rerelease map carries; that per-line output is
// faithful, but at developer 0 it is unusable console flooding on
// rerelease data. Both message classes are counted instead of printed and
// rolled into one summary line at spawn completion (see SpawnEntities
// below); developer 1 restores the byte-identical vanilla per-line output.
// This module's own counter state (not shared with src/game/g_spawn.ts or
// any other sibling). Not added to gameCvars (g_local.ts) because that
// table mirrors only the cvar_t* externs the real game DLL declares in
// g_local.h/game.h, and vanilla has no such extern -- resolved dynamically
// here instead.
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
  { name: "info_player_team1", spawn: SP_info_player_team1 },
  { name: "info_player_team2", spawn: SP_info_player_team2 },

  { name: "func_plat", spawn: SP_func_plat },
  // ROGUE -- q2kctf2.bsp and ndctf0.bsp place func_plat2; ported into
  // g_func.ts from src/rogue/g_func.ts.
  { name: "func_plat2", spawn: SP_func_plat2 },
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
  // LM_JORM -- lmctf14.bsp and lmctf22.bsp place info_position; ported into
  // g_misc.ts from src/lmctf/g_misc.ts.
  { name: "info_position", spawn: SP_info_position },
  { name: "path_corner", spawn: SP_path_corner },
  { name: "point_combat", spawn: SP_point_combat },

  { name: "misc_explobox", spawn: SP_misc_explobox },
  { name: "misc_banner", spawn: SP_misc_banner },
  { name: "misc_ctf_banner", spawn: SP_misc_ctf_banner },
  { name: "misc_ctf_small_banner", spawn: SP_misc_ctf_small_banner },
  { name: "misc_satellite_dish", spawn: SP_misc_satellite_dish },
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
  { name: "trigger_teleport", spawn: SP_trigger_teleport },
  { name: "info_teleport_destination", spawn: SP_info_teleport_destination },
  { name: "misc_blackhole", spawn: SP_misc_blackhole },
  { name: "misc_eastertank", spawn: SP_misc_eastertank },
  { name: "misc_easterchick", spawn: SP_misc_easterchick },
  { name: "misc_easterchick2", spawn: SP_misc_easterchick2 },
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
  const out: string[] = [];
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
  const classname = ent.classname;

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

    // remove things (except the world) from different skill levels or deathmatch
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

  PlayerTrail_Init();

  CTFSpawn();
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
  "num 3 14";

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
    if (ctfCvar() !== 0) {
      gi.configstring(CS_STATUSBAR, ctf_statusbar);
      // precaches
      CTFPrecache();
    } else {
      gi.configstring(CS_STATUSBAR, dm_statusbar);
    }
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
  gi.modelindex("#w_grapple.md2");
  // RERELEASE CONTENT PORT -- the seven mission-pack weapons' vwep models,
  // in WEAP_PHALANX(13) .. WEAP_CHAINFIST(19) order (see g_local.ts's
  // re-release constants block: this module keeps ctf's WEAP_GRAPPLE at 12,
  // so the incoming weapons take 13..19 rather than src/game's 12..19).
  // THIS ORDER MUST MATCH THOSE DEFINES: the client turns s.skinnum >> 8
  // into an index over exactly the "#"-prefixed models registered here, and
  // its cap is MAX_CLIENTWEAPONMODELS = 20, so 19 is the last usable slot.
  gi.modelindex("#w_phalanx.md2");
  gi.modelindex("#w_ripper.md2");
  gi.modelindex("#w_disrupt.md2");
  gi.modelindex("#w_etfrifle.md2");
  gi.modelindex("#w_plasma.md2");
  gi.modelindex("#w_plauncher.md2");
  gi.modelindex("#w_chainfist.md2");

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
