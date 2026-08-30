// g_local.h -- local definitions for game module
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
import { type Edict, type GameExports, type GameImports, LinkT, MAX_ENT_CLUSTERS, SolidT } from "./game";

// the "gameversion" client command will print this plus compile date
export const GAMEVERSION = "baseq2";

// protocol bytes that can be directly added to messages
export const svc_muzzleflash = 1;
export const svc_muzzleflash2 = 2;
export const svc_temp_entity = 3;
export const svc_layout = 4;
export const svc_inventory = 5;
export const svc_stufftext = 11;

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

// Memory tags (TAG_GAME / TAG_LEVEL) are DROPPED per PORTING.md: "Z_Malloc/
// Z_Free/Hunk_*/Z_TagMalloc -> plain allocation; tag-freeing loops become
// explicit list clears." There is no tag-scoped allocator on this side of
// the port, so nothing carries tag semantics; when g_save.c is ported,
// "clear on level load" becomes an explicit reset of the owning collection.

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

// monster ai flags
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

  // `void *info` is never used by baseq2; kept as `unknown` (never `any`)
  // rather than dropped, since g_local.h declares it.
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

  // items
  num_items = 0;

  autosaved = false;

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

  clear(): void {
    Object.assign(this, new LevelLocalsT());
  }
}

// spawn_temp_t is only used to hold entity field values that
// can be set from the editor, but aren't actualy present
// in edict_t during gameplay
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

  // Escape hatch for the rare table where the original C source itself
  // declares a frame array longer than lastframe-firstframe+1 (id Software
  // bug, not a porting error). Must be set to true before assigning `frame`
  // and requires a comment at the call site citing the C evidence -- see
  // m_actor.ts's actor_move_walk for the one known instance.
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

  // Every construction site in the codebase (the per-monster-file mkmove()/
  // mmove() helpers, and the inline `const x = new MmoveT(); x.firstframe =
  // ...; x.lastframe = ...; x.frame = ...; x.endfunc = ...;` pattern used by
  // a few monster files) assigns frame after firstframe/lastframe are
  // already final, so validating here catches a bad table at module load
  // (boot) instead of the first time that monster's frame table runs.
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
  dodge: ((self: EdictT, other: EdictT, eta: number) => void) | null = null;
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
export const MOD_FRIENDLY_FIRE = 0x8000000;

// `extern int meansOfDeath;` -- a reassigned scalar global, not an object
// field; per PORTING.md ("C globals that are reassigned pointers... become
// fields on their owning singleton or a small exported holder object") it
// gets a one-field holder rather than a bare exported `let`.
export const meansOfDeathHolder: { meansOfDeath: number } = { meansOfDeath: MOD_UNKNOWN };

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
  F_FUNCTION,
  F_MMOVE,
  F_IGNORE,
}

// `field_t.ofs` is `(int)&(((edict_t*)0)->x)` in C -- a byte offset used by
// g_save.c to read/write fields by raw memory layout. There is no TS
// equivalent (no struct memory layout to take the address of), so `ofs` is
// dropped; the future g_save.ts port must address fields by property name
// (`keyof EdictT`-style) instead of an offset. The FOFS/STOFS/LLOFS/CLOFS
// macros that computed these offsets are dropped for the same reason. The
// `fields[]` table itself is g_save.c's data and is not ported here.
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

// client data that stays across multiple level loads
export class ClientPersistantT {
  userinfo = ""; // char[MAX_INFO_STRING]
  netname = ""; // char[16]
  hand = 0;

  connected = false; // a loadgame will leave valid entities that
  // just don't have a connection yet

  // values saved and restored from edicts when changing levels
  health = 0;
  max_health = 0;
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

  weapon: GItemT | null = null;
  lastweapon: GItemT | null = null;

  power_cubes = 0; // used for tracking the cubes in coop games
  score = 0; // for calculating total unit score in coop games

  game_helpchanged = 0;
  helpchanged = 0;

  spectator = false; // client is a spectator
}

// client data that stays across deathmatch respawns
export class ClientRespawnT {
  coop_respawn: ClientPersistantT = new ClientPersistantT(); // what to set client->pers to on a respawn
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
  pers: ClientPersistantT = new ClientPersistantT();
  resp: ClientRespawnT = new ClientRespawnT();
  old_pmove: PmoveStateT = new PmoveStateT(); // for detecting out-of-pmove changes

  showscores = false; // set layout stat
  showinventory = false; // set layout stat
  showhelp = false;
  showhelpicon = false;

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

  flood_locktill = 0; // locked from talking
  flood_when: Float32Array = new Float32Array(10); // when messages were said
  flood_whenhead = 0; // head pointer for when said

  respawn_time = 0; // can respawn when time > this

  chase_target: EdictT | null = null; // player we are chasing
  update_chase = false; // need to update chase info?

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
  // C declares `qboolean show_hostile` but g_ai.c stores a truncated
  // level.time timestamp in it (int-backed enum absorbs the float); typed
  // as the number it really is.
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

  clear(): void {
    Object.assign(this, new EdictT());
  }
}

//===============================================================
// g_local.h externs: singletons, holders, and cross-module prototypes
//===============================================================

// `game`/`level`/`st` are shared mutable globals that are never reassigned
// (per PORTING.md); the C code memsets them, which becomes `clear()`.
export const game: GameLocalsT = new GameLocalsT();
export const level: LevelLocalsT = new LevelLocalsT();
export const st: SpawnTempT = new SpawnTempT();

// `gi`/`globals` are C globals assigned exactly once, at DLL load
// (GetGameApi), and read as bare globals at thousands of call sites.
// Declared without initializer: undefined-until-GetGameAPI matches the C
// global's uninitialized-until-load lifetime, and call sites keep the C
// shape `gi.dprintf(...)`. Assign only through the setters (imported
// bindings are read-only).
export let gi: GameImports;
export let globals: GameExports;
export function SetGameImports(v: GameImports): void {
  gi = v;
}
export function SetGameExports(v: GameExports): void {
  globals = v;
}

// `extern int sm_meat_index; extern int snd_fry; extern int
// jacket_armor_index; extern int combat_armor_index; extern int
// body_armor_index;` -- precached model/sound/item indices resolved once
// during InitItems/PrecacheItem and read thereafter.
export const gameIndices: {
  sm_meat_index: number;
  snd_fry: number;
  jacket_armor_index: number;
  combat_armor_index: number;
  body_armor_index: number;
} = { sm_meat_index: 0, snd_fry: 0, jacket_armor_index: 0, combat_armor_index: 0, body_armor_index: 0 };

// `extern edict_t *g_edicts;` -- reshaped the same way GameExports.edicts
// is in game.ts: a plain array instead of a pointer, sized once max_edicts
// is known at Init time.
export let g_edicts: EdictT[] = [];
export function SetGEdicts(v: EdictT[]): void {
  g_edicts = v;
}

// `#define world (&g_edicts[0])`
export function world(): EdictT {
  const w = g_edicts[0];
  if (w === undefined) {
    throw new Error("world: g_edicts is not initialized (edict 0 does not exist yet)");
  }
  return w;
}

// `random()`/`crandom()` are declared in g_local.h but PORTING.md names
// this exact pair as the case where the C source file and the TS mapping
// file differ: they belong in src/shared/math.ts, not here. Per this
// worker's SCOPE (src/game/ only), they are not re-declared in this
// module; callers import them from "../shared/math" once that unit
// provides them.

// console variables read by the game module; each is resolved once via
// gi.cvar() during InitGame and never reassigned afterward, hence a single
// holder object rather than 29 separate exported `let`s.
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
  needpass: CvarT | null;
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
  flood_msgs: CvarT | null;
  flood_persecond: CvarT | null;
  flood_waitdelay: CvarT | null;
  sv_maplist: CvarT | null;
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
  needpass: null,
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
  flood_msgs: null,
  flood_persecond: null,
  flood_waitdelay: null,
  sv_maplist: null,
};

