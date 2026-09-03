// Ports lmctf60/g_local.h -- local definitions for the LM_CTF (Loki's
// Minions CTF) game module.
//
// Diff-derived from the already-ported src/ctf/g_local.ts (lmctf60/g_local.h
// vs quake-2/ctf/g_local.h): LM_CTF keeps the c11-maintained baseq2/ctf
// shape but replaces ZOID's ctf_grapple/ctf_grapplestate single-field
// grapple with its own hookstate/hook/hooklength/hookangle machine, drops
// ZOID's pmenuhnd_t popup-menu system for its own g_menu.c menuitem/localmenu
// system, drops the built-in flood_locktill/flood_when/flood_whenhead
// protection for its own spam_lock_time/spam_freq_time/spam_band_count
// system, drops ghost-code reconnect support entirely, and drops ZOID's
// tech powerups (IT_TECH) and WEAP_GRAPPLE (that weapon-model slot is reused
// by WEAP_PLASMA in LM_CTF; the grapple is WEAP_HOOK, a new slot).
//
// The C header does `#define GAME_INCLUDE` before including game.h so that
// game.h's short server-visible edict_t/gclient_t are skipped and the full
// versions below are used instead. In this port that's just "g_local.ts
// defines the full EdictT/GClientT classes; game.ts's Edict interface is
// the short, server-visible shape EdictT implements."

import { vec3, type Vec3 } from "../shared/math";
import {
  type CplaneT,
  type CsurfaceT,
  type CvarT,
  EntityStateT,
  MAX_ITEMS,
  PlayerStateT,
  PmoveStateT,
} from "../shared/q_shared";
import {
  type Edict,
  type GameExports,
  type GameImports,
  type GTraceT,
  LinkT,
  MAX_ENT_CLUSTERS,
  SolidT,
} from "./game";

// lmctf60/g_local.h: `#define GAMEVERSION "LMCTF TE 6.0"`
export const GAMEVERSION = "LMCTF TE 6.0";

// protocol bytes that can be directly added to messages
export const svc_muzzleflash = 1;
export const svc_muzzleflash2 = 2;
export const svc_temp_entity = 3;
export const svc_layout = 4;
export const svc_inventory = 5;
// lmctf60/g_local.h adds this (ctf's g_local.h does not declare it, but
// ctf's g_ctf.c uses the same wire value); used by ForceCommand (g_cmds.ts)
// to stuff a console command into a client.
export const svc_stufftext = 11;

// lmctf60 declares this in its own forked copy of q_shared.h
// (`#define CHAN_CTF 5 // LM_JORM -- CTF code`), not g_local.h -- kept here
// instead of src/shared/q_shared.ts (the one cross-family shared module)
// per this family's established pattern of keeping LM_CTF-only additions
// local to g_local.ts rather than growing the shared header for one mod
// family (see MOD_CTF_GRAPPLE above for the same treatment).
export const CHAN_CTF = 5;

//==================================================================

// view pitching times
export const DAMAGE_TIME = 0.5;
export const FALL_TIME = 0.3;

// edict->spawnflags
// these are set with checkboxes on each entity in the map editor
export const SPAWNFLAG_NOT_EASY = 0x00000100;
export const SPAWNFLAG_NOT_MEDIUM = 0x00000200;
export const SPAWNFLAG_NOT_HARD = 0x00000400;
export const SPAWNFLAG_NOT_DEATHMATCH = 0x00000800;
export const SPAWNFLAG_NOT_COOP = 0x00001000;

// edict->flags
export const FL_FLY = 0x00000001;
export const FL_SWIM = 0x00000002; // implied immunity to drowining
export const FL_IMMUNE_LASER = 0x00000004;
export const FL_INWATER = 0x00000008;
export const FL_GODMODE = 0x00000010;
export const FL_NOTARGET = 0x00000020;
export const FL_IMMUNE_SLIME = 0x00000040;
export const FL_IMMUNE_LAVA = 0x00000080;
export const FL_PARTIALGROUND = 0x00000100; // not all corners are valid
export const FL_WATERJUMP = 0x00000200; // player jumping out of water
export const FL_TEAMSLAVE = 0x00000400; // not the first on the team
export const FL_NO_KNOCKBACK = 0x00000800;
export const FL_POWER_ARMOR = 0x00001000; // power armor (if any) is active
export const FL_RESPAWN = 0x80000000; // used for item respawning

export const FRAMETIME = 0.1;

// damage flags (g_combat.c's T_Damage `dflags` parameter -- not edict->flags)
export const DAMAGE_RADIUS = 0x00000001; // damage was indirect
export const DAMAGE_NO_ARMOR = 0x00000002; // armour does not protect from this damage
export const DAMAGE_ENERGY = 0x00000004; // damage is from an energy based weapon
export const DAMAGE_NO_KNOCKBACK = 0x00000008; // do not affect velocity, just view angles
export const DAMAGE_BULLET = 0x00000010; // damage is from a bullet (used for ricochets)
export const DAMAGE_NO_PROTECTION = 0x00000020; // armor, shields, invulnerability, and godmode have no effect

// Memory tags (TAG_GAME / TAG_LEVEL) are DROPPED per PORTING.md, same as
// every other pack: "Z_Malloc/Z_Free/Hunk_*/Z_TagMalloc -> plain
// allocation."

export const MELEE_DISTANCE = 80;

export const BODY_QUEUE_SIZE = 8;

export enum DamageT {
  DAMAGE_NO,
  DAMAGE_YES, // will take damage if hit
  DAMAGE_AIM, // auto targeting recognizes this
}

export enum WeaponstateT {
  WEAPON_READY,
  WEAPON_ACTIVATING,
  WEAPON_DROPPING,
  WEAPON_FIRING,
}

export enum AmmoT {
  AMMO_BULLETS,
  AMMO_SHELLS,
  AMMO_ROCKETS,
  AMMO_GRENADES,
  AMMO_CELLS,
  AMMO_SLUGS,
  // =====================================================================
  // RERELEASE CONTENT PORT -- the six ammo types the ported rerelease
  // weapons consume. Appended after vanilla's six so every vanilla ammo
  // type keeps its existing numeric value (gitem_t.tag and Add_Ammo's
  // cap lookup both dispatch on exactly this value).
  //
  // A REAL NUMERIC COLLISION IS RESOLVED HERE. rogue/g_local.h appends
  // AMMO_FLECHETTES/AMMO_TESLA/AMMO_PROX as 6/7/8, and xatrix/g_local.h
  // INDEPENDENTLY appends AMMO_MAGSLUG/AMMO_TRAP as 6/7 -- each pack
  // numbered from the end of vanilla's list without knowing about the
  // other. Merged naively, a Mag Slug pickup would dispatch into the
  // flechette cap and a Trap into the tesla cap. rogue keeps 6/7/8
  // (matching the rerelease's own ammo_t ordering) and xatrix's two move
  // above them; AMMO_DISRUPTOR follows.
  // =====================================================================
  AMMO_FLECHETTES, // 6  (rogue)
  AMMO_TESLA, // 7  (rogue)
  AMMO_PROX, // 8  (rogue)
  AMMO_MAGSLUG, // 9  (xatrix, renumbered from 6)
  AMMO_TRAP, // 10 (xatrix, renumbered from 7)
  AMMO_DISRUPTOR, // 11
}

// deadflag
export const DEAD_NO = 0;
export const DEAD_DYING = 1;
export const DEAD_DEAD = 2;
export const DEAD_RESPAWNABLE = 3;

// range
export const RANGE_MELEE = 0;
export const RANGE_NEAR = 1;
export const RANGE_MID = 2;
export const RANGE_FAR = 3;

// gib types
export const GIB_ORGANIC = 0;
export const GIB_METALLIC = 1;

// monster ai flags -- MONSTERS_OK is never defined in lmctf60's Makefile
// (verified: `grep MONSTERS_OK Makefile` -> no hits), so every monster file
// (g_ai.c, g_monster.c, g_turret.c, all m_*.c) compiles to nothing and these
// flags are never read at runtime. Kept only because EdictT/MonsterInfoT
// below still declare monsterinfo (g_local.h's struct layout includes it
// unconditionally); no monster ever spawns to use them. See PORTING.md's
// "#ifdef ... take the portable path; list dropped branches" convention --
// applied here at subsystem scale rather than per-branch.
export const AI_STAND_GROUND = 0x00000001;
export const AI_TEMP_STAND_GROUND = 0x00000002;
export const AI_SOUND_TARGET = 0x00000004;
export const AI_LOST_SIGHT = 0x00000008;
export const AI_PURSUIT_LAST_SEEN = 0x00000010;
export const AI_PURSUE_NEXT = 0x00000020;
export const AI_PURSUE_TEMP = 0x00000040;
export const AI_HOLD_FRAME = 0x00000080;
export const AI_GOOD_GUY = 0x00000100;
export const AI_BRUTAL = 0x00000200;
export const AI_NOSTEP = 0x00000400;
export const AI_DUCKED = 0x00000800;
export const AI_COMBAT_POINT = 0x00001000;
export const AI_MEDIC = 0x00002000;
export const AI_RESURRECTING = 0x00004000;

// monster attack state
export const AS_STRAIGHT = 1;
export const AS_SLIDING = 2;
export const AS_MELEE = 3;
export const AS_MISSILE = 4;

// armor types
export const ARMOR_NONE = 0;
export const ARMOR_JACKET = 1;
export const ARMOR_COMBAT = 2;
export const ARMOR_BODY = 3;
export const ARMOR_SHARD = 4;

// power armor types
export const POWER_ARMOR_NONE = 0;
export const POWER_ARMOR_SCREEN = 1;
export const POWER_ARMOR_SHIELD = 2;

// handedness values
export const RIGHT_HANDED = 0;
export const LEFT_HANDED = 1;
export const CENTER_HANDED = 2;

// game.serverflags values
export const SFL_CROSS_TRIGGER_1 = 0x00000001;
export const SFL_CROSS_TRIGGER_2 = 0x00000002;
export const SFL_CROSS_TRIGGER_3 = 0x00000004;
export const SFL_CROSS_TRIGGER_4 = 0x00000008;
export const SFL_CROSS_TRIGGER_5 = 0x00000010;
export const SFL_CROSS_TRIGGER_6 = 0x00000020;
export const SFL_CROSS_TRIGGER_7 = 0x00000040;
export const SFL_CROSS_TRIGGER_8 = 0x00000080;
export const SFL_CROSS_TRIGGER_MASK = 0x000000ff;

// noise types for PlayerNoise
export const PNOISE_SELF = 0;
export const PNOISE_WEAPON = 1;
export const PNOISE_IMPACT = 2;

// edict->movetype values
export enum MovetypeT {
  MOVETYPE_NONE, // never moves
  MOVETYPE_NOCLIP, // origin and angles change with no interaction
  MOVETYPE_PUSH, // no clip to world, push on box contact
  MOVETYPE_STOP, // no clip to world, stops on box contact

  MOVETYPE_WALK, // gravity
  MOVETYPE_STEP, // gravity, special edge handling
  MOVETYPE_FLY,
  MOVETYPE_TOSS, // gravity
  MOVETYPE_FLYMISSILE, // extra size to monsters
  MOVETYPE_BOUNCE,
  // lmctf60/g_local.h: `MOVETYPE_REFLECT // SKWiD MOD END` -- used by the
  // plasma rifle's bouncing bolt (plasma.c, not in this unit's SCOPE).
  MOVETYPE_REFLECT,
  // RERELEASE CONTENT PORT (xatrix/g_local.h's `// RAFAEL -- move type for
  // rippergun projectile`): the ion ripper's projectile bounces off walls
  // with a stronger backoff than MOVETYPE_BOUNCE, re-orients its model to
  // the new travel direction on each hit, ignores gravity, and never
  // settles on the ground. Appended AFTER LM-CTF's own MOVETYPE_REFLECT so
  // every existing movetype keeps its value (savegames and the g_phys
  // dispatch both key off these).
  MOVETYPE_WALLBOUNCE,
}

export class GitemArmorT {
  base_count = 0;
  max_count = 0;
  normal_protection = 0;
  energy_protection = 0;
  armor = 0;
}

// gitem_t->flags
export const IT_WEAPON = 1; // use makes active weapon
export const IT_AMMO = 2;
export const IT_ARMOR = 4;
export const IT_STAY_COOP = 8;
export const IT_KEY = 16;
export const IT_POWERUP = 32;
// NOTE: ctf/g_local.h's `IT_TECH 64` (ZOID tech powerups) is REMOVED in
// lmctf60/g_local.h (diff confirmed: the `//ZOID #define IT_TECH 64 //ZOID`
// block is deleted, not just reformatted). LM_CTF has no tech powerups;
// intentionally not carried over.

// gitem_t->weapmodel for weapons indicates model index
export const WEAP_BLASTER = 1;
export const WEAP_SHOTGUN = 2;
export const WEAP_SUPERSHOTGUN = 3;
export const WEAP_MACHINEGUN = 4;
export const WEAP_CHAINGUN = 5;
export const WEAP_GRENADES = 6;
export const WEAP_GRENADELAUNCHER = 7;
export const WEAP_ROCKETLAUNCHER = 8;
export const WEAP_HYPERBLASTER = 9;
export const WEAP_RAILGUN = 10;
export const WEAP_BFG = 11;
// lmctf60/g_local.h: ctf's `WEAP_GRAPPLE 12` slot is reused --
// `// SKWiD MOD #define WEAP_PLASMA 12 // END #define WEAP_HOOK 13`. The
// grapple hook is its own weapon-model slot (13), not 12.
export const WEAP_PLASMA = 12;
export const WEAP_HOOK = 13;

export class GItemT {
  classname: string | null = null; // spawning name
  pickup: ((ent: EdictT, other: EdictT) => boolean) | null = null;
  use: ((ent: EdictT, item: GItemT) => void) | null = null;
  drop: ((ent: EdictT, item: GItemT) => void) | null = null;
  weaponthink: ((ent: EdictT) => void) | null = null;
  pickup_sound: string | null = null;
  world_model: string | null = null;
  world_model_flags = 0;
  view_model: string | null = null;

  // client side info
  icon: string | null = null;
  pickup_name: string | null = null; // for printing on pickup
  count_width = 0; // number of digits to display by icon

  quantity = 0; // for ammo how much, for weapons how much is used per shot
  ammo: string | null = null; // for weapons
  flags = 0; // IT_* flags

  weapmodel = 0; // weapon model index (for weapons)

  // `void *info` is never used; kept as `unknown` (never `any`) rather than
  // dropped, since g_local.h declares it.
  info: unknown = null;
  tag = 0;

  precaches: string | null = null; // string of all models, sounds, and images this item will use
}

//
// this structure is left intact through an entire game
// it should be initialized at dll load time, and read/written to
// the server.ssv file for savegames
//
export class GameLocalsT {
  helpmessage1 = ""; // char[512]
  helpmessage2 = ""; // char[512]
  helpchanged = 0; // flash F1 icon if non 0, play sound
  // and increment only if 1, 2, or 3

  clients: GClientT[] = []; // [maxclients]

  // can't store spawnpoint in level, because
  // it would get overwritten by the savegame restore
  spawnpoint = ""; // char[512] -- needed for coop respawns

  // store latched cvars here that we want to get at often
  maxclients = 0;
  maxentities = 0;

  // cross level triggers
  serverflags = 0;

  // RERELEASE CONTENT PORT: game_locals_t::cross_unit_flags from
  // src/kexgame/. Distinct from `serverflags` above, which is the classic
  // CROSS_LEVEL flag word: cross_unit_flags is the rerelease's separate
  // CROSS_UNIT word, set by target_crossunit_trigger and tested by
  // target_crossunit_target. It lives on GameLocalsT rather than
  // LevelLocalsT precisely because it must survive a level change -- that
  // cross-unit lifetime is the entity pair's whole purpose -- and it is
  // serialized alongside serverflags in g_save.ts so it also survives a
  // save/load.
  cross_unit_flags = 0;

  // items
  num_items = 0;

  autosaved = false;
  // lmctf60/g_local.h adds this field to game_locals_t.
  teamslocked = false;

  clear(): void {
    Object.assign(this, new GameLocalsT());
  }
}

//
// this structure is cleared as each map is entered
// it is read/written to the level.sav file for savegames
//
export class LevelLocalsT {
  framenum = 0;
  time = 0;

  level_name = ""; // char[MAX_QPATH] -- the descriptive name (Outer Base, etc)
  mapname = ""; // char[MAX_QPATH] -- the server name (base1, etc)
  nextmap = ""; // char[MAX_QPATH] -- go here when fraglimit is hit
  // NOTE: ctf/g_local.h's `forcemap[MAX_QPATH]` is REMOVED in lmctf60's
  // level_locals_t (confirmed by diff). Not carried over.

  // intermission state
  intermissiontime = 0; // time the intermission was started
  changemap: string | null = null;
  exitintermission = 0;
  intermission_origin: Vec3 = vec3();
  intermission_angle: Vec3 = vec3();

  sight_client: EdictT | null = null; // changed once each frame for coop games

  sight_entity: EdictT | null = null;
  sight_entity_framenum = 0;
  sound_entity: EdictT | null = null;
  sound_entity_framenum = 0;
  sound2_entity: EdictT | null = null;
  sound2_entity_framenum = 0;

  pic_health = 0;

  total_secrets = 0;
  found_secrets = 0;

  total_goals = 0;
  found_goals = 0;

  total_monsters = 0;
  killed_monsters = 0;

  current_entity: EdictT | null = null; // entity running from G_RunFrame
  body_que = 0; // dead bodies

  power_cubes = 0; // ugly necessity for coop

  // RERELEASE CONTENT PORT -- level fields the rerelease content needs.
  // From src/rogue/g_local.ts: the disguise/stalker "violation" bookkeeping
  // that trigger_disguise sets and the stalker AI reads. No 1997 entity
  // writes either one, so both stay at their zero/null defaults there.
  disguise_violator: EdictT | null = null;
  disguise_violation_framenum = 0;

  clear(): void {
    Object.assign(this, new LevelLocalsT());
  }
}

// spawn_temp_t is only used to hold entity field values that
// can be set from the editor, but aren't actualy present
// in edict_t during gameplay
// =========================================================================
// RERELEASE CONTENT PORT -- the three sub-structs the rerelease entity set
// hangs off an edict, ported from src/kexgame/g_local_types.ts.
//
// PROTOCOL NOTE (the degradations are real and deliberate): the fog and
// heightfog blocks are set by the ported trigger_fog and by worldspawn, and
// the rerelease client receives them through a dedicated fog message that
// protocol 34 does not have. Under the classic ruleset the values are
// parsed, stored, and updated on the server exactly as the rerelease does
// -- so trigger_fog fires, targets, and holds correct state -- but nothing
// transmits them, so the view is unfogged. The entity is never dropped.
// BmodelAnimT by contrast DOES present under protocol 34: it animates
// s.frame on a brush model, and s.frame is part of the baseline entity
// state every protocol carries.
// =========================================================================
export class FogT {
  color: Vec3 = vec3();
  density = 0;
  sky_factor = 0;
  color_off: Vec3 = vec3();
  density_off = 0;
  sky_factor_off = 0;
}

export class HeightFogT {
  falloff = 0;
  density = 0;
  start_color: Vec3 = vec3();
  start_dist = 0;
  end_color: Vec3 = vec3();
  end_dist = 0;
  falloff_off = 0;
  density_off = 0;
  start_color_off: Vec3 = vec3();
  start_dist_off = 0;
  end_color_off: Vec3 = vec3();
  end_dist_off = 0;
}

export class BmodelAnimT {
  // range, inclusive
  start = 0;
  end = 0;
  style = 0;
  speed = 0; // in milliseconds
  nowrap = false;

  alt_start = 0;
  alt_end = 0;
  alt_style = 0;
  alt_speed = 0; // in milliseconds
  alt_nowrap = false;

  // game-only
  enabled = false;
  alternate = false;
  currently_alternate = false;
  // gtime_t in the rerelease; the classic module keeps level.time in plain
  // seconds, so this is a seconds float on the same clock.
  next_tick = 0;
}

export class SpawnTempT {
  // world vars
  sky: string | null = null;
  skyrotate = 0;
  skyaxis: Vec3 = vec3();
  nextmap: string | null = null;

  lip = 0;
  distance = 0;
  height = 0;
  noise: string | null = null;
  pausetime = 0;
  item: string | null = null;
  gravity: string | null = null;

  minyaw = 0;
  maxyaw = 0;
  minpitch = 0;
  maxpitch = 0;

  // =====================================================================
  // RERELEASE CONTENT PORT -- spawn_temp_t keys the rerelease maps carry.
  //
  // Ported from src/kexgame/g_local_types.ts's SpawnTempT (the rerelease
  // game DLL's own spawn_temp_t). These are parse-time-only scratch keys:
  // ED_ParseField writes them into the single shared `st` and the spawn
  // function reads them before `st` is cleared for the next entity, so
  // adding them costs nothing at runtime and changes no vanilla behavior
  // (no vanilla 3.21 entity names any of these keys).
  //
  // Without them every rerelease map logs each one as "<key> is not a
  // field", and -- worse -- the entity that needed the value silently
  // spawns wrong. shadowlight* in particular is read by the rerelease
  // dynamic/shadow light entities this port now spawns.
  // =====================================================================
  // g_local.h:1274 declares `int32_t skyautorotate = 1;` (default 1, not 0)
  // -- see src/kexgame/g_spawn.ts's header comment (the canonical
  // defaultSpawnTemp() for the OTHER game module) for the same latent
  // default-value bug independently repeated in four other files before
  // that one existed. This field was still wrong here; a worldspawn that
  // never explicitly sets skyautorotate (the overwhelmingly common case)
  // must default to "spin continuously", matching the rerelease game DLL.
  skyautorotate = 1;
  music: string | null = null;
  instantitems = 0;
  radius = 0;
  hub_map = 0;
  achievement: string | null = null;
  goals: string | null = null;
  image: string | null = null;
  // misc_flare's distance fade, and NOT 0: the re-release declares these with
  // real defaults (src/kexgame/g_local_types.ts:319-320, itself g_local.h's
  // `int32_t fade_start_dist = 96; int32_t fade_end_dist = 384;`), and every
  // shipped misc_flare relies on them -- none of the 53 in mgu2m3 spells
  // either key. They ride the wire in s.modelindex2/s.modelindex3 and the
  // client's RF_FLARE branch (cl_ents.ts) computes the flare's alpha from
  // them: with both at 0 the ramp collapses to "always fully opaque", so the
  // flare that should fade in with distance is drawn at full strength from
  // any range. Harmless while nothing rendered flares at all; wrong now that
  // a widened classic session does. No effect on any vanilla entity -- these
  // are re-release-only spawn keys read only by SP_misc_flare.
  fade_start_dist = 96;
  fade_end_dist = 384;
  start_items: string | null = null;
  no_grapple = 0;
  // Default 1.0, NOT 0 -- kexgame/g_spawn.ts:707 (`health_multiplier: 1.0`,
  // itself g_local.h:1306's `float health_multiplier = 1.0f`). Every ported
  // rerelease monster sets its health as
  // `Math.trunc(<base> * st.health_multiplier)`, so a 0 default would give
  // every one of them 0 health on any map that does not explicitly write
  // the key -- i.e. almost all of them. SpawnTempT.clear() restores this
  // default per entity via `new SpawnTempT()`, matching the C's
  // memset-then-initialize of the aggregate.
  health_multiplier = 1.0;
  reinforcements: string | null = null;
  noise_start: string | null = null;
  noise_middle: string | null = null;
  noise_end: string | null = null;
  loop_count = 0;
  // Shadow-light keys. The classic renderer has no shadow-light pass and
  // protocol 34 has no message that could carry one, so these are parsed
  // and stored (so the entity spawns complete and a future renderer can
  // read them) but have no visual effect under the classic ruleset -- see
  // the dynamic_light / target_light notes in the port report.
  shadowlightradius = 0;
  shadowlightresolution = 0;
  shadowlightintensity = 0;
  shadowlightstartfadedistance = 0;
  shadowlightendfadedistance = 0;
  shadowlightstyle = 0;
  shadowlightconeangle = 0;
  shadowlightstyletarget: string | null = null;

  clear(): void {
    Object.assign(this, new SpawnTempT());
  }
}

export class MoveinfoT {
  // fixed data
  start_origin: Vec3 = vec3();
  start_angles: Vec3 = vec3();
  end_origin: Vec3 = vec3();
  end_angles: Vec3 = vec3();

  sound_start = 0;
  sound_middle = 0;
  sound_end = 0;

  accel = 0;
  speed = 0;
  decel = 0;
  distance = 0;

  wait = 0;

  // state data
  state = 0;
  dir: Vec3 = vec3();
  current_speed = 0;
  move_speed = 0;
  next_speed = 0;
  remaining_distance = 0;
  decel_distance = 0;
  endfunc: ((self: EdictT) => void) | null = null;
}

export class MframeT {
  aifunc: ((self: EdictT, dist: number) => void) | null = null;
  dist = 0;
  thinkfunc: ((self: EdictT) => void) | null = null;
}

export class MmoveT {
  #firstframe = 0;
  #lastframe = 0;
  #frame: MframeT[] = [];
  endfunc: ((self: EdictT) => void) | null = null;

  allowFrameCountMismatch = false;

  get firstframe(): number {
    return this.#firstframe;
  }

  set firstframe(value: number) {
    this.#firstframe = value;
  }

  get lastframe(): number {
    return this.#lastframe;
  }

  set lastframe(value: number) {
    this.#lastframe = value;
  }

  get frame(): MframeT[] {
    return this.#frame;
  }

  set frame(value: MframeT[]) {
    const expected = this.#lastframe - this.#firstframe + 1;
    if (value.length !== expected && !this.allowFrameCountMismatch) {
      throw new Error(
        `MmoveT: firstframe=${this.#firstframe} lastframe=${this.#lastframe} expects ${expected} frames (lastframe-firstframe+1), got ${value.length}`,
      );
    }
    this.#frame = value;
  }
}

// MONSTERS_OK dead subsystem (see AI_* comment above): kept only because
// EdictT.monsterinfo needs a type.
export class MonsterInfoT {
  currentmove: MmoveT | null = null;
  aiflags = 0;
  nextframe = 0;
  scale = 0;

  stand: ((self: EdictT) => void) | null = null;
  idle: ((self: EdictT) => void) | null = null;
  search: ((self: EdictT) => void) | null = null;
  walk: ((self: EdictT) => void) | null = null;
  run: ((self: EdictT) => void) | null = null;
  // RERELEASE CONTENT PORT: widened from the 3-argument vanilla 3.21
  // signature to rogue/g_local.h's 4-argument one, which passes the trace
  // from the shot that triggered the dodge through to the handler
  // (M_MonsterDodge, ported into g_newai.ts, needs it to decide duck vs
  // sidestep). Vanilla's own 3-argument dodge handlers (soldier_dodge,
  // chick_dodge, gunner_dodge, infantry_dodge, brain_dodge, medic_dodge)
  // stay assignable to this type unchanged -- a function accepting FEWER
  // parameters is assignable to a type declaring more -- so only the one
  // call site in g_weapon.ts had to start passing the trace.
  dodge: ((self: EdictT, other: EdictT, eta: number, tr: GTraceT) => void) | null = null;
  attack: ((self: EdictT) => void) | null = null;
  melee: ((self: EdictT) => void) | null = null;
  sight: ((self: EdictT, other: EdictT) => void) | null = null;
  checkattack: ((self: EdictT) => boolean) | null = null;

  pausetime = 0;
  attack_finished = 0;

  saved_goal: Vec3 = vec3();
  search_time = 0;
  trail_time = 0;
  last_sighting: Vec3 = vec3();
  attack_state = 0;
  lefty = 0;
  idle_time = 0;
  linkcount = 0;

  power_armor_type = 0;
  power_armor_power = 0;

  // ===================================================================
  // RERELEASE CONTENT PORT -- fields the rerelease content set needs.
  //
  // Ported verbatim from src/rogue/g_local.ts's own MonsterInfoT (the
  // "// ROGUE" block), which is itself the faithful port of rogue's
  // g_local.h. The rerelease game DLL folded the mission-pack monster AI
  // (hint paths, ducking/sidestep dodging, blindfire, medic-commander
  // healing bookkeeping, monster-slot budgets for the spawners, and the
  // widow's powerup timers) into the one base monster struct, so the
  // classic module needs the same fields to host that content. Vanilla
  // 3.21 monsters never read or write any of them, so their presence is
  // inert for classic maps: every one defaults to the same zero/null the
  // C aggregate initializer produced.
  // ===================================================================
  blocked: ((self: EdictT, dist: number) => boolean) | null = null;
  last_hint_time = 0; // last time the monster checked for hintpaths.
  goal_hint: EdictT | null = null; // which hint_path we're trying to get to
  medicTries = 0;
  badMedic1: EdictT | null = null; // these medics have declared this monster "unhealable"
  badMedic2: EdictT | null = null;
  healer: EdictT | null = null; // this is who is healing this monster
  duck: ((self: EdictT, eta: number) => void) | null = null;
  unduck: ((self: EdictT) => void) | null = null;
  sidestep: ((self: EdictT) => void) | null = null;
  base_height = 0;
  next_duck_time = 0;
  duck_wait_time = 0;
  last_player_enemy: EdictT | null = null;
  // blindfire: the boolean says whether the monster will do it,
  // blind_fire_delay is the timing (set in the monster) of the next shot
  blindfire = false;
  blind_fire_delay = 0;
  blind_fire_target: Vec3 = vec3();
  // used by the spawners to not spawn too much and keep track of #s of
  // monsters spawned
  monster_slots = 0;
  monster_used = 0;
  commander: EdictT | null = null;
  // powerup timers, used by the widow
  quad_framenum = 0;
  invincible_framenum = 0;
  double_framenum = 0;

  // --- rerelease (kex) monsterinfo fields, from src/kexgame/ ---
  // Needed by the rerelease monsters this module now hosts: the arachnid
  // and gun commander throttle their melee with melee_debounce_time, the
  // shambler and gun commander swap to a damaged skin through setskin, and
  // the gun commander's jump/drop decisions read can_jump/jump_height/
  // drop_height. Vanilla monsters set none of them.
  melee_debounce_time = 0;
  setskin: ((self: EdictT) => void) | null = null;
  can_jump = false;
  drop_height = 0;
  jump_height = 0;
}

// means of death
export const MOD_UNKNOWN = 0;
export const MOD_BLASTER = 1;
export const MOD_SHOTGUN = 2;
export const MOD_SSHOTGUN = 3;
export const MOD_MACHINEGUN = 4;
export const MOD_CHAINGUN = 5;
export const MOD_GRENADE = 6;
export const MOD_G_SPLASH = 7;
export const MOD_ROCKET = 8;
export const MOD_R_SPLASH = 9;
export const MOD_HYPERBLASTER = 10;
export const MOD_RAILGUN = 11;
export const MOD_BFG_LASER = 12;
export const MOD_BFG_BLAST = 13;
export const MOD_BFG_EFFECT = 14;
export const MOD_HANDGRENADE = 15;
export const MOD_HG_SPLASH = 16;
export const MOD_WATER = 17;
export const MOD_SLIME = 18;
export const MOD_LAVA = 19;
export const MOD_CRUSH = 20;
export const MOD_TELEFRAG = 21;
export const MOD_FALLING = 22;
export const MOD_SUICIDE = 23;
export const MOD_HELD_GRENADE = 24;
export const MOD_EXPLOSIVE = 25;
export const MOD_BARREL = 26;
export const MOD_BOMB = 27;
export const MOD_EXIT = 28;
export const MOD_SPLASH = 29;
export const MOD_TARGET_LASER = 30;
export const MOD_TRIGGER_HURT = 31;
export const MOD_HIT = 32;
export const MOD_TARGET_BLASTER = 33;
// NOTE: ctf/g_local.h's `MOD_GRAPPLE 34` is REMOVED in lmctf60. LM_CTF's
// grapple hook uses its own means-of-death code, declared far from the rest
// of this table (`lmctf60/g_local.h: #define MOD_CTF_GRAPPLE 60 //SURT
// ctf`), separate identifier space from ThreeWave's MOD_GRAPPLE.
export const MOD_CTF_GRAPPLE = 60;
export const MOD_FRIENDLY_FIRE = 0x8000000;

export const meansOfDeathHolder: { meansOfDeath: number } = { meansOfDeath: MOD_UNKNOWN };

// NOTE: ctf/g_local.h's `extern qboolean is_quad;` is REMOVED in lmctf60.
// lmctf60/p_weapon.c redeclares it as `static qboolean is_quad;` -- a
// translation-unit-local variable, not a cross-file extern. Per PORTING.md
// ("C globals that are reassigned pointers... become fields on their owning
// singleton"), a file-static C global with no cross-file readers becomes a
// plain module-scoped `let` in the file that ports it (p_weapon.ts), not a
// holder here. No isQuadHolder in this module (deliberate divergence from
// src/ctf/g_local.ts, which does have one because ctf/g_local.h externs it).

// item spawnflags
export const ITEM_TRIGGER_SPAWN = 0x00000001;
export const ITEM_NO_TOUCH = 0x00000002;
// 6 bits reserved for editor flags
// 8 bits used as power cube id bits for coop games
export const DROPPED_ITEM = 0x00010000;
export const DROPPED_PLAYER_ITEM = 0x00020000;
export const ITEM_TARGETS_USED = 0x00040000;

//
// fields are needed for spawning from the entity string
// and saving / loading games
//
export const FFL_SPAWNTEMP = 1;
// lmctf60/g_local.h adds this flag (used by g_save.c's fields[] table to
// mark fields that must never be (re)spawned from a save, e.g. the new
// function-pointer/mmove-table fields below).
export const FFL_NOSPAWN = 2;

export enum FieldtypeT {
  F_INT,
  F_FLOAT,
  F_LSTRING, // string on disk, pointer in memory, TAG_LEVEL
  F_GSTRING, // string on disk, pointer in memory, TAG_GAME
  F_VECTOR,
  F_ANGLEHACK,
  F_EDICT, // index on disk, pointer in memory
  F_ITEM, // index on disk, pointer in memory
  F_CLIENT, // index on disk, pointer in memory
  // lmctf60/g_local.h adds these two field kinds to fieldtype_t (used by
  // g_save.c for currmenu/prevmenu function pointers and monsterinfo.currentmove).
  F_FUNCTION,
  F_MMOVE,
  F_IGNORE,
}

// `field_t.ofs` is dropped for the same reason src/ctf/g_local.ts drops it
// (see that file's comment): no struct memory layout to take the address of
// in TypeScript. g_save.ts must address fields by property name.
export class FieldT {
  name = "";
  type: FieldtypeT = FieldtypeT.F_IGNORE;
  flags = 0;
}

//============================================================================

// client_t->anim_priority
export const ANIM_BASIC = 0; // stand / run
export const ANIM_WAVE = 1;
export const ANIM_JUMP = 2;
export const ANIM_PAIN = 3;
export const ANIM_ATTACK = 4;
export const ANIM_DEATH = 5;
export const ANIM_REVERSE = 6;

// lmctf60/g_local.h ADC squad-board additions.
export const MAX_CATEGORY_LEN = 16;
export const MAX_STATUS_LEN = 32;
export const UNSET_CATEGORY_STR = "Misc";
export const GREEN_STATUS_STR = "Ready";
export const UNSET_STATUS_STR = "Unknown";
export const RESPAWNED_STATUS_STR = "Respawned";

// lmctf60/g_menu.h: `typedef struct { char *text; void (*func)(edict_t
// *ent); } menuitem;` -- LM_CTF's own popup-menu system (g_menu.c), which
// replaces ZOID's pmenuhnd_t entirely (ctf/g_local.h's `#include
// "p_menu.h"` / `pmenuhnd_t *menu` field are both gone from lmctf60). Full
// menu behavior lives in g_menu.ts (not in this unit's SCOPE); declared
// here, not there, because GClientT.localmenu below needs the type and
// g_local.ts must not import a value from a sibling module for a type it
// can declare directly (avoids a load-order cycle).
export class MenuItemT {
  text: string | null = null;
  func: ((ent: EdictT) => void) | null = null;
}

// lmctf60/p_stats.h: `stats_client_s` / `stats_player_s` (LM_Hati's
// persistent-stats subsystem, p_stats.c). `MAX_PLAYER_STATS` (15) is
// p_stats.h's `STATS_*` index count; ported as a plain length here since
// the STATS_* index #defines themselves belong to p_stats.ts (not in this
// unit's SCOPE).
export const MAX_PLAYER_STATS = 15;

export class StatsClientT {
  name = ""; // char[MAX_INFO_STRING]
  teamnum = 0;
}

export class StatsPlayerT {
  dropped = false; // whether this player was dropped
  info: StatsClientT = new StatsClientT();
  stats: Int32Array = new Int32Array(MAX_PLAYER_STATS);
  // `struct _stats_player *pNext` -- singly linked list of dropped players
  // kept by p_stats.c so a rejoining player's stats can be restored.
  next: StatsPlayerT | null = null;
}

// lmctf60/g_local.h's anonymous `client_ctf_t` struct (`//surt LMCTF`
// comment), nested as `client_ctf_t ctf;` on gclient_s. Replaces every
// ctf_team/ctf_state/... field client_respawn_t had in ctf/g_local.h (see
// ClientRespawnT below) plus the referee/admin flag, which is now a bit in
// `extra_flags` read through the `ISREF` macro
// (`#define ISREF(ent) (ent->client->ctf.extra_flags &
// CTF_EXTRAFLAGS_REFEREE)`), ported as the `isRef()` helper near the bottom
// of this file. `PRINT_CHAT` (q_shared.h) is 3, so printdata has 4 slots
// (PRINT_CHAT+1), one per print-priority queue.
export const PRINT_CHAT_PLUS_ONE = 4;

export class CtfClientT {
  teamnum = 0; // CTF_TEAM_RED/BLUE/UNDEFINED/OBSERVER*/etc (see g_ctffunc.ts)
  New_Team = 0; // pending team change, applied at next respawn
  extra_flags = 0; // CTF_EXTRAFLAGS_* bits (camera lock, referee, rcon, radio prefs)
  goodskin = false; // skin already approved -- skip re-forcecommand
  pingalertfloor = 0;
  pingalertceiling = 0;
  compass = 0; // compass HUD setting
  printdata: string[] = new Array(PRINT_CHAT_PLUS_ONE).fill(""); // queued print-priority text
  printready = false; // is there a queue waiting
  ctfid = 0; // unsigned long -- guaranteed-unique per-client id
  original_enterframe = 0;
  popup_ent: EdictT | null = null;
}

// client data that stays across multiple level loads. Named
// `ClientPersistentT` (not `ClientPersistantT`) because lmctf60/g_local.h
// itself renamed the C typedef from `client_persistant_t` to the correctly
// spelled `client_persistent_t`.
export class ClientPersistentT {
  userinfo = ""; // char[MAX_INFO_STRING]
  netname = ""; // char[16]
  // ADC squad-board fields.
  squad = ""; // char[MAX_CATEGORY_LEN]
  squadStatus = ""; // char[MAX_STATUS_LEN]
  hand = 0;

  connected = false; // a loadgame will leave valid entities that
  // just don't have a connection yet

  // values saved and restored from edicts when changing levels
  health = 0;
  max_health = 0;
  // NOTE: ctf/g_local.h's `qboolean powerArmorActive` is REPLACED by a
  // plain `int savedFlags` in lmctf60 (diff confirmed) -- power-armor
  // active state is folded into a saved copy of edict->flags instead of its
  // own boolean.
  savedFlags = 0;

  selected_item = 0;
  inventory: Int32Array = new Int32Array(MAX_ITEMS);

  // ammo capacities
  max_bullets = 0;
  max_shells = 0;
  max_rockets = 0;
  max_grenades = 0;
  max_cells = 0;
  max_slugs = 0;
  // RERELEASE CONTENT PORT -- per-client ammo caps for the mission-pack
  // ammo types. From src/rogue/g_local.ts (tesla/prox/mines/flechettes)
  // and src/xatrix/g_local.ts (magslug/trap). Vanilla's own six caps are
  // above; these six extend them for the ported ammo_* items.
  max_tesla = 0;
  max_prox = 0;
  max_mines = 0;
  max_flechettes = 0;
  max_magslug = 0;
  max_trap = 0;
  // rogue's Add_Ammo caps AMMO_DISRUPTOR against this. The rerelease's
  // InitClientPersistant seeds it to 12 (src/kexgame/p_client.ts's
  // `max_ammo[AMMO_DISRUPTOR] = 12`); p_client.ts sets it there, so unlike
  // a hardcoded constant it can be raised by a Bandolier/Ammo Pack the way
  // every other cap is.
  max_rounds = 0;

  weapon: GItemT | null = null;
  lastweapon: GItemT | null = null;

  power_cubes = 0; // used for tracking the cubes in coop games
  score = 0; // for calculating total unit score in coop games

  game_helpchanged = 0;
  helpchanged = 0;

  spectator = false; // client is a spectator
}

// client data that stays across deathmatch respawns.
//
// NOTE: every ZOID ctf_* field ctf/g_local.h's client_respawn_t carried
// (ctf_team, ctf_state, ctf_lasthurtcarrier, ctf_lastreturnedflag,
// ctf_flagsince, ctf_lastfraggedcarrier, id_state, voted, admin, ghost) is
// REMOVED in lmctf60 (diff confirmed: the whole `//ZOID ... //ZOID` block is
// deleted, not reformatted). Team membership moved to GClientT.ctf.teamnum
// (CtfClientT above); referee/admin moved to the extra_flags bit read by
// ISREF; the assist-timer fields reappear renamed and moved onto GClientT
// directly (defend_flag_time, return_flag_time, kill_carrier_time,
// hit_carrier_time, below) rather than living on resp; ghost-code reconnect
// support does not exist in LM_CTF at all. `voted`/`ready` are not
// redeclared anywhere in lmctf60/g_local.h; they most likely live in
// g_vote.c's or g_tourney.c's own per-client bookkeeping (both out of this
// unit's SCOPE) rather than on gclient_s -- reported as an open question for
// whichever unit ports g_vote.c/g_tourney.c.
export class ClientRespawnT {
  coop_respawn: ClientPersistentT = new ClientPersistentT(); // what to set client->pers to on a respawn
  enterframe = 0; // level.framenum the client entered the game
  score = 0; // frags, etc
  cmd_angles: Vec3 = vec3(); // angles sent over in the last command

  spectator = false; // client is a spectator
}

// this structure is cleared on each PutClientInServer(),
// except for 'client->pers'
export class GClientT {
  // known to server
  ps: PlayerStateT = new PlayerStateT();
  ping = 0;

  // private to game
  pers: ClientPersistentT = new ClientPersistentT();
  resp: ClientRespawnT = new ClientRespawnT();
  old_pmove: PmoveStateT = new PmoveStateT(); // for detecting out-of-pmove changes

  showscores = false; // set layout stat
  // NOTE: ZOID's `inmenu`/`menu: pmenuhnd_t*` pair (right after showscores
  // in ctf/g_local.h) is REMOVED; LM_CTF's own menu state
  // (showmenu/menu/menuselect/localmenu/...) lives further down, matching
  // lmctf60/g_local.h's actual field order.
  showinventory = false; // set layout stat
  showhelp = false;
  showhelpicon = false;
  showsquadboard = false; // ADC

  ammo_index = 0;

  buttons = 0;
  oldbuttons = 0;
  latched_buttons = 0;

  weapon_thunk = false;

  newweapon: GItemT | null = null;

  // sum up damage over an entire frame, so
  // shotgun blasts give a single big kick
  damage_armor = 0; // damage absorbed by armor
  damage_parmor = 0; // damage absorbed by power armor
  damage_blood = 0; // damage taken out of health
  damage_knockback = 0; // impact damage
  damage_from: Vec3 = vec3(); // origin for vector calculation

  killer_yaw = 0; // when dead, look at killer

  weaponstate: WeaponstateT = WeaponstateT.WEAPON_READY;
  kick_angles: Vec3 = vec3(); // weapon kicks
  kick_origin: Vec3 = vec3();
  v_dmg_roll = 0;
  v_dmg_pitch = 0;
  v_dmg_time = 0; // damage kicks
  fall_time = 0;
  fall_value = 0; // for view drop on fall
  damage_alpha = 0;
  bonus_alpha = 0;
  damage_blend: Vec3 = vec3();
  v_angle: Vec3 = vec3(); // aiming direction
  bobtime = 0; // so off-ground doesn't change it
  oldviewangles: Vec3 = vec3();
  oldvelocity: Vec3 = vec3();

  next_drown_time = 0;
  old_waterlevel = 0;
  breather_sound = 0;

  machinegun_shots = 0; // for weapon raising

  // animation vars
  anim_end = 0;
  anim_priority = 0;
  anim_duck = false;
  anim_run = false;

  // powerup timers
  quad_framenum = 0;
  invincible_framenum = 0;
  breather_framenum = 0;
  enviro_framenum = 0;

  grenade_blew_up = false;
  grenade_time = 0;
  silencer_shots = 0;
  weapon_sound = 0;

  pickup_msg_time = 0;

  // NOTE: ctf/g_local.h's flood_locktill/flood_when[10]/flood_whenhead
  // (built-in chat-flood protection) are REMOVED in lmctf60 (diff
  // confirmed). LM_CTF replaces them with its own spam_* fields below
  // (spam_lock_time/spam_freq_time/spam_freq_count/spam_band_count),
  // configured by the CTF_SPAM_BAND_*/CTF_SPAM_FREQ_* constants in
  // g_ctffunc.h (ctf_SpamCheck, not in this unit's SCOPE).

  respawn_time = 0; // can respawn when time > this

  chase_target: EdictT | null = null; // player we are chasing
  update_chase = false; // need to update chase info?

  // lmctf60/g_local.h `// SKWiD MOD`: current plasma-rifle fire mode
  // (plasma.c, not in this unit's SCOPE).
  plasma_mode = 0;

  // TEAM CODE -- LM_JORM: the grapple hook. Entirely separate machine from
  // ThreeWave's ctf_grapple/ctf_grapplestate (see src/ctf/g_local.ts) --
  // see g_ctffunc.ts and p_weapon.ts's hook section for the full divergence
  // record.
  hookstate = 0; // 0 idle, 1 bolt in flight, 2 pulling
  hookend: Vec3 = vec3(); // set but never read anywhere in lmctf60 (dead write, preserved)
  hookangle: Vec3 = vec3(); // set once (hookstate transition 0->1), never read afterward
  hooklength = 0; // last measured player<->hook distance
  hook: EdictT | null = null; // the flying/attached hook bolt entity
  rune: EdictT | null = null; // whatever rune this client is carrying (g_runes.ts)
  isfiring = 0; // "did we fire this frame" flag, read by g_runes.ts's rune think hooks
  showmod = false;
  showctfhud = false;
  awayframe = 0;

  // LM_CTF's own popup-menu system (g_menu.c), replacing ZOID's pmenuhnd_t.
  showmenu = false;
  menu = 0; // MENU_* id (g_menu.ts)
  menuselect = 0;
  localmenu: MenuItemT[] = Array.from({ length: 18 }, () => new MenuItemT());
  currmenu: ((ent: EdictT) => void) | null = null;
  prevmenu: ((ent: EdictT) => void) | null = null;
  menupage = 0;
  menulastpage = 0;
  menumovetime = 0; // when we last moved on the menu

  // NOTE: lmctf60/g_local.h's `camera_target`/`autoobserve` fields are
  // gated `#ifdef OLDOBSERVERCODE`, which -- like MONSTERS_OK -- is never
  // defined by the Makefile; dropped as a dead branch (not carried over).

  spam_lock_time = 0; // last time this client actually triggered spam control
  spam_freq_time = 0; // any spammable action triggers this
  spam_freq_count = 0; // actions-per-window counter
  spam_band_count = 0; // max amount you are allowed to talk/radio/etc

  regentime = 0;

  // Assist-credit timers (renamed/relocated from ZOID's client_respawn_t
  // ctf_lasthurtcarrier/ctf_lastreturnedflag/ctf_lastfraggedcarrier; see the
  // NOTE on ClientRespawnT above).
  defend_flag_time = 0;
  return_flag_time = 0;
  kill_carrier_time = 0;
  hit_carrier_time = 0;

  // Makes the "who's near me" popup finder less taxing on the server.
  last_popup_frame = 0;


  // ===================================================================
  // RERELEASE CONTENT PORT -- client fields the rerelease content set
  // needs. Ported from src/game/g_local.ts's own block (itself from
  // src/rogue/g_local.ts and src/xatrix/g_local.ts). These back the
  // powerups and held items the rerelease maps hand the player: the
  // Double Damage and Quad-Fire timers, IR goggles, the nuke's
  // countdown, the owned sphere, the cloak and the trap.
  //
  // DELIBERATELY NOT PORTED: src/game's ctf_* grapple/tech client fields.
  // LM-CTF has its own hook state (hook_target/hook_lastframe on EdictT,
  // the CtfClientT block above) and deleted ZOID's techs outright, so
  // ctf_regentime/ctf_techsndtime/ctf_lasttechmsg have no reader here.
  //
  // Every field defaults to the same 0/false/null the C aggregate
  // initializer produced, so 1997 content is unaffected.
  // ===================================================================
  double_framenum = 0;
  ir_framenum = 0;
  nuke_framenum = 0;
  tracker_pain_framenum = 0;
  owned_sphere: EdictT | null = null; // this points to the player's sphere
  quadfire_framenum = 0;
  // The rerelease cloak (item_invisibility) timer.
  invisible_framenum = 0;
  trap_blew_up = false;
  trap_time = 0;

  ctf: CtfClientT = new CtfClientT();
  p_stats_player: StatsPlayerT | null = null; // STATS - LM_Hati

  // this structure is cleared on each PutClientInServer(), except for 'pers'
  clear(): void {
    const pers = this.pers;
    Object.assign(this, new GClientT());
    this.pers = pers;
  }
}

// DO NOT MODIFY THE FIELD ORDER ABOVE "game-only fields below this point" --
// the server expects gclient_s/edict_s's server-visible prefix in exactly
// this order (see game.h and the C comment reproduced below).
export class EdictT implements Edict {
  // === shared server<->game prefix (game.h's short edict_t) ===
  s: EntityStateT = new EntityStateT();
  client: GClientT | null = null; // NULL if not a player
  // the server expects the first part of gclient_s to be a player_state_t
  // but the rest of it is opaque
  inuse = false;
  linkcount = 0;

  // FIXME: move these fields to a server private sv_entity_t
  area: LinkT = new LinkT(); // linked to a division node or leaf

  num_clusters = 0; // if -1, use headnode instead
  clusternums: Int32Array = new Int32Array(MAX_ENT_CLUSTERS);
  headnode = 0; // unused if num_clusters != -1
  areanum = 0;
  areanum2 = 0;

  //================================

  svflags = 0;
  mins: Vec3 = vec3();
  maxs: Vec3 = vec3();
  absmin: Vec3 = vec3();
  absmax: Vec3 = vec3();
  size: Vec3 = vec3();
  solid: SolidT = SolidT.SOLID_NOT;
  clipmask = 0;
  owner: EdictT | null = null;

  // DO NOT MODIFY ANYTHING ABOVE THIS, THE SERVER
  // EXPECTS THE FIELDS IN THAT ORDER!

  //================================
  movetype: MovetypeT = MovetypeT.MOVETYPE_NONE;
  flags = 0;

  model: string | null = null;
  freetime = 0; // sv.time when the object was freed

  //
  // only used locally in game, not by server
  //
  message: string | null = null;
  classname: string | null = null;
  spawnflags = 0;

  timestamp = 0;

  angle = 0; // set in qe3, -1 = up, -2 = down
  target: string | null = null;
  targetname: string | null = null;
  killtarget: string | null = null;
  team: string | null = null;
  pathtarget: string | null = null;
  deathtarget: string | null = null;
  combattarget: string | null = null;
  target_ent: EdictT | null = null;

  speed = 0;
  accel = 0;
  decel = 0;
  movedir: Vec3 = vec3();
  pos1: Vec3 = vec3();
  pos2: Vec3 = vec3();

  velocity: Vec3 = vec3();
  avelocity: Vec3 = vec3();
  mass = 0;
  air_finished = 0;
  gravity = 0; // per entity gravity multiplier (1.0 is normal)
  // use for lowgrav artifact, flares

  goalentity: EdictT | null = null;
  movetarget: EdictT | null = null;
  yaw_speed = 0;
  ideal_yaw = 0;

  nextthink = 0;
  prethink: ((ent: EdictT) => void) | null = null;
  think: ((self: EdictT) => void) | null = null;
  blocked: ((self: EdictT, other: EdictT) => void) | null = null; // move to moveinfo?
  touch: ((self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null) => void) | null = null;
  use: ((self: EdictT, other: EdictT | null, activator: EdictT | null) => void) | null = null;
  pain: ((self: EdictT, other: EdictT, kick: number, damage: number) => void) | null = null;
  die:
    | ((self: EdictT, inflictor: EdictT, attacker: EdictT, damage: number, point: Vec3) => void)
    | null = null;

  touch_debounce_time = 0; // are all these legit?  do we need more/less of them?
  pain_debounce_time = 0;
  damage_debounce_time = 0;
  fly_sound_debounce_time = 0; // move to clientinfo
  last_move_time = 0;

  health = 0;
  max_health = 0;
  gib_health = 0;
  deadflag = 0;
  show_hostile = 0;

  powerarmor_time = 0;

  map: string | null = null; // target_changelevel

  viewheight = 0; // height above origin where eyesight is determined
  takedamage = 0;
  dmg = 0;
  radius_dmg = 0;
  dmg_radius = 0;
  sounds = 0; // make this a spawntemp var?
  count = 0;

  chain: EdictT | null = null;
  enemy: EdictT | null = null;
  oldenemy: EdictT | null = null;
  activator: EdictT | null = null;
  groundentity: EdictT | null = null;
  groundentity_linkcount = 0;
  teamchain: EdictT | null = null;
  teammaster: EdictT | null = null;

  mynoise: EdictT | null = null; // can go in client only
  mynoise2: EdictT | null = null;

  noise_index = 0;
  noise_index2 = 0;
  volume = 0;
  attenuation = 0;

  // timing variables
  wait = 0;
  delay = 0; // before firing targets
  random = 0;

  teleport_time = 0;

  watertype = 0;
  waterlevel = 0;

  move_origin: Vec3 = vec3();
  move_angles: Vec3 = vec3();

  // move this to clientinfo?
  light_level = 0;

  style = 0; // also used as areaportal number

  item: GItemT | null = null; // for bonus items

  // common data blocks
  moveinfo: MoveinfoT = new MoveinfoT();
  monsterinfo: MonsterInfoT = new MonsterInfoT();

  // CTF CODE -- LM_JORM (appended fields; lmctf60/g_local.h has these where
  // ctf/g_local.h had `#include "g_ctf.h"` at the very end of edict_s).
  homeposition: Vec3 = vec3(); // flag home spot, used by ctf_resetflagandplayer
  homeangles: Vec3 = vec3();
  runetype = 0; // which rune this is, if this edict is a rune pickup
  flagteam = 0; // which team this edict is, if this edict is a flag
  hook_target: EdictT | null = null; // who/what this hook bolt is attached to
  hook_lastframe = 0; // level.framenum of the last periodic-damage tick while latched
  hook_offset: Vec3 = vec3(); // captured target->absmin offset at first touch
  dontfree = 0;
  droptime = 0;
  entprops = 0; // flags to tag entities with (used by flags, which have no client)

  // ===================================================================
  // RERELEASE CONTENT PORT -- edict fields the rerelease content set
  // needs, ported verbatim from src/rogue/g_local.ts's "// ROGUE" block
  // and src/xatrix/g_local.ts (`orders`). Same reasoning as the
  // MonsterInfoT block above: the rerelease game DLL carries one edict
  // struct covering all of the content, so hosting that content in the
  // classic module means carrying the same fields. Vanilla 3.21 entities
  // never touch them.
  // ===================================================================
  plat2flags = 0;
  offset: Vec3 = vec3();
  // Gravity DIRECTION, defaulting to straight down.
  //
  // rogue's C memsets the edict array to zero and then has G_InitEdict()
  // and ED_CallSpawn() VectorSet this to (0,0,-1) before any spawn
  // function runs, so in the C the all-zero state is never observable.
  // This port initializes it to (0,0,-1) directly instead of to vec3(),
  // because in TypeScript an EdictT can be constructed without going
  // through either of those (a test fixture, or any future direct
  // `new EdictT()`), and an all-zero gravity vector is not a harmless
  // zero -- it is a THIRD state the C never has. M_CheckGround
  // (g_monster.ts) branches on `gravityVector[2] < 0` to pick the normal
  // vs inverted-gravity steepness test, so a zero Z silently takes the
  // INVERTED branch and the entity never finds ground. That is exactly
  // the regression this default fixes: it makes M_CheckGround's own
  // "every edict's gravityVector defaults to (0,0,-1)" comment true by
  // construction rather than only along the G_InitEdict path.
  //
  // G_InitEdict/ED_CallSpawn still assign the same value, so behavior on
  // the normal path is unchanged; target_gravity and the reverse-gravity
  // areas still overwrite it per entity.
  gravityVector: Vec3 = vec3(0, 0, -1);
  bad_area: EdictT | null = null;
  hint_chain: EdictT | null = null;
  monster_hint_chain: EdictT | null = null;
  target_hint_chain: EdictT | null = null;
  hint_chain_id = 0;
  lastMoveTime = 0;
  // xatrix/g_local.h: the ONE field xatrix adds -- misc_transport /
  // monster orders bookkeeping.
  orders = 0;

  // --- rerelease (kex) edict fields, from src/kexgame/g_local_types.ts ---
  // Targets and flags the rerelease entity set reads. All default to the
  // same null/0 a vanilla entity would leave them at, so vanilla content
  // is unaffected.
  healthtarget: string | null = null;
  itemtarget: string | null = null;
  style_on: string | null = null;
  style_off: string | null = null;
  crosslevel_flags = 0;
  hackflags = 0;
  fog: FogT = new FogT();
  heightfog: HeightFogT = new HeightFogT();
  bmodel_anim: BmodelAnimT = new BmodelAnimT();
  // The shambler's sustained lightning bolt entities (src/kexgame/
  // m_shambler.ts). `beam2` exists because the rerelease's shambler_die
  // clears it even though nothing ever assigns it -- preserved rather than
  // "fixed", same as the rest of that monster's quirks.
  beam: EdictT | null = null;
  beam2: EdictT | null = null;

  clear(): void {
    Object.assign(this, new EdictT());
  }
}

//===============================================================
// g_local.h externs: singletons, holders, and cross-module prototypes
//===============================================================

export const game: GameLocalsT = new GameLocalsT();
export const level: LevelLocalsT = new LevelLocalsT();
export const st: SpawnTempT = new SpawnTempT();

export let gi: GameImports;
export let globals: GameExports;
export function SetGameImports(v: GameImports): void {
  gi = v;
}
export function SetGameExports(v: GameExports): void {
  globals = v;
}

export const gameIndices: {
  sm_meat_index: number;
  snd_fry: number;
  jacket_armor_index: number;
  combat_armor_index: number;
  body_armor_index: number;
} = { sm_meat_index: 0, snd_fry: 0, jacket_armor_index: 0, combat_armor_index: 0, body_armor_index: 0 };

export let g_edicts: EdictT[] = [];
export function SetGEdicts(v: EdictT[]): void {
  g_edicts = v;
}

// lmctf60/g_local.h: `extern edict_t *redflag; extern edict_t *blueflag;`
// -- the live flag entities, read by T_Damage (g_combat.ts) to credit
// hit_carrier_time. Assigned by whichever unit ports the flag spawn path
// (g_ctffunc.c's ctf_spawnflag, not in this unit's SCOPE); null until then.
export let redflag: EdictT | null = null;
export let blueflag: EdictT | null = null;
export function SetRedFlag(v: EdictT | null): void {
  redflag = v;
}
export function SetBlueFlag(v: EdictT | null): void {
  blueflag = v;
}

// `#define world (&g_edicts[0])`
export function world(): EdictT {
  const w = g_edicts[0];
  if (w === undefined) {
    throw new Error("world: g_edicts is not initialized (edict 0 does not exist yet)");
  }
  return w;
}

// console variables read by the game module; each is resolved once via
// gi.cvar() during InitGame and never reassigned afterward.
//
// lmctf60/g_local.h drops ctf's `capturelimit`/`instantweap` externs and
// adds a large set of LM_CTF-only cvars (ctfflags, refset, runes, skinset,
// refpassword, rconpassword, motd_file, server_file, maplist_file,
// skin_file, skin_debug, disabled_weps, flag_init, fastswitch,
// mod_website, autolock, countdown_time, want_funky_gravity, plus
// hostname/gamedir which ctf never externs itself). Only the subset needed
// by the hook feature (ctfflags) plus the always-present baseq2 set is
// populated here; the rest are added by whichever unit ports the cvar they
// gate (g_main.ts's InitGame call sites), per PORTING.md's "gameCvars"
// holder-object convention.
export const gameCvars: {
  maxentities: CvarT | null;
  deathmatch: CvarT | null;
  coop: CvarT | null;
  dmflags: CvarT | null;
  skill: CvarT | null;
  fraglimit: CvarT | null;
  timelimit: CvarT | null;
  password: CvarT | null;
  spectator_password: CvarT | null;
  g_select_empty: CvarT | null;
  dedicated: CvarT | null;
  filterban: CvarT | null;
  sv_gravity: CvarT | null;
  sv_maxvelocity: CvarT | null;
  gun_x: CvarT | null;
  gun_y: CvarT | null;
  gun_z: CvarT | null;
  sv_rollspeed: CvarT | null;
  sv_rollangle: CvarT | null;
  run_pitch: CvarT | null;
  run_roll: CvarT | null;
  bob_up: CvarT | null;
  bob_pitch: CvarT | null;
  bob_roll: CvarT | null;
  sv_cheats: CvarT | null;
  maxclients: CvarT | null;
  maxspectators: CvarT | null;
  sv_maplist: CvarT | null;
  // RERELEASE CONTENT PORT: rogue's `gamerules` cvar (rogue/g_local.h),
  // which selects the alternate deathmatch rulesets (RDM_TAG /
  // RDM_DEATHBALL) the ported dm_tag content is the entry point of. 0 (the
  // default) is vanilla deathmatch, so classic play is unchanged.
  gamerules: CvarT | null;
  // RERELEASE CONTENT PORT: the remaining rogue cvars the ported content
  // reads -- huntercam (the hunter sphere's chase camera), strong_mines and
  // randomrespawn (prox/tesla and item-respawn tuning), g_showlogic (the
  // pack's own debug spew). All default to vanilla-equivalent behavior.
  huntercam: CvarT | null;
  strong_mines: CvarT | null;
  randomrespawn: CvarT | null;
  g_showlogic: CvarT | null;
  // lmctf60/g_local.h: `extern cvar_t *ctfflags;` -- this unit's one
  // required addition (gates CTF_OFFHAND_HOOK, CTF_NO_GRAP_DAMAGE, etc).
  ctfflags: CvarT | null;
  // lmctf60/g_local.h: `extern cvar_t *refset;` / `extern cvar_t *skinset;`
  // -- needed by g_ctffunc.ts's ctf_flagtouch (refset gates
  // CTF_RED_FLAG_FROZEN/CTF_BLUE_FLAG_FROZEN; skinset selects the
  // redscoreN.wav/bluescoreN.wav capture-sound variant).
  refset: CvarT | null;
  skinset: CvarT | null;
  // lmctf60/g_local.h: `extern cvar_t *flag_init;` -- flag spawn-frame
  // initialization, read by g_ctffunc.ts's ctf_spawnflag.
  flag_init: CvarT | null;
  // lmctf60/g_local.h: `extern cvar_t *runes;` -- bitmask of which runes
  // SpawnEntities scatters at level load, read by g_spawn.ts's
  // SpawnEntities tail.
  runes: CvarT | null;
  // lmctf60/g_local.h:611-612, 564 -- match-flow cvars read by g_tourney.ts
  // (SetPause/KillMatch/StartMatch/SpawnTourneyClock/Match_Start).
  autolock: CvarT | null; // lock/unlock teams with match status
  countdown_time: CvarT | null; // seconds to count down before match start
  railtime: CvarT | null; // MATCH_RAILGUN_COUNTDOWN round length, seconds
  // lmctf60/g_local.h: `extern cvar_t *fastswitch;` -- read/toggled by
  // g_cmds.ts's Cmd_ToggleFastSwitch_f, shown by g_menu.ts's
  // Ref_Settings_Menu.
  fastswitch: CvarT | null;
} = {
  maxentities: null,
  deathmatch: null,
  coop: null,
  dmflags: null,
  skill: null,
  fraglimit: null,
  timelimit: null,
  password: null,
  spectator_password: null,
  g_select_empty: null,
  dedicated: null,
  filterban: null,
  sv_gravity: null,
  sv_maxvelocity: null,
  gun_x: null,
  gun_y: null,
  gun_z: null,
  sv_rollspeed: null,
  sv_rollangle: null,
  run_pitch: null,
  run_roll: null,
  bob_up: null,
  bob_pitch: null,
  bob_roll: null,
  sv_cheats: null,
  maxclients: null,
  maxspectators: null,
  sv_maplist: null,
  gamerules: null,
  huntercam: null,
  strong_mines: null,
  randomrespawn: null,
  g_showlogic: null,
  ctfflags: null,
  refset: null,
  skinset: null,
  flag_init: null,
  runes: null,
  autolock: null,
  countdown_time: null,
  railtime: null,
  fastswitch: null,
};

//===============================================================
// ctfflags bits (lmctf60/q_shared.h) -- placed here rather than in
// src/shared/q_shared.ts (the normal q_shared.h mapping target) because
// src/shared/q_shared.ts is a single instance shared by every game family
// and these bits are LM_CTF-only. This mirrors src/ctf/g_local.ts's own
// precedent of hosting ctf/g_local.h's WEAP_GRAPPLE (a value that, by the
// PORTING.md mapping table, "belongs" in a header ctf.ts doesn't have its
// own module for either). Deviation reported per PORTING.md's mismatch
// clause.
//===============================================================

export const CTF_WEAP_BALANCE = 1; // gates GRAPPLE_PULL_BALANCED_SPEED (dead: WEAP_BALANCE_OK is never defined)
export const CTF_ALLOW_INVULN = 2;
export const CTF_TEAM_RESET = 4;
export const CTF_TEAM_NOSWITCH = 8;
export const CTF_OFFHAND_HOOK = 16; // the priority feature's gate
export const CTF_NOVOICE = 32; // dead: NOVOICE_OK is never defined
export const CTF_NO_GRAP_DAMAGE = 64;
export const CTF_TEAM_NOTEAMS = 128;
export const CTF_FLAGS_NOFLAGS = 256;
export const CTF_SCORE_BALANCE = 512;
export const CTF_TEAM_ARMOR_PROTECT = 1024;
export const CTF_DM_POWER_ARMOR_STRENGTH = 2048;
export const CTF_RANDOM_MAPS = 4096;
export const CTF_RANDOM_QUAD = 8192;
export const CTF_RANDOM_DEATH_MSG = 16384;
export const CTF_VOTEMENU_OFF = 32768;

// `extra_flags` bits (lmctf60/g_local.h's `#define CTF_EXTRAFLAGS_*`).
export const CTF_EXTRAFLAGS_CAMERA_LOCKED = 1;
export const CTF_EXTRAFLAGS_REFEREE = 2;
export const CTF_EXTRAFLAGS_RCON = 4;
export const CTF_EXTRAFLAGS_CAMERA_REVERSE = 8;
export const CTF_EXTRAFLAGS_RADIO_TEXT = 16;
export const CTF_EXTRAFLAGS_RADIO_SOUND = 32;

// `#define ISREF(ent) (ent->client->ctf.extra_flags & CTF_EXTRAFLAGS_REFEREE)`
export function isRef(ent: EdictT): boolean {
  if (ent.client === null) return false;
  return (ent.client.ctf.extra_flags & CTF_EXTRAFLAGS_REFEREE) !== 0;
}


// =========================================================================
// RERELEASE CONTENT PORT -- the constants the rerelease entity set needs.
//
// Ported from src/game/g_local.ts's own merged block, which took them from
// src/rogue/g_local.ts and src/xatrix/g_local.ts. LM-CTF's DLL predates
// both packs, so its g_local.h has none of them; the rerelease maps this
// module now hosts place the monsters, spawners, spheres and weapons that
// read them.
//
// All of these are INTERNAL to the game module: none is parsed out of a
// .bsp, none rides the network protocol, and savegames are written and
// read by the same build. Values were checked against LM-CTF's own
// identifier space before being taken over -- see the WEAP_* note below,
// the one place where a value had to move.
//
// DELIBERATELY NOT PORTED: ctf/g_local.h's IT_TECH and ZOID's tech items.
// LM-CTF deletes IT_TECH outright (see the note at the IT_* block above);
// its equivalent subsystem is the five runes in g_runes.ts. Also skipped:
// MOD_GRAPPLE (LM-CTF's hook uses MOD_CTF_GRAPPLE 60) and the isQuadHolder
// /GhostT pair (LM-CTF has neither extern).
// =========================================================================

// ------------------- from src/rogue/g_local.ts -------------------
// ROGUE
export const AI_WALK_WALLS = 0x00008000;
export const AI_MANUAL_STEERING = 0x00010000;
export const AI_TARGET_ANGER = 0x00020000;
export const AI_DODGING = 0x00040000;
export const AI_CHARGING = 0x00080000;
export const AI_HINT_PATH = 0x00100000;
export const AI_IGNORE_SHOTS = 0x00200000;
// PMM - FIXME - last second added for E3 .. there's probably a better way to do this, but
// this works
export const AI_DO_NOT_COUNT = 0x00400000; // set for healed monsters
export const AI_SPAWNED_CARRIER = 0x00800000; // both do_not_count and spawned are set for spawned monsters
export const AI_SPAWNED_MEDIC_C = 0x01000000; // both do_not_count and spawned are set for spawned monsters
export const AI_SPAWNED_WIDOW = 0x02000000; // both do_not_count and spawned are set for spawned monsters
export const AI_SPAWNED_MASK = 0x03800000; // mask to catch all three flavors of spawned
export const AI_BLOCKED = 0x04000000; // used by blocked_checkattack: set to say I'm attacking while blocked
export const AS_BLIND = 5; // PMM - used by boss code to do nasty things even if it can't see you
// ROGUE
export const DAMAGE_DESTROY_ARMOR = 0x00000040; // damage is done to armor and health.
export const DAMAGE_NO_POWER_ARMOR = 0x00000100; // damage skips power armor
export const DAMAGE_NO_REG_ARMOR = 0x00000080; // damage skips regular armor
// ROGUE
// this determines how long to wait after a duck to duck again.  this needs
// to be longer than the time after the monster_duck_up in all of the
// animation sequences
export const DUCK_INTERVAL = 0.5;
// ROGUE
export const FL_MECHANICAL = 0x00002000; // entity is mechanical, use sparks not blood
export const FL_SAM_RAIMI = 0x00004000; // entity is in sam raimi cam mode
export const FL_DISGUISED = 0x00008000; // entity is in disguise, monsters will not recognize.
export const FL_NOGIB = 0x00010000; // player has been vaporized by a nuke, drop no gibs
// ROGUE
export const IT_MELEE = 0x00000040;
export const IT_NOT_GIVEABLE = 0x00000080; // item can not be given
// ROGUE
export const MOD_CHAINFIST = 40;
export const MOD_DISINTEGRATOR = 41;
export const MOD_ETF_RIFLE = 42;
export const MOD_BLASTER2 = 43;
export const MOD_HEATBEAM = 44;
export const MOD_TESLA = 45;
export const MOD_PROX = 46;
export const MOD_NUKE = 47;
export const MOD_VENGEANCE_SPHERE = 48;
export const MOD_HUNTER_SPHERE = 49;
export const MOD_DEFENDER_SPHERE = 50;
export const MOD_TRACKER = 51;
export const MOD_DBALL_CRUSH = 52;
export const MOD_DOPPLE_EXPLODE = 53;
export const MOD_DOPPLE_VENGEANCE = 54;
export const MOD_DOPPLE_HUNTER = 55;
export const RDM_DEATHBALL = 3;
//
// deathmatch games
//
export const RDM_TAG = 2;
export const ROGUE_GRAVITY = 1;
export const SPHERE_DEFENDER = 0x0001;
export const SPHERE_DOPPLEGANGER = 0x0100;
export const SPHERE_FLAGS = 0xff00;
export const SPHERE_HUNTER = 0x0002;
export const SPHERE_TYPE = 0x00ff;
export const SPHERE_VENGEANCE = 0x0004;

// ------------------- from src/xatrix/g_local.ts -------------------
// xatrix/g_local.h: `// RAFAEL 14-APR-98` block
export const MOD_RIPPER = 34;
export const MOD_PHALANX = 35;
export const MOD_BRAINTENTACLE = 36;
export const MOD_BLASTOFF = 37;
export const MOD_GEKK = 38;
export const MOD_TRAP = 39;

// ------------------- weapon-model (vwep) slots for the new weapons -------
// gitem_t->weapmodel picks the weapon model another client draws in this
// player's hands (it rides in s.skinnum's high byte). LM-CTF's own header
// already spends slots 1..13 -- xatrix's `WEAP_PHALANX 12`/`WEAP_BOOMER 13`
// and rogue's `WEAP_DISRUPTOR..WEAP_CHAINFIST 12..16` both collide with
// LM-CTF's `WEAP_PLASMA 12` / `WEAP_HOOK 13` -- so the seven slots the
// rerelease weapons need are appended after LM-CTF's last one instead,
// keeping src/game's relative order. Renumbering here cannot disturb any
// 1997 content: no map, savegame or protocol message carries a weapmodel
// index, and no weapon LM-CTF already ships changes slot.
export const WEAP_PHALANX = 14;
export const WEAP_BOOMER = 15;
export const WEAP_DISRUPTOR = 16;
export const WEAP_ETFRIFLE = 17;
// NAMED WEAP_PLASMABEAM, not src/game's WEAP_PLASMA: LM-CTF's g_local.h
// already binds the name WEAP_PLASMA to slot 12 for its own SKWiD plasma
// gun. This is rogue's plasma BEAM (weapon_plasmabeam/weapon_heatbeam), a
// different weapon that happens to have shared the name upstream.
export const WEAP_PLASMABEAM = 18;
export const WEAP_PROXLAUNCH = 19;
export const WEAP_CHAINFIST = 20;

// `dm_game_rt` (`struct dm_game_rs`): a table of function pointers selected
// by the `gamerules` cvar (RDM_TAG/RDM_DEATHBALL) at PostInitSetup and
// dispatched from g_main.c's per-frame/per-event hooks. `DogTag`'s C
// signature is `void (*)(edict_t *ent, edict_t *killer, char **pic)` -- an
// out-param string; per PORTING.md's "C helpers that mutate a char* in
// place... return the new string instead" idiom, it returns the pic path
// as a plain string here instead of writing through a pointer. `killer` is
// `EdictT | null`: p_hud.c's DeathmatchScoreboardMessage calls
// `DMGame.DogTag(cl_ent, killer, &tag)` unconditionally, including when
// `killer` is NULL (e.g. the local scoreboard entry for a player who died
// to the world), and leaves any NULL-handling to the dm_tag.c/dm_ball.c
// implementation (outside this unit's SCOPE) -- widened after a real
// call-site mismatch surfaced against p_hud.ts's port of that call.
export class DmGameRt {
  GameInit: (() => void) | null = null;
  PostInitSetup: (() => void) | null = null;
  ClientBegin: ((ent: EdictT) => void) | null = null;
  SelectSpawnPoint: ((ent: EdictT, origin: Vec3, angles: Vec3) => void) | null = null;
  PlayerDeath: ((targ: EdictT, inflictor: EdictT, attacker: EdictT) => void) | null = null;
  Score: ((attacker: EdictT, victim: EdictT, scoreChange: number) => void) | null = null;
  PlayerEffects: ((ent: EdictT) => void) | null = null;
  DogTag: ((ent: EdictT, killer: EdictT | null) => string) | null = null;
  PlayerDisconnect: ((ent: EdictT) => void) | null = null;
  ChangeDamage: ((targ: EdictT, attacker: EdictT, damage: number, mod: number) => number) | null = null;
  ChangeKnockback:
    | ((targ: EdictT, attacker: EdictT, knockback: number, mod: number) => number)
    | null = null;
  CheckDMRules: (() => number) | null = null;
}
// `extern dm_game_rt DMGame;` -- reassigned field-by-field (not a swapped
// pointer) by whichever of g_newdm.c/dm_tag.c/dm_ball.c's *_GameInit runs,
// so it stays a single mutable singleton instance, same treatment as
// `game`/`level`/`st` above.
export const DMGame: DmGameRt = new DmGameRt();
