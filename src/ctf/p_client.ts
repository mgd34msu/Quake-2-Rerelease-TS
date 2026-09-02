// p_client.c
//
// g_local.h attributes these prototypes to files it calls "g_client.c" and
// "g_player.c"; neither file exists in the C source tree. Grepping the
// actual tree shows every one of these functions is defined in p_client.c,
// so that is where they are ported from.

import { vec3, vec3_origin, type Vec3, VectorClear, VectorCopy, VectorLength, VectorSubtract } from "../shared/math";
import {
  ANGLE2SHORT,
  type CvarT,
  CVAR_SERVERINFO,
  type EntityStateT,
  EntityEventT,
  Info_SetValueForKey,
  Info_ValueForKey,
  Info_Validate,
  MASK_DEADSOLID,
  MASK_PLAYERSOLID,
  MAX_INFO_STRING,
  MAX_ITEMS,
  MulticastT,
  MZ_LOGIN,
  MZ_LOGOUT,
  PITCH,
  PlayerStateT,
  PmTypeT,
  PmoveStateT,
  PmoveT,
  PMF_DUCKED,
  PMF_NO_PREDICTION,
  PMF_TIME_TELEPORT,
  PRINT_HIGH,
  PRINT_MEDIUM,
  Q_stricmp,
  ROLL,
  SHORT2ANGLE,
  BUTTON_ANY,
  BUTTON_ATTACK,
  CHAN_BODY,
  CHAN_VOICE,
  ATTN_NORM,
  CS_GENERAL,
  CS_PLAYERSKINS,
  DF_FIXED_FOV,
  DF_FORCE_RESPAWN,
  DF_QUAD_DROP,
  DF_SPAWN_FARTHEST,
  type UsercmdT,
  YAW,
} from "../shared/q_shared";
import { type Edict, type GTraceT, SolidT, SVF_DEADMONSTER, SVF_NOCLIENT } from "./game";
import { SV_FilterPacket } from "./g_svcmds";
import {
  ANIM_DEATH,
  BODY_QUEUE_SIZE,
  ClientPersistantT,
  ClientRespawnT,
  DEAD_DEAD,
  DEAD_NO,
  DamageT,
  DROPPED_PLAYER_ITEM,
  type EdictT,
  FL_GODMODE,
  FL_NOTARGET,
  FL_NO_KNOCKBACK,
  FL_NOGIB,
  FL_POWER_ARMOR,
  FRAMETIME,
  type GClientT,
  type GItemT,
  GIB_ORGANIC,
  IT_KEY,
  MOD_BARREL,
  MOD_BFG_BLAST,
  MOD_BFG_EFFECT,
  MOD_BFG_LASER,
  MOD_BLASTER,
  MOD_BOMB,
  MOD_CHAINGUN,
  MOD_CRUSH,
  MOD_EXIT,
  MOD_EXPLOSIVE,
  MOD_FALLING,
  MOD_CHAINFIST,
  MOD_DEFENDER_SPHERE,
  MOD_DISINTEGRATOR,
  MOD_DOPPLE_EXPLODE,
  MOD_DOPPLE_HUNTER,
  MOD_DOPPLE_VENGEANCE,
  MOD_ETF_RIFLE,
  MOD_FRIENDLY_FIRE,
  MOD_HEATBEAM,
  MOD_HUNTER_SPHERE,
  MOD_NUKE,
  MOD_PHALANX,
  MOD_PROX,
  MOD_RIPPER,
  MOD_TESLA,
  MOD_TRACKER,
  MOD_TRAP,
  MOD_VENGEANCE_SPHERE,
  MOD_G_SPLASH,
  MOD_GRENADE,
  MOD_HANDGRENADE,
  MOD_HELD_GRENADE,
  MOD_HG_SPLASH,
  MOD_GRAPPLE,
  MOD_HYPERBLASTER,
  MOD_LAVA,
  MOD_MACHINEGUN,
  MOD_R_SPLASH,
  MOD_RAILGUN,
  MOD_ROCKET,
  MOD_SHOTGUN,
  MOD_SLIME,
  MOD_SPLASH,
  MOD_SSHOTGUN,
  MOD_SUICIDE,
  MOD_TARGET_BLASTER,
  MOD_TARGET_LASER,
  MOD_TELEFRAG,
  MOD_TRIGGER_HURT,
  MOD_WATER,
  MovetypeT,
  PNOISE_SELF,
  game,
  g_edicts,
  gameCvars,
  gi,
  level,
  meansOfDeathHolder,
  svc_muzzleflash,
  world,
} from "./g_local";
import { G_Find, G_FreeEdict, G_InitEdict, G_Spawn, G_TouchTriggers, KillBox } from "./g_utils";
import { SP_misc_teleporter_dest, ThrowClientHead, ThrowGib } from "./g_misc";
import { Drop_Item, FindItem, FindItemByClassname, ITEM_INDEX, itemlist, Touch_Item } from "./g_items";
import { visible } from "./g_ai";
import { UpdateChaseCam } from "./g_chase";
import { PlayerTrail_Add, PlayerTrail_LastSpot } from "./p_trail";
import { ChangeWeapon, PlayerNoise, Think_Weapon } from "./p_weapon";
import { ClientEndServerFrame } from "./p_view";
import { MoveClientToIntermission } from "./p_hud";
import {
  CtfTeamT,
  CTFApplyRegeneration,
  CTFAssignSkin,
  CTFAssignTeam,
  CTFDeadDropFlag,
  CTFDeadDropTech,
  CTFFragBonuses,
  CTFGrapplePull,
  CTFMatchOn,
  CTFPlayerResetGrapple,
  CTFStartClient,
  SelectCTFSpawnPoint,
} from "./g_ctf";
import { PMenu_Do_Update } from "./p_menu";
import {
  FRAME_crdeath1,
  FRAME_crdeath5,
  FRAME_death101,
  FRAME_death106,
  FRAME_death201,
  FRAME_death206,
  FRAME_death301,
  FRAME_death308,
} from "./m_player_frames";

// `ctf/g_ctf.h` declares `extern cvar_t *ctf;`, pulled into every ctf-track
// file via g_local.h's trailing `#include "g_ctf.h"`, so every file shares
// one cvar pointer. g_ctf.ts (out of this unit's SCOPE) keeps that cvar as a
// module-private `let ctf`, not re-exported, so this file resolves its own
// handle to the same underlying "ctf" cvar via gi.cvar() with the identical
// name/default/flags g_ctf.ts's CTFInit uses -- the engine's cvar registry
// (Cvar_Get semantics) hands back the same CvarT object regardless of which
// file asks for it by name, so this reads the live, shared value. Reported
// as a follow-up: move `ctf` into gameCvars in g_local.ts alongside
// capturelimit/instantweap so every ctf-track file reads one place instead
// of each re-resolving it.
let ctfCvar: CvarT | null = null;
function ctfEnabled(): boolean {
  if (ctfCvar === null) ctfCvar = gi.cvar("ctf", "1", CVAR_SERVERINFO);
  return ctfCvar !== null && ctfCvar.value !== 0;
}

// gameCvars entries are `CvarT | null` until InitGame resolves them via
// gi.cvar() (see g_local.ts's gameCvars comment); this pair of helpers is
// duplicated per-file per the established convention (see g_main.ts,
// g_spawn.ts, g_items.ts, etc.) rather than shared, since g_local.ts's
// holder type gives no non-null guarantee to dereference directly.
function cvarNum(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}
function cvarStr(c: CvarT | null): string {
  return c === null ? "" : c.string;
}

// atoi(): C's atoi returns 0 for a string with no valid leading integer.
// Duplicated per-file per the established convention (see g_cmds.ts,
// g_spawn.ts).
function atoiC(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

// `gitem_t *` lookups that C treats as always-succeeding (FindItem("Blaster")
// etc always resolves against the baseq2 item table); matches p_weapon.ts's
// own local requireItem rather than importing it, per the per-file helper
// convention already established across this game track.
function requireItem(item: GItemT | null): GItemT {
  if (item !== null) return item;
  gi.error("p_client: expected item lookup to succeed");
}

// C assigns `client_persistant_t` by value in several places (struct copy);
// TS objects are references, so an explicit field-by-field clone is needed
// wherever the C source relies on the copy being independently mutable
// afterward (see InitClientResp and PutClientInServer's coop branch).
function cloneClientPersistant(src: ClientPersistantT): ClientPersistantT {
  const c = new ClientPersistantT();
  c.userinfo = src.userinfo;
  c.netname = src.netname;
  c.hand = src.hand;
  c.connected = src.connected;
  c.health = src.health;
  c.max_health = src.max_health;
  c.savedFlags = src.savedFlags;
  c.selected_item = src.selected_item;
  c.inventory = new Int32Array(src.inventory);
  c.max_bullets = src.max_bullets;
  c.max_shells = src.max_shells;
  c.max_rockets = src.max_rockets;
  c.max_grenades = src.max_grenades;
  c.max_cells = src.max_cells;
  c.max_slugs = src.max_slugs;
  // RERELEASE CONTENT PORT -- the mission-pack ammo caps (see g_local.ts's
  // ClientPersistantT). Copied alongside the vanilla six so they survive a
  // level change the same way.
  c.max_tesla = src.max_tesla;
  c.max_prox = src.max_prox;
  c.max_mines = src.max_mines;
  c.max_flechettes = src.max_flechettes;
  c.max_magslug = src.max_magslug;
  c.max_trap = src.max_trap;
  c.max_rounds = src.max_rounds;
  c.weapon = src.weapon;
  c.lastweapon = src.lastweapon;
  c.power_cubes = src.power_cubes;
  c.score = src.score;
  c.game_helpchanged = src.game_helpchanged;
  c.helpchanged = src.helpchanged;
  c.spectator = src.spectator;
  return c;
}

// `pmove_state_t` is also assigned by value in C (`pm.s = client->ps.pmove;`,
// `client->ps.pmove = pm.s; client->old_pmove = pm.s;`); cloning avoids two
// of those three ending up aliased to the same object, which would corrupt
// the `memcmp` staleness check ClientThink relies on for `pm.snapinitial`.
function clonePmoveState(s: PmoveStateT): PmoveStateT {
  const c = new PmoveStateT();
  c.pm_type = s.pm_type;
  c.origin.set(s.origin);
  c.velocity.set(s.velocity);
  c.pm_flags = s.pm_flags;
  c.pm_time = s.pm_time;
  c.gravity = s.gravity;
  c.delta_angles.set(s.delta_angles);
  return c;
}

function pmoveStateEqual(a: PmoveStateT, b: PmoveStateT): boolean {
  if (a.pm_type !== b.pm_type) return false;
  if (a.pm_flags !== b.pm_flags) return false;
  if (a.pm_time !== b.pm_time) return false;
  if (a.gravity !== b.gravity) return false;
  for (let i = 0; i < 3; i++) {
    if (a.origin[i] !== b.origin[i]) return false;
    if (a.velocity[i] !== b.velocity[i]) return false;
    if (a.delta_angles[i] !== b.delta_angles[i]) return false;
  }
  return true;
}

// `body->s = ent->s;` is a full entity_state_t struct copy in C; TS needs
// the same field-by-field treatment as the clone helpers above.
function copyEntityState(src: EntityStateT, dst: EntityStateT): void {
  dst.number = src.number;
  VectorCopy(src.origin, dst.origin);
  VectorCopy(src.angles, dst.angles);
  VectorCopy(src.old_origin, dst.old_origin);
  dst.modelindex = src.modelindex;
  dst.modelindex2 = src.modelindex2;
  dst.modelindex3 = src.modelindex3;
  dst.modelindex4 = src.modelindex4;
  dst.frame = src.frame;
  dst.skinnum = src.skinnum;
  dst.effects = src.effects;
  dst.renderfx = src.renderfx;
  dst.solid = src.solid;
  dst.sound = src.sound;
  dst.event = src.event;
  dst.alpha = src.alpha;
  dst.scale = src.scale;
  dst.instance_bits = src.instance_bits;
  dst.loop_volume = src.loop_volume;
  dst.loop_attenuation = src.loop_attenuation;
  dst.owner = src.owner;
  dst.old_frame = src.old_frame;
  dst.morefx = src.morefx;
}

// Recovers a game-private EdictT from an `unknown` PmoveT.touchents/
// groundentity slot (see q_shared.ts's PmoveT comment: these are typed
// `unknown` at the qcommon layer, which forward-declares `struct edict_s`).
// Mirrors files.ts's `hasStringCode`-style type-predicate idiom rather than
// a cast, per PORTING.md's "no `as` casts" rule.
function hasProp<K extends string>(u: object, key: K): u is Record<K, unknown> {
  return key in u;
}
function recoverEdict(u: unknown): EdictT | null {
  if (typeof u !== "object" || u === null) return null;
  if (!hasProp(u, "s")) return null;
  const s = u.s;
  if (typeof s !== "object" || s === null) return null;
  if (!hasProp(s, "number")) return null;
  const num = s.number;
  if (typeof num !== "number") return null;
  const edict = g_edicts[num];
  return edict === undefined ? null : edict;
}

// Recovers the full EdictT for the `Edict` every GameExports entry point
// below receives. Unlike recoverEdict (for pmove/trace results, which cross
// through qcommon's `unknown`-typed slots and only carry a number), the
// `Edict` sv_main.ts/sv_user.ts pass into ClientConnect/ClientBegin/
// ClientUserinfoChanged/ClientDisconnect/ClientThink is never a copy -- it is
// always the very same EdictT instance already sitting in `g_edicts`
// (sv_main.ts's SVC_DirectConnect and sv_user.ts's SV_New_f both read it
// straight out of `ge.edicts`, which is `g_edicts` itself via g_local.ts's
// globals/exportsObj identity trick). The EDICT_NUM idiom used elsewhere
// (`g_edicts[ent.s.number]`) is unsound specifically at these entry points:
// g_spawn.ts's SpawnEntities `.clear()`s every edict on each map load (the
// `memset(g_edicts, 0, ...)` equivalent), including the reserved player
// slots, and a player slot's `s.number` is not restored until sv_user.ts's
// SV_New_f runs -- which happens after ClientConnect, not before. On a fresh
// boot, ClientConnect for a never-yet-`new`'d slot therefore saw
// `entIn.s.number === 0` and the numeric lookup silently recovered the world
// edict instead of the real one, corrupting world.client and crashing
// ClientUserinfoChanged's `client.pers` dereference. Recovering by reference
// identity instead sidesteps that staleness window entirely and needs no
// cast (EdictT structurally satisfies Edict, so `===` narrows cleanly). This
// mirrors base game's src/game/p_client.ts fix (commit 77082d8); the ctf
// fork predates that fix and inherited the same bug.
function edictFromBoundary(entIn: Edict): EdictT {
  const found = g_edicts.find((e) => e === entIn);
  if (found !== undefined) return found;
  gi.error("ctf/p_client: boundary edict not found in g_edicts");
}

// `NUM_FOR_EDICT(e)` (g_local.h: `((e)-g_edicts)`) -- every place in
// p_client.c that needs "which slot is this edict" computes it via pointer
// arithmetic against g_edicts, never by reading `ent->s.number` (this ctf
// fork's p_client.c confirms the same: every one of
// gi.WriteShort(ent-g_edicts), `index = ent-g_edicts-1`, `playernum =
// ent-g_edicts-1`, and `ent->s.skinnum = ent-g_edicts-1` is pointer
// arithmetic). `ent.s.number` is only kept in sync with an edict's real
// g_edicts position by linkentity/G_Spawn-style bookkeeping, which has not
// run yet for a just-connected, not-yet-`new`'d client slot (see
// edictFromBoundary's comment) -- so any TS call site that substituted
// `ent.s.number` for this idiom inherited the same staleness bug. g_utils.ts
// already establishes `g_edicts.indexOf(e)` as this port's NUM_FOR_EDICT
// equivalent; this file now uses it everywhere p_client.c uses pointer
// arithmetic instead of `ent.s.number`.
function EDICT_NUM(e: EdictT): number {
  return g_edicts.indexOf(e);
}

import { Cmd_Help_f } from "./p_hud";

//
// Gross, ugly, disgustuing hack section
//

// this function is an ugly as hell hack to fix some map flaws
//
// the coop spawn spots on some maps are SNAFU.  There are coop spots
// with the wrong targetname as well as spots with no name at all
//
// we use carnal knowledge of the maps to fix the coop spot targetnames to match
// that of the nearest named single player spot
function SP_FixCoopSpots(self: EdictT): void {
  const d = vec3();
  let spot: EdictT | null = null;

  for (;;) {
    spot = G_Find(spot, "classname", "info_player_start");
    if (spot === null) return;
    if (spot.targetname === null) continue;
    VectorSubtract(self.s.origin, spot.s.origin, d);
    if (VectorLength(d) < 384) {
      if (self.targetname === null || Q_stricmp(self.targetname, spot.targetname) !== 0) {
        self.targetname = spot.targetname;
      }
      return;
    }
  }
}

// now if that one wasn't ugly enough for you then try this one on for size
// some maps don't have any coop spots at all, so we need to create them
// where they should have been
function SP_CreateCoopSpots(_self: EdictT): void {
  if (Q_stricmp(level.mapname, "security") !== 0) return;

  let spot = G_Spawn();
  spot.classname = "info_player_coop";
  spot.s.origin[0] = 188 - 64;
  spot.s.origin[1] = -164;
  spot.s.origin[2] = 80;
  spot.targetname = "jail3";
  spot.s.angles[1] = 90;

  spot = G_Spawn();
  spot.classname = "info_player_coop";
  spot.s.origin[0] = 188 + 64;
  spot.s.origin[1] = -164;
  spot.s.origin[2] = 80;
  spot.targetname = "jail3";
  spot.s.angles[1] = 90;

  spot = G_Spawn();
  spot.classname = "info_player_coop";
  spot.s.origin[0] = 188 + 128;
  spot.s.origin[1] = -164;
  spot.s.origin[2] = 80;
  spot.targetname = "jail3";
  spot.s.angles[1] = 90;
}

/*QUAKED info_player_start (1 0 0) (-16 -16 -24) (16 16 32)
The normal starting point for a level.
*/
export function SP_info_player_start(self: EdictT): void {
  if (cvarNum(gameCvars.coop) === 0) return;
  if (Q_stricmp(level.mapname, "security") === 0) {
    // invoke one of our gross, ugly, disgusting hacks
    self.think = SP_CreateCoopSpots;
    self.nextthink = level.time + FRAMETIME;
  }
}

/*QUAKED info_player_deathmatch (1 0 1) (-16 -16 -24) (16 16 32)
potential spawning position for deathmatch games
*/
export function SP_info_player_deathmatch(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) === 0) {
    G_FreeEdict(self);
    return;
  }
  SP_misc_teleporter_dest(self);
}

/*QUAKED info_player_coop (1 0 1) (-16 -16 -24) (16 16 32)
potential spawning position for coop games
*/
const COOP_SPOT_FIX_MAPS = [
  "jail2",
  "jail4",
  "mine1",
  "mine2",
  "mine3",
  "mine4",
  "lab",
  "boss1",
  "fact3",
  "biggun",
  "space",
  "command",
  "power2",
  "strike",
];

export function SP_info_player_coop(self: EdictT): void {
  if (cvarNum(gameCvars.coop) === 0) {
    G_FreeEdict(self);
    return;
  }

  if (COOP_SPOT_FIX_MAPS.some((m) => Q_stricmp(level.mapname, m) === 0)) {
    // invoke one of our gross, ugly, disgusting hacks
    self.think = SP_FixCoopSpots;
    self.nextthink = level.time + FRAMETIME;
  }
}

/*QUAKED info_player_intermission (1 0 1) (-16 -16 -24) (16 16 32)
The deathmatch intermission point will be at one of these
Use 'angles' instead of 'angle', so you can set pitch or roll as well as yaw.  'pitch yaw roll'
*/
// C's real signature is `void SP_info_player_intermission(void)` (no edict
// parameter); the spawn registry (g_spawn.ts) expects the same
// `(EdictT) => void` shape as every other spawn function, which is the
// signature the original pending stub already used, so it is kept here too.
export function SP_info_player_intermission(_self: EdictT): void {}

//=======================================================================

export function player_pain(_self: EdictT, _other: EdictT, _kick: number, _damage: number): void {
  // player pain is handled at the end of the frame in P_DamageFeedback
}

function IsFemale(ent: EdictT): boolean {
  if (ent.client === null) return false;
  const info = Info_ValueForKey(ent.client.pers.userinfo, "skin");
  return info[0] === "f" || info[0] === "F";
}

export function ClientObituary(self: EdictT, inflictor: EdictT, attacker: EdictT): void {
  if (cvarNum(gameCvars.coop) !== 0 && attacker.client !== null) {
    meansOfDeathHolder.meansOfDeath |= MOD_FRIENDLY_FIRE;
  }

  if (self.client === null) return; // defensive; C assumes self->client is set (self is always a player here)

  if (cvarNum(gameCvars.deathmatch) !== 0 || cvarNum(gameCvars.coop) !== 0) {
    const ff = (meansOfDeathHolder.meansOfDeath & MOD_FRIENDLY_FIRE) !== 0;
    const mod = meansOfDeathHolder.meansOfDeath & ~MOD_FRIENDLY_FIRE;
    let message: string | null = null;
    let message2 = "";

    switch (mod) {
      case MOD_SUICIDE:
        message = "suicides";
        break;
      case MOD_FALLING:
        message = "cratered";
        break;
      case MOD_CRUSH:
        message = "was squished";
        break;
      case MOD_WATER:
        message = "sank like a rock";
        break;
      case MOD_SLIME:
        message = "melted";
        break;
      case MOD_LAVA:
        message = "does a back flip into the lava";
        break;
      case MOD_EXPLOSIVE:
      case MOD_BARREL:
        message = "blew up";
        break;
      case MOD_EXIT:
        message = "found a way out";
        break;
      case MOD_TARGET_LASER:
        message = "saw the light";
        break;
      case MOD_TARGET_BLASTER:
        message = "got blasted";
        break;
      case MOD_BOMB:
      case MOD_SPLASH:
      case MOD_TRIGGER_HURT:
        message = "was in the wrong place";
        break;
    }

    if (attacker === self) {
      switch (mod) {
        case MOD_HELD_GRENADE:
          message = "tried to put the pin back in";
          break;
        case MOD_HG_SPLASH:
        case MOD_G_SPLASH:
          if (IsFemale(self)) message = "tripped on her own grenade";
          else message = "tripped on his own grenade";
          break;
        case MOD_R_SPLASH:
          if (IsFemale(self)) message = "blew herself up";
          else message = "blew himself up";
          break;
        case MOD_BFG_BLAST:
          message = "should have used a smaller gun";
          break;
        // RERELEASE CONTENT PORT -- ROGUE (rogue/p_client.c). The
        // "it's own trap" spelling is verbatim from the C.
        case MOD_DOPPLE_EXPLODE:
          if (IsFemale(self)) message = "got caught in her own trap";
          else message = "got caught in his own trap";
          break;
        // ROGUE
        default:
          if (IsFemale(self)) message = "killed herself";
          else message = "killed himself";
          break;
      }
    }

    if (message !== null) {
      gi.bprintf(PRINT_MEDIUM, `${self.client.pers.netname} ${message}.\n`);
      if (cvarNum(gameCvars.deathmatch) !== 0) self.client.resp.score--;
      self.enemy = null;
      return;
    }

    self.enemy = attacker;
    if (attacker.client !== null) {
      switch (mod) {
        case MOD_BLASTER:
          message = "was blasted by";
          break;
        case MOD_SHOTGUN:
          message = "was gunned down by";
          break;
        case MOD_SSHOTGUN:
          message = "was blown away by";
          message2 = "'s super shotgun";
          break;
        case MOD_MACHINEGUN:
          message = "was machinegunned by";
          break;
        case MOD_CHAINGUN:
          message = "was cut in half by";
          message2 = "'s chaingun";
          break;
        case MOD_GRENADE:
          message = "was popped by";
          message2 = "'s grenade";
          break;
        case MOD_G_SPLASH:
          message = "was shredded by";
          message2 = "'s shrapnel";
          break;
        case MOD_ROCKET:
          message = "ate";
          message2 = "'s rocket";
          break;
        case MOD_R_SPLASH:
          message = "almost dodged";
          message2 = "'s rocket";
          break;
        case MOD_HYPERBLASTER:
          message = "was melted by";
          message2 = "'s hyperblaster";
          break;
        case MOD_RAILGUN:
          message = "was railed by";
          break;
        case MOD_BFG_LASER:
          message = "saw the pretty lights from";
          message2 = "'s BFG";
          break;
        case MOD_BFG_BLAST:
          message = "was disintegrated by";
          message2 = "'s BFG blast";
          break;
        case MOD_BFG_EFFECT:
          message = "couldn't hide from";
          message2 = "'s BFG";
          break;
        case MOD_HANDGRENADE:
          message = "caught";
          message2 = "'s handgrenade";
          break;
        case MOD_HG_SPLASH:
          message = "didn't see";
          message2 = "'s handgrenade";
          break;
        case MOD_HELD_GRENADE:
          message = "feels";
          message2 = "'s pain";
          break;
        case MOD_TELEFRAG:
          message = "tried to invade";
          message2 = "'s personal space";
          break;
        // =================================================================
        // RERELEASE CONTENT PORT -- the mission packs' obituaries, verbatim
        // from src/rogue/p_client.ts and src/xatrix/p_client.ts (typos and
        // all -- "lost his grip" has no gender chain in the C, and the two
        // xatrix lines read as sentence fragments there too).
        // =================================================================

        // ROGUE
        case MOD_CHAINFIST:
          message = "was shredded by";
          message2 = "'s ripsaw";
          break;
        case MOD_DISINTEGRATOR:
          message = "lost his grip courtesy of";
          message2 = "'s disintegrator";
          break;
        case MOD_ETF_RIFLE:
          message = "was perforated by";
          break;
        case MOD_HEATBEAM:
          message = "was scorched by";
          message2 = "'s plasma beam";
          break;
        case MOD_TESLA:
          message = "was enlightened by";
          message2 = "'s tesla mine";
          break;
        case MOD_PROX:
          message = "got too close to";
          message2 = "'s proximity mine";
          break;
        case MOD_NUKE:
          message = "was nuked by";
          message2 = "'s antimatter bomb";
          break;
        case MOD_VENGEANCE_SPHERE:
          message = "was purged by";
          message2 = "'s vengeance sphere";
          break;
        case MOD_DEFENDER_SPHERE:
          message = "had a blast with";
          message2 = "'s defender sphere";
          break;
        case MOD_HUNTER_SPHERE:
          message = "was killed like a dog by";
          message2 = "'s hunter sphere";
          break;
        case MOD_TRACKER:
          message = "was annihilated by";
          message2 = "'s disruptor";
          break;
        case MOD_DOPPLE_EXPLODE:
          message = "was blown up by";
          message2 = "'s doppleganger";
          break;
        case MOD_DOPPLE_VENGEANCE:
          message = "was purged by";
          message2 = "'s doppleganger";
          break;
        case MOD_DOPPLE_HUNTER:
          message = "was hunted down by";
          message2 = "'s doppleganger";
          break;
        // ROGUE

        // RAFAEL (xatrix)
        case MOD_RIPPER:
          message = "ripped to shreds by";
          message2 = "'s ripper gun";
          break;
        case MOD_PHALANX:
          message = "was evaporated by";
          break;
        case MOD_TRAP:
          message = "caught in trap by";
          break;
        // RAFAEL

        // ZOID (ctf)
        case MOD_GRAPPLE:
          message = "was caught by";
          message2 = "'s grapple";
          break;
        // ZOID
      }
      if (message !== null) {
        gi.bprintf(
          PRINT_MEDIUM,
          `${self.client.pers.netname} ${message} ${attacker.client.pers.netname}${message2}\n`,
        );
        if (cvarNum(gameCvars.deathmatch) !== 0) {
          if (ff) attacker.client.resp.score--;
          else attacker.client.resp.score++;
        }
        return;
      }
    }
  }

  gi.bprintf(PRINT_MEDIUM, `${self.client.pers.netname} died.\n`);
  if (cvarNum(gameCvars.deathmatch) !== 0) self.client.resp.score--;
}

export function TossClientWeapon(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) === 0) return;
  if (self.client === null) return;

  let item = self.client.pers.weapon;
  if (self.client.pers.inventory[self.client.ammo_index] === 0) item = null;
  if (item !== null && item.pickup_name === "Blaster") item = null;

  let quad: boolean;
  if (((cvarNum(gameCvars.dmflags) | 0) & DF_QUAD_DROP) === 0) {
    quad = false;
  } else {
    quad = self.client.quad_framenum > level.framenum + 10;
  }

  const spread = item !== null && quad ? 22.5 : 0.0;

  if (item !== null) {
    self.client.v_angle[YAW] -= spread;
    const drop = Drop_Item(self, item);
    self.client.v_angle[YAW] += spread;
    drop.spawnflags = DROPPED_PLAYER_ITEM;
  }

  if (quad) {
    self.client.v_angle[YAW] += spread;
    const drop = Drop_Item(self, requireItem(FindItemByClassname("item_quad")));
    self.client.v_angle[YAW] -= spread;
    drop.spawnflags |= DROPPED_PLAYER_ITEM;

    drop.touch = Touch_Item;
    drop.nextthink = level.time + (self.client.quad_framenum - level.framenum) * FRAMETIME;
    drop.think = G_FreeEdict;
  }
}

/*
==================
LookAtKiller
==================
*/
export function LookAtKiller(self: EdictT, inflictor: EdictT, attacker: EdictT): void {
  if (self.client === null) return;
  const dir = vec3();

  if (attacker !== world() && attacker !== self) {
    VectorSubtract(attacker.s.origin, self.s.origin, dir);
  } else if (inflictor !== world() && inflictor !== self) {
    VectorSubtract(inflictor.s.origin, self.s.origin, dir);
  } else {
    self.client.killer_yaw = self.s.angles[YAW];
    return;
  }

  if (dir[0] !== 0) {
    self.client.killer_yaw = (180 / Math.PI) * Math.atan2(dir[1], dir[0]);
  } else {
    self.client.killer_yaw = 0;
    if (dir[1] > 0) self.client.killer_yaw = 90;
    else if (dir[1] < 0) self.client.killer_yaw = -90;
  }
  if (self.client.killer_yaw < 0) self.client.killer_yaw += 360;
}

// RERELEASE CONTENT PORT (rogue/p_client.c) -- the disruptor/tracker spawns
// "pain daemon" edicts that keep damaging a victim over time
// (g_newweap.ts's tracker_pain_daemon_*); they have to be swept when the
// victim dies or disconnects, or they keep firing at a dead or freed edict.
// g_local.h declares it as living in p_client.c.
export function RemoveAttackingPainDaemons(self: EdictT): void {
  let tracker: EdictT | null = G_Find(null, "classname", "pain daemon");
  while (tracker !== null) {
    if (tracker.enemy === self) G_FreeEdict(tracker);
    tracker = G_Find(tracker, "classname", "pain daemon");
  }

  if (self.client !== null) self.client.tracker_pain_framenum = 0;
}

// C: `static int i;` local to player_die, incremented (and read) across
// calls to round-robin the three normal-death animations.
let playerDieAnimIndex = 0;

/*
==================
player_die
==================
*/
export function player_die(self: EdictT, inflictor: EdictT, attacker: EdictT, damage: number, _point: Vec3): void {
  VectorClear(self.avelocity);

  self.takedamage = DamageT.DAMAGE_YES;
  self.movetype = MovetypeT.MOVETYPE_TOSS;

  self.s.modelindex2 = 0; // remove linked weapon model
  self.s.modelindex3 = 0; // remove linked ctf flag

  self.s.angles[0] = 0;
  self.s.angles[2] = 0;

  self.s.sound = 0;
  if (self.client !== null) self.client.weapon_sound = 0;

  self.maxs[2] = -8;

  // self.solid = SolidT.SOLID_NOT; -- commented out in the original C
  self.svflags |= SVF_DEADMONSTER;

  if (self.deadflag === DEAD_NO) {
    if (self.client !== null) {
      self.client.respawn_time = level.time + 1.0;
      LookAtKiller(self, inflictor, attacker);
      self.client.ps.pmove.pm_type = PmTypeT.PM_DEAD;
    }
    ClientObituary(self, inflictor, attacker);

    // if at start and same team, clear
    if (
      self.client !== null &&
      ctfEnabled() &&
      meansOfDeathHolder.meansOfDeath === MOD_TELEFRAG &&
      self.client.resp.ctf_state < 2 &&
      attacker.client !== null &&
      self.client.resp.ctf_team === attacker.client.resp.ctf_team
    ) {
      attacker.client.resp.score--;
      self.client.resp.ctf_state = 0;
    }

    CTFFragBonuses(self, inflictor, attacker);
    TossClientWeapon(self);
    CTFPlayerResetGrapple(self);
    CTFDeadDropFlag(self);
    CTFDeadDropTech(self);
    if (cvarNum(gameCvars.deathmatch) !== 0 && self.client !== null && !self.client.showscores) {
      Cmd_Help_f(self); // show scores
    }
  }

  // remove powerups
  if (self.client !== null) {
    self.client.quad_framenum = 0;
    self.client.invincible_framenum = 0;
    self.client.breather_framenum = 0;
    self.client.enviro_framenum = 0;
    self.flags &= ~FL_POWER_ARMOR;

    // clear inventory
    self.client.pers.inventory.fill(0);
  }

  // RERELEASE CONTENT PORT (rogue/p_client.c's player_die) -- the ported
  // Double Damage powerup expires on death like quad, and a carried sphere
  // is told its owner died: vengeance and hunter die if they are not
  // attacking, defender always dies.
  if (self.client !== null) {
    self.client.double_framenum = 0;

    // if there's a sphere around, let it know the player died.
    // vengeance and hunter will die if they're not attacking,
    // defender should always die
    if (self.client.owned_sphere !== null) {
      const sphere = self.client.owned_sphere;
      if (sphere.die !== null) sphere.die(sphere, self, self, 0, vec3_origin);
    }
  }

  // if we've been killed by the tracker, GIB!
  if ((meansOfDeathHolder.meansOfDeath & ~MOD_FRIENDLY_FIRE) === MOD_TRACKER) {
    self.health = -100;
    damage = 400;
  }

  // make sure no trackers are still hurting us.
  if (self.client !== null && self.client.tracker_pain_framenum !== 0) {
    RemoveAttackingPainDaemons(self);
  }

  // if we got obliterated by the nuke, don't gib
  if (self.health < -80 && meansOfDeathHolder.meansOfDeath === MOD_NUKE) self.flags |= FL_NOGIB;
  // ROGUE

  if (self.health < -40) {
    // PMM -- don't toss gibs if we got vaped by the nuke
    if ((self.flags & FL_NOGIB) === 0) {
      // gib
      gi.sound(self, CHAN_BODY, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
      for (let n = 0; n < 4; n++) {
        ThrowGib(self, "models/objects/gibs/sm_meat/tris.md2", damage, GIB_ORGANIC);
      }
    }
    self.flags &= ~FL_NOGIB;

    ThrowClientHead(self, damage);
    if (self.client !== null) {
      self.client.anim_priority = ANIM_DEATH;
      self.client.anim_end = 0;
    }

    self.takedamage = DamageT.DAMAGE_NO;
  } else {
    // normal death
    if (self.deadflag === DEAD_NO) {
      // C: `rand()%4` -- see g_misc.ts's ThrowClientHead comment on the
      // raw-rand() idiom (Math.floor(Math.random() * N)).
      playerDieAnimIndex = (playerDieAnimIndex + 1) % 3;
      if (self.client !== null) {
        // start a death animation
        self.client.anim_priority = ANIM_DEATH;
        if ((self.client.ps.pmove.pm_flags & PMF_DUCKED) !== 0) {
          self.s.frame = FRAME_crdeath1 - 1;
          self.client.anim_end = FRAME_crdeath5;
        } else {
          switch (playerDieAnimIndex) {
            case 0:
              self.s.frame = FRAME_death101 - 1;
              self.client.anim_end = FRAME_death106;
              break;
            case 1:
              self.s.frame = FRAME_death201 - 1;
              self.client.anim_end = FRAME_death206;
              break;
            case 2:
              self.s.frame = FRAME_death301 - 1;
              self.client.anim_end = FRAME_death308;
              break;
          }
        }
      }
      gi.sound(
        self,
        CHAN_VOICE,
        gi.soundindex(`*death${Math.floor(Math.random() * 4) + 1}.wav`),
        1,
        ATTN_NORM,
        0,
      );
    }
  }

  self.deadflag = DEAD_DEAD;

  gi.linkentity(self);
}

//=======================================================================

/*
==============
InitClientPersistant

This is only called when the game first initializes in single player,
but is called after each death and level change in deathmatch
==============
*/
export function InitClientPersistant(client: GClientT): void {
  client.pers = new ClientPersistantT();

  const item = requireItem(FindItem("Blaster"));
  client.pers.selected_item = ITEM_INDEX(item);
  client.pers.inventory[client.pers.selected_item] = 1;

  client.pers.weapon = item;
  client.pers.lastweapon = item;

  const grapple = requireItem(FindItem("Grapple"));
  client.pers.inventory[ITEM_INDEX(grapple)] = 1;

  client.pers.health = 100;
  client.pers.max_health = 100;

  client.pers.max_bullets = 200;
  client.pers.max_shells = 100;
  client.pers.max_rockets = 50;
  client.pers.max_grenades = 50;
  client.pers.max_cells = 200;
  client.pers.max_slugs = 50;

  // RERELEASE CONTENT PORT -- rogue/p_client.c's InitClientPersistant seeds
  // prox/tesla/flechettes; xatrix/p_client.c's seeds magslug/trap. Both are
  // taken verbatim from their own sources. Without these, Add_Ammo's
  // `inventory[index] === max` test is 0 === 0 on the very first pickup and
  // every ported ammo_* item silently refuses to be picked up.
  // ROGUE
  client.pers.max_prox = 50;
  client.pers.max_tesla = 50;
  client.pers.max_flechettes = 200;
  // ROGUE
  // RAFAEL
  client.pers.max_magslug = 50;
  client.pers.max_trap = 5;
  // RAFAEL
  // The disruptor's cap. rogue's shipped build has no AMMO_DISRUPTOR at
  // all; 12 is the value the re-release's own InitClientPersistant uses
  // (`max_ammo[AMMO_DISRUPTOR] = 12`). Seeded here rather than hardcoded at
  // the Add_Ammo call site so a Bandolier/Ammo Pack can raise it like every
  // other cap.
  client.pers.max_rounds = 12;
  // NOTE: `max_mines` is in ClientPersistantT but neither rogue nor xatrix
  // seeds it or reads it -- rogue's mines (prox/tesla) use max_prox and
  // max_tesla. Left at its ClientPersistantT default of 0 on purpose.

  client.pers.connected = true;
}

export function InitClientResp(client: GClientT): void {
  const ctf_team = client.resp.ctf_team;
  const id_state = client.resp.id_state;

  client.resp = new ClientRespawnT();

  client.resp.ctf_team = ctf_team;
  client.resp.id_state = id_state;

  client.resp.enterframe = level.framenum;
  client.resp.coop_respawn = cloneClientPersistant(client.pers);

  if (ctfEnabled() && client.resp.ctf_team < CtfTeamT.CTF_TEAM1) {
    CTFAssignTeam(client);
  }
}

/*
==================
SaveClientData

Some information that should be persistant, like health,
is still stored in the edict structure, so it needs to
be mirrored out to the client structure before all the
edicts are wiped.
==================
*/
// g_spawn.ts's SpawnEntities calls a local mirror of this exact function
// (see that file's own comment on why it couldn't just import a pending
// export); that copy should be deleted in favor of importing this one once
// the coordinator lands this module.
export function SaveClientData(): void {
  const maxclients = cvarNum(gameCvars.maxclients);
  for (let i = 0; i < maxclients; i++) {
    const ent = g_edicts[1 + i];
    if (ent === undefined || !ent.inuse) continue;
    const client = game.clients[i];
    if (client === undefined) continue;
    client.pers.health = ent.health;
    client.pers.max_health = ent.max_health;
    client.pers.savedFlags = ent.flags & (FL_GODMODE | FL_NOTARGET | FL_POWER_ARMOR);
    if (cvarNum(gameCvars.coop) !== 0 && ent.client !== null) {
      client.pers.score = ent.client.resp.score;
    }
  }
}

export function FetchClientEntData(ent: EdictT): void {
  if (ent.client === null) return; // defensive; C assumes ent->client is set
  ent.health = ent.client.pers.health;
  ent.max_health = ent.client.pers.max_health;
  ent.flags |= ent.client.pers.savedFlags;
  if (cvarNum(gameCvars.coop) !== 0) {
    ent.client.resp.score = ent.client.pers.score;
  }
}

/*
=======================================================================

  SelectSpawnPoint

=======================================================================
*/

/*
================
PlayersRangeFromSpot

Returns the distance to the nearest player from the given spot
================
*/
export function PlayersRangeFromSpot(spot: EdictT): number {
  let bestplayerdistance = 9999999;
  const maxclients = cvarNum(gameCvars.maxclients);
  const v = vec3();

  for (let n = 1; n <= maxclients; n++) {
    const player = g_edicts[n];
    if (player === undefined || !player.inuse) continue;
    if (player.health <= 0) continue;

    VectorSubtract(spot.s.origin, player.s.origin, v);
    const playerdistance = VectorLength(v);

    if (playerdistance < bestplayerdistance) bestplayerdistance = playerdistance;
  }

  return bestplayerdistance;
}

/*
================
SelectRandomDeathmatchSpawnPoint

go to a random point, but NOT the two points closest
to other players
================
*/
export function SelectRandomDeathmatchSpawnPoint(): EdictT | null {
  let spot: EdictT | null = null;
  let spot1: EdictT | null = null;
  let spot2: EdictT | null = null;
  let range1 = 99999;
  let range2 = 99999;
  let count = 0;

  while ((spot = G_Find(spot, "classname", "info_player_deathmatch")) !== null) {
    count++;
    const range = PlayersRangeFromSpot(spot);
    if (range < range1) {
      range1 = range;
      spot1 = spot;
    } else if (range < range2) {
      range2 = range;
      spot2 = spot;
    }
  }

  if (count === 0) return null;

  if (count <= 2) {
    spot1 = null;
    spot2 = null;
  } else {
    count -= 2;
  }

  // C: `rand() % count` -- see g_misc.ts's ThrowClientHead comment on the
  // raw-rand() idiom.
  let selection = Math.floor(Math.random() * count);

  spot = null;
  do {
    spot = G_Find(spot, "classname", "info_player_deathmatch");
    if (spot === spot1 || spot === spot2) selection++;
  } while (selection-- !== 0);

  return spot;
}

/*
================
SelectFarthestDeathmatchSpawnPoint

================
*/
export function SelectFarthestDeathmatchSpawnPoint(): EdictT | null {
  let bestspot: EdictT | null = null;
  let bestdistance = 0;
  let spot: EdictT | null = null;

  while ((spot = G_Find(spot, "classname", "info_player_deathmatch")) !== null) {
    const bestplayerdistance = PlayersRangeFromSpot(spot);

    if (bestplayerdistance > bestdistance) {
      bestspot = spot;
      bestdistance = bestplayerdistance;
    }
  }

  if (bestspot !== null) return bestspot;

  // if there is a player just spawned on each and every start spot
  // we have no choice to turn one into a telefrag meltdown
  return G_Find(null, "classname", "info_player_deathmatch");
}

export function SelectDeathmatchSpawnPoint(): EdictT | null {
  if (((cvarNum(gameCvars.dmflags) | 0) & DF_SPAWN_FARTHEST) !== 0) {
    return SelectFarthestDeathmatchSpawnPoint();
  }
  return SelectRandomDeathmatchSpawnPoint();
}

export function SelectCoopSpawnPoint(ent: EdictT): EdictT | null {
  if (ent.client === null) return null;
  let index = game.clients.indexOf(ent.client);

  // player 0 starts in normal player spawn point
  if (index === 0) return null;

  let spot: EdictT | null = null;

  // assume there are four coop spots at each spawnpoint
  for (;;) {
    spot = G_Find(spot, "classname", "info_player_coop");
    if (spot === null) return null; // we didn't have enough...

    const target = spot.targetname ?? "";
    if (Q_stricmp(game.spawnpoint, target) === 0) {
      // this is a coop spawn point for one of the clients here
      index--;
      if (index === 0) return spot; // this is it
    }
  }
}

/*
===========
SelectSpawnPoint

Chooses a player start, deathmatch start, coop start, etc
============
*/
export function SelectSpawnPoint(ent: EdictT, origin: Vec3, angles: Vec3): void {
  let spot: EdictT | null = null;

  if (cvarNum(gameCvars.deathmatch) !== 0) {
    if (ctfEnabled()) spot = SelectCTFSpawnPoint(ent);
    else spot = SelectDeathmatchSpawnPoint();
  } else if (cvarNum(gameCvars.coop) !== 0) {
    spot = SelectCoopSpawnPoint(ent);
  }

  // find a single player start spot
  if (spot === null) {
    while ((spot = G_Find(spot, "classname", "info_player_start")) !== null) {
      if (game.spawnpoint.length === 0 && spot.targetname === null) break;
      if (game.spawnpoint.length === 0 || spot.targetname === null) continue;
      if (Q_stricmp(game.spawnpoint, spot.targetname) === 0) break;
    }

    if (spot === null) {
      if (game.spawnpoint.length === 0) {
        // there wasn't a spawnpoint without a target, so use any
        spot = G_Find(null, "classname", "info_player_start");
      }
    }
  }

  if (spot === null) {
    gi.error(`Couldn't find spawn point ${game.spawnpoint}\n`);
  }

  VectorCopy(spot.s.origin, origin);
  origin[2] += 9;
  VectorCopy(spot.s.angles, angles);
}

//======================================================================

export function InitBodyQue(): void {
  level.body_que = 0;
  for (let i = 0; i < BODY_QUEUE_SIZE; i++) {
    const ent = G_Spawn();
    ent.classname = "bodyque";
  }
}

export function body_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3): void {
  if (self.health < -40) {
    gi.sound(self, CHAN_BODY, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
    for (let n = 0; n < 4; n++) {
      ThrowGib(self, "models/objects/gibs/sm_meat/tris.md2", damage, GIB_ORGANIC);
    }
    self.s.origin[2] -= 48;
    ThrowClientHead(self, damage);
    self.takedamage = DamageT.DAMAGE_NO;
  }
}

export function CopyToBodyQue(ent: EdictT): void {
  // grab a body que and cycle to the next one
  const bodyIndex = (cvarNum(gameCvars.maxclients) | 0) + level.body_que + 1;
  const body = g_edicts[bodyIndex];
  level.body_que = (level.body_que + 1) % BODY_QUEUE_SIZE;

  // FIXME: send an effect on the removed body

  gi.unlinkentity(ent);

  gi.unlinkentity(body);
  copyEntityState(ent.s, body.s);
  body.s.number = bodyIndex;

  body.svflags = ent.svflags;
  VectorCopy(ent.mins, body.mins);
  VectorCopy(ent.maxs, body.maxs);
  VectorCopy(ent.absmin, body.absmin);
  VectorCopy(ent.absmax, body.absmax);
  VectorCopy(ent.size, body.size);
  body.solid = ent.solid;
  body.clipmask = ent.clipmask;
  body.owner = ent.owner;
  body.movetype = ent.movetype;

  body.die = body_die;
  body.takedamage = DamageT.DAMAGE_YES;

  gi.linkentity(body);
}

export function respawn(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0 || cvarNum(gameCvars.coop) !== 0) {
    if (self.movetype !== MovetypeT.MOVETYPE_NOCLIP) {
      CopyToBodyQue(self);
    }
    self.svflags &= ~SVF_NOCLIENT;
    PutClientInServer(self);

    // add a teleportation effect
    self.s.event = EntityEventT.EV_PLAYER_TELEPORT;

    if (self.client !== null) {
      // hold in place briefly
      self.client.ps.pmove.pm_flags = PMF_TIME_TELEPORT;
      self.client.ps.pmove.pm_time = 14;

      self.client.respawn_time = level.time;
    }

    return;
  }

  // restart the entire server
  gi.AddCommandString("menu_loadgame\n");
}

//==============================================================

/*
===========
PutClientInServer

Called when a player connects to a server or respawns in
a deathmatch.
============
*/
export function PutClientInServer(ent: EdictT): void {
  const mins: Vec3 = vec3(-16, -16, -24);
  const maxs: Vec3 = vec3(16, 16, 32);

  const spawn_origin = vec3();
  const spawn_angles = vec3();

  // find a spawn point
  // do it before setting health back up, so farthest
  // ranging doesn't count this client
  SelectSpawnPoint(ent, spawn_origin, spawn_angles);

  const index = EDICT_NUM(ent) - 1;
  if (ent.client === null) return; // defensive; C assumes ent->client is already set
  const client = ent.client;

  let resp: ClientRespawnT;

  // deathmatch wipes most client data every spawn
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    resp = client.resp;
    const userinfo = client.pers.userinfo;
    InitClientPersistant(client);
    ClientUserinfoChanged(ent, userinfo);
  } else if (cvarNum(gameCvars.coop) !== 0) {
    resp = client.resp;
    const userinfo = client.pers.userinfo;
    // this is kind of ugly, but it's how we want to handle keys in coop
    const items = itemlist();
    for (let n = 0; n < MAX_ITEMS; n++) {
      const it = items[n];
      if (it !== undefined && (it.flags & IT_KEY) !== 0) {
        resp.coop_respawn.inventory[n] = client.pers.inventory[n];
      }
    }
    client.pers = cloneClientPersistant(resp.coop_respawn);
    ClientUserinfoChanged(ent, userinfo);
    if (resp.score > client.pers.score) client.pers.score = resp.score;
  } else {
    resp = new ClientRespawnT();
  }

  // clear everything but the persistant data (GClientT.clear() already
  // preserves `pers` across the reset, matching C's saved/restore dance
  // around memset(client, 0, sizeof(*client)))
  client.clear();
  if (client.pers.health <= 0) InitClientPersistant(client);
  client.resp = resp;

  // copy some data from the client to the entity
  FetchClientEntData(ent);

  // clear entity values
  ent.groundentity = null;
  ent.client = game.clients[index];
  ent.takedamage = DamageT.DAMAGE_AIM;
  ent.movetype = MovetypeT.MOVETYPE_WALK;
  ent.viewheight = 22;
  ent.inuse = true;
  ent.classname = "player";
  ent.mass = 200;
  ent.solid = SolidT.SOLID_BBOX;
  ent.deadflag = DEAD_NO;
  ent.air_finished = level.time + 12;
  ent.clipmask = MASK_PLAYERSOLID;
  ent.model = "players/male/tris.md2";
  ent.pain = player_pain;
  ent.die = player_die;
  ent.waterlevel = 0;
  ent.watertype = 0;
  ent.flags &= ~FL_NO_KNOCKBACK;
  ent.svflags &= ~SVF_DEADMONSTER;

  VectorCopy(mins, ent.mins);
  VectorCopy(maxs, ent.maxs);
  VectorClear(ent.velocity);

  // clear playerstate values
  client.ps = new PlayerStateT();

  client.ps.pmove.origin[0] = spawn_origin[0] * 8;
  client.ps.pmove.origin[1] = spawn_origin[1] * 8;
  client.ps.pmove.origin[2] = spawn_origin[2] * 8;
  client.ps.pmove.pm_flags &= ~PMF_NO_PREDICTION;

  if (cvarNum(gameCvars.deathmatch) !== 0 && ((cvarNum(gameCvars.dmflags) | 0) & DF_FIXED_FOV) !== 0) {
    client.ps.fov = 90;
  } else {
    client.ps.fov = atoiC(Info_ValueForKey(client.pers.userinfo, "fov"));
    if (client.ps.fov < 1) client.ps.fov = 90;
    else if (client.ps.fov > 160) client.ps.fov = 160;
  }

  const weapon = client.pers.weapon;
  if (weapon !== null) {
    client.ps.gunindex = gi.modelindex(weapon.view_model ?? "");
  }

  // clear entity state values
  ent.s.effects = 0;
  ent.s.skinnum = index;
  ent.s.modelindex = 255; // will use the skin specified model
  ent.s.modelindex2 = 255; // custom gun model
  // sknum is player num and weapon number
  // weapon number will be added in changeweapon
  ent.s.skinnum = index;

  ent.s.frame = 0;
  VectorCopy(spawn_origin, ent.s.origin);
  ent.s.origin[2] += 1; // make sure off ground
  VectorCopy(ent.s.origin, ent.s.old_origin);

  // set the delta angle
  for (let i = 0; i < 3; i++) {
    client.ps.pmove.delta_angles[i] = ANGLE2SHORT(spawn_angles[i] - client.resp.cmd_angles[i]);
  }

  ent.s.angles[PITCH] = 0;
  ent.s.angles[YAW] = spawn_angles[YAW];
  ent.s.angles[ROLL] = 0;
  VectorCopy(ent.s.angles, client.ps.viewangles);
  VectorCopy(ent.s.angles, client.v_angle);

  if (CTFStartClient(ent)) return;

  if (!KillBox(ent)) {
    // couldn't spawn in?
  }

  gi.linkentity(ent);

  // force the current weapon up
  client.newweapon = client.pers.weapon;
  ChangeWeapon(ent);
}

/*
=====================
ClientBeginDeathmatch

A client has just connected to the server in
deathmatch mode, so clear everything out before starting them.
=====================
*/
export function ClientBeginDeathmatch(ent: EdictT): void {
  G_InitEdict(ent);

  if (ent.client !== null) InitClientResp(ent.client);

  // locate ent at a spawn point
  PutClientInServer(ent);

  if (level.intermissiontime !== 0) {
    MoveClientToIntermission(ent);
  } else {
    // send effect
    gi.WriteByte(svc_muzzleflash);
    gi.WriteShort(EDICT_NUM(ent));
    gi.WriteByte(MZ_LOGIN);
    gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);
  }

  if (ent.client !== null) {
    gi.bprintf(PRINT_HIGH, `${ent.client.pers.netname} entered the game\n`);
  }

  // make sure all view stuff is valid
  ClientEndServerFrame(ent);
}

/*
===========
ClientBegin

called when a client has finished connecting, and is ready
to be placed into the game.  This will happen every level load.
============
*/
export function ClientBegin(entIn: Edict): void {
  const ent = edictFromBoundary(entIn);
  const client = game.clients[EDICT_NUM(ent) - 1];
  ent.client = client;

  if (cvarNum(gameCvars.deathmatch) !== 0) {
    ClientBeginDeathmatch(ent);
    return;
  }

  // if there is already a body waiting for us (a loadgame), just
  // take it, otherwise spawn one from scratch
  if (ent.inuse === true) {
    // the client has cleared the client side viewangles upon
    // connecting to the server, which is different than the
    // state when the game is saved, so we need to compensate
    // with deltaangles
    for (let i = 0; i < 3; i++) {
      client.ps.pmove.delta_angles[i] = ANGLE2SHORT(client.ps.viewangles[i]);
    }
  } else {
    // a spawn point will completely reinitialize the entity
    // except for the persistant data that was initialized at
    // ClientConnect() time
    G_InitEdict(ent);
    ent.classname = "player";
    InitClientResp(client);
    PutClientInServer(ent);
  }

  if (level.intermissiontime !== 0) {
    MoveClientToIntermission(ent);
  } else {
    // send effect if in a multiplayer game
    if (game.maxclients > 1) {
      gi.WriteByte(svc_muzzleflash);
      gi.WriteShort(EDICT_NUM(ent));
      gi.WriteByte(MZ_LOGIN);
      gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

      gi.bprintf(PRINT_HIGH, `${client.pers.netname} entered the game\n`);
    }
  }

  // make sure all view stuff is valid
  ClientEndServerFrame(ent);
}

/*
===========
ClientUserInfoChanged

called whenever the player updates a userinfo variable.

The game can override any of the settings in place
(forcing skins or names, etc) before copying it off.
============
*/
export function ClientUserinfoChanged(entIn: Edict, userinfoIn: string): void {
  const ent = edictFromBoundary(entIn);
  if (ent.client === null) return; // defensive; C assumes ent->client is already set
  const client = ent.client;

  // check for malformed or illegal info strings
  let userinfo = userinfoIn;
  if (!Info_Validate(userinfo)) {
    userinfo = "\\name\\badinfo\\skin\\male/grunt";
  }

  // set name
  let s = Info_ValueForKey(userinfo, "name");
  client.pers.netname = s.slice(0, 15); // char[16], sizeof(netname)-1

  // set skin
  s = Info_ValueForKey(userinfo, "skin");

  const playernum = EDICT_NUM(ent) - 1;

  // combine name and skin into a configstring
  if (ctfEnabled()) {
    CTFAssignSkin(ent, s);
  } else {
    gi.configstring(CS_PLAYERSKINS + playernum, `${client.pers.netname}\\${s}`);
  }

  // set player name field (used in id_state view)
  gi.configstring(CS_GENERAL + playernum, client.pers.netname);

  // fov
  if (cvarNum(gameCvars.deathmatch) !== 0 && ((cvarNum(gameCvars.dmflags) | 0) & DF_FIXED_FOV) !== 0) {
    client.ps.fov = 90;
  } else {
    client.ps.fov = atoiC(Info_ValueForKey(userinfo, "fov"));
    if (client.ps.fov < 1) client.ps.fov = 90;
    else if (client.ps.fov > 160) client.ps.fov = 160;
  }

  // handedness
  s = Info_ValueForKey(userinfo, "hand");
  if (s.length > 0) {
    client.pers.hand = atoiC(s);
  }

  // save off the userinfo in case we want to check something later
  client.pers.userinfo = userinfo.slice(0, MAX_INFO_STRING - 1);
}

/*
===========
ClientConnect

Called when a player begins connecting to the server.
The game can refuse entrance to a client by returning false.
If the client is allowed, the connection process will continue
and eventually get to ClientBegin()
Changing levels will NOT cause this to be called again, but
loadgames will.
============
*/
export function ClientConnect(entIn: Edict, userinfoIn: string): { allowed: boolean; userinfo: string } {
  const ent = edictFromBoundary(entIn);
  let userinfo = userinfoIn;

  // check to see if they are on the banned IP list
  let value = Info_ValueForKey(userinfo, "ip");
  if (SV_FilterPacket(value)) {
    userinfo = Info_SetValueForKey(userinfo, "rejmsg", "Banned.");
    return { allowed: false, userinfo };
  }

  // check for a password
  value = Info_ValueForKey(userinfo, "password");
  const pass = cvarStr(gameCvars.password);
  if (pass.length > 0 && pass !== "none" && pass !== value) {
    userinfo = Info_SetValueForKey(userinfo, "rejmsg", "Password required or incorrect.");
    return { allowed: false, userinfo };
  }

  // they can connect
  const client = game.clients[EDICT_NUM(ent) - 1];
  ent.client = client;

  // if there is already a body waiting for us (a loadgame), just
  // take it, otherwise spawn one from scratch
  if (ent.inuse === false) {
    // clear the respawning variables
    // force team join
    client.resp.ctf_team = -1;
    client.resp.id_state = true;
    InitClientResp(client);
    if (!game.autosaved || client.pers.weapon === null) InitClientPersistant(client);
  }

  ClientUserinfoChanged(ent, userinfo);

  if (game.maxclients > 1) {
    gi.dprintf(`${client.pers.netname} connected\n`);
  }

  client.pers.connected = true;
  return { allowed: true, userinfo };
}

/*
===========
ClientDisconnect

Called when a player drops from the server.
Will not be called between levels.
============
*/
export function ClientDisconnect(entIn: Edict): void {
  const ent = edictFromBoundary(entIn);
  if (ent.client === null) return;

  gi.bprintf(PRINT_HIGH, `${ent.client.pers.netname} disconnected\n`);

  // RERELEASE CONTENT PORT -- ROGUE (rogue/p_client.c's ClientDisconnect).
  // make sure no trackers are still hurting us.
  if (ent.client.tracker_pain_framenum !== 0) RemoveAttackingPainDaemons(ent);

  if (ent.client.owned_sphere !== null) {
    if (ent.client.owned_sphere.inuse) G_FreeEdict(ent.client.owned_sphere);
    ent.client.owned_sphere = null;
  }
  // ROGUE

  CTFDeadDropFlag(ent);
  CTFDeadDropTech(ent);

  // send effect
  gi.WriteByte(svc_muzzleflash);
  gi.WriteShort(EDICT_NUM(ent));
  gi.WriteByte(MZ_LOGOUT);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  gi.unlinkentity(ent);
  ent.s.modelindex = 0;
  ent.solid = SolidT.SOLID_NOT;
  ent.inuse = false;
  ent.classname = "disconnected";
  ent.client.pers.connected = false;

  const playernum = EDICT_NUM(ent) - 1;
  gi.configstring(CS_PLAYERSKINS + playernum, "");
}

//==============================================================

// `edict_t *pm_passent;` -- module-scope global read by PM_trace, written by
// ClientThink before every gi.Pmove() call, matching the C global exactly.
let pm_passent: EdictT | null = null;

// pmove doesn't need to know about passent and contentmask
function PM_trace(start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3): GTraceT {
  if (pm_passent !== null && pm_passent.health > 0) {
    return gi.trace(start, mins, maxs, end, pm_passent, MASK_PLAYERSOLID);
  }
  return gi.trace(start, mins, maxs, end, pm_passent, MASK_DEADSOLID);
}

// `unsigned CheckBlock(void *b, int c)` and `void PrintPmove(pmove_t *pm)`
// are dropped: both are debug-only helpers with no call sites anywhere in
// the C tree except PrintPmove calling CheckBlock, and PrintPmove itself is
// never called from p_client.c or anywhere else (confirmed by grepping the
// full quake-2-c tree). They operate on raw `sizeof()`-based byte
// checksums of C structs, which has no meaningful TS equivalent, and since
// they're unreachable dead code, porting them would add unused code with no
// faithful behavior to preserve.

/*
==============
ClientThink

This will be called once for each client frame, which will
usually be a couple times for each server frame.
==============
*/
export function ClientThink(entIn: Edict, ucmd: UsercmdT): void {
  const ent = edictFromBoundary(entIn);
  if (ent.client === null) return; // defensive; C assumes ent->client is set
  const client = ent.client;

  level.current_entity = ent;

  if (level.intermissiontime !== 0) {
    client.ps.pmove.pm_type = PmTypeT.PM_FREEZE;
    // can exit intermission after five seconds
    if (level.time > level.intermissiontime + 5.0 && (ucmd.buttons & BUTTON_ANY) !== 0) {
      level.exitintermission = 1;
    }
    return;
  }

  pm_passent = ent;

  if (client.chase_target !== null) {
    client.resp.cmd_angles[0] = SHORT2ANGLE(ucmd.angles[0]);
    client.resp.cmd_angles[1] = SHORT2ANGLE(ucmd.angles[1]);
    client.resp.cmd_angles[2] = SHORT2ANGLE(ucmd.angles[2]);
    return;
  }

  // set up for pmove
  const pm = new PmoveT();

  if (ent.movetype === MovetypeT.MOVETYPE_NOCLIP) client.ps.pmove.pm_type = PmTypeT.PM_SPECTATOR;
  else if (ent.s.modelindex !== 255) client.ps.pmove.pm_type = PmTypeT.PM_GIB;
  else if (ent.deadflag !== DEAD_NO) client.ps.pmove.pm_type = PmTypeT.PM_DEAD;
  else client.ps.pmove.pm_type = PmTypeT.PM_NORMAL;

  client.ps.pmove.gravity = cvarNum(gameCvars.sv_gravity);
  // C: `pm.s = client->ps.pmove;` -- struct value copy; see clonePmoveState.
  pm.s = clonePmoveState(client.ps.pmove);

  for (let i = 0; i < 3; i++) {
    pm.s.origin[i] = ent.s.origin[i] * 8;
    pm.s.velocity[i] = ent.velocity[i] * 8;
  }

  if (!pmoveStateEqual(client.old_pmove, pm.s)) {
    pm.snapinitial = true;
  }

  pm.cmd = ucmd;

  pm.trace = PM_trace; // adds default parms
  pm.pointcontents = gi.pointcontents;

  // perform a pmove
  gi.Pmove(pm);

  // save results of pmove (two independent copies, matching C's by-value
  // struct assignment -- see clonePmoveState's comment)
  client.ps.pmove = clonePmoveState(pm.s);
  client.old_pmove = clonePmoveState(pm.s);

  for (let i = 0; i < 3; i++) {
    ent.s.origin[i] = pm.s.origin[i] * 0.125;
    ent.velocity[i] = pm.s.velocity[i] * 0.125;
  }

  VectorCopy(pm.mins, ent.mins);
  VectorCopy(pm.maxs, ent.maxs);

  client.resp.cmd_angles[0] = SHORT2ANGLE(ucmd.angles[0]);
  client.resp.cmd_angles[1] = SHORT2ANGLE(ucmd.angles[1]);
  client.resp.cmd_angles[2] = SHORT2ANGLE(ucmd.angles[2]);

  const newGround = recoverEdict(pm.groundentity);
  if (ent.groundentity !== null && newGround === null && pm.cmd.upmove >= 10 && pm.waterlevel === 0) {
    gi.sound(ent, CHAN_VOICE, gi.soundindex("*jump1.wav"), 1, ATTN_NORM, 0);
    PlayerNoise(ent, ent.s.origin, PNOISE_SELF);
  }

  ent.viewheight = pm.viewheight;
  ent.waterlevel = pm.waterlevel;
  ent.watertype = pm.watertype;
  ent.groundentity = newGround;
  if (newGround !== null) ent.groundentity_linkcount = newGround.linkcount;

  if (ent.deadflag !== DEAD_NO) {
    client.ps.viewangles[ROLL] = 40;
    client.ps.viewangles[PITCH] = -15;
    client.ps.viewangles[YAW] = client.killer_yaw;
  } else {
    VectorCopy(pm.viewangles, client.v_angle);
    VectorCopy(pm.viewangles, client.ps.viewangles);
  }

  if (client.ctf_grapple !== null) CTFGrapplePull(client.ctf_grapple);

  gi.linkentity(ent);

  if (ent.movetype !== MovetypeT.MOVETYPE_NOCLIP) G_TouchTriggers(ent);

  // touch other objects
  for (let i = 0; i < pm.numtouch; i++) {
    const otherRaw = pm.touchents[i];
    let j = 0;
    for (; j < i; j++) {
      if (pm.touchents[j] === otherRaw) break;
    }
    if (j !== i) continue; // duplicated
    const other = recoverEdict(otherRaw);
    if (other === null) continue;
    if (other.touch === null) continue;
    other.touch(other, ent, null, null);
  }

  client.oldbuttons = client.buttons;
  client.buttons = ucmd.buttons;
  client.latched_buttons |= client.buttons & ~client.oldbuttons;

  // save light level the player is standing on for
  // monster sighting AI
  ent.light_level = ucmd.lightlevel;

  // fire weapon from final position if needed
  if ((client.latched_buttons & BUTTON_ATTACK) !== 0 && ent.movetype !== MovetypeT.MOVETYPE_NOCLIP) {
    if (!client.weapon_thunk) {
      client.weapon_thunk = true;
      Think_Weapon(ent);
    }
  }

  // regen tech
  CTFApplyRegeneration(ent);

  const maxclients = cvarNum(gameCvars.maxclients);
  for (let i = 1; i <= maxclients; i++) {
    const other = g_edicts[i];
    if (other !== undefined && other.inuse && other.client !== null && other.client.chase_target === ent) {
      UpdateChaseCam(other);
    }
  }

  if (client.menudirty && client.menutime <= level.time) {
    PMenu_Do_Update(ent);
    gi.unicast(ent, true);
    client.menutime = level.time;
    client.menudirty = false;
  }
}

/*
==============
ClientBeginServerFrame

This will be called once for each server frame, before running
any other entities in the world.
==============
*/
export function ClientBeginServerFrame(ent: EdictT): void {
  if (level.intermissiontime !== 0) return;

  if (ent.client === null) return; // defensive; C assumes ent->client is set
  const client = ent.client;

  // run weapon animations if it hasn't been done by a ucmd_t
  if (!client.weapon_thunk && ent.movetype !== MovetypeT.MOVETYPE_NOCLIP) Think_Weapon(ent);
  else client.weapon_thunk = false;

  if (ent.deadflag !== DEAD_NO) {
    // wait for any button just going down
    if (level.time > client.respawn_time) {
      // in deathmatch, only wait for attack button
      const buttonMask = cvarNum(gameCvars.deathmatch) !== 0 ? BUTTON_ATTACK : -1;

      if (
        (client.latched_buttons & buttonMask) !== 0 ||
        (cvarNum(gameCvars.deathmatch) !== 0 && ((cvarNum(gameCvars.dmflags) | 0) & DF_FORCE_RESPAWN) !== 0) ||
        CTFMatchOn()
      ) {
        respawn(ent);
        client.latched_buttons = 0;
      }
    }
    return;
  }

  // add player trail so monsters can follow
  if (cvarNum(gameCvars.deathmatch) === 0) {
    const lastSpot = PlayerTrail_LastSpot();
    if (lastSpot === null || !visible(ent, lastSpot)) {
      PlayerTrail_Add(ent.s.old_origin);
    }
  }

  client.latched_buttons = 0;
}
