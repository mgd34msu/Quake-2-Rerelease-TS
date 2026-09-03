// Ports a SUBSET of lmctf60/p_client.c (3411 lines total; diff vs
// quake-2/ctf/p_client.c is 2980 lines of 1726 -- almost a full rewrite).
// g_local.h attributes these prototypes to "g_client.c"/"g_player.c",
// neither of which exists in the source tree; every one is actually
// defined in p_client.c, matching src/ctf/p_client.ts's own header note.
//
// STATUS: the client lifecycle (ClientConnect/ClientBegin/
// ClientBeginDeathmatch/ClientUserinfoChanged/ClientDisconnect), the full
// team-assignment chain (Num_Of_Players/Team_To_Join/TeamJoin, wired
// through g_ctffunc.ts's ctf_SetEntTeamEx), the full spawn-point-selection
// chain (PlayersRangeFromSpot/SelectRandomDeathmatchSpawnPoint/
// SelectFarthestDeathmatchSpawnPoint/SelectTeamSpawnPoint/
// SelectAnySpawnPoint/SelectDeathmatchSpawnPoint/SelectCoopSpawnPoint/
// SelectSpawnPoint), PutClientInServer, InitClientPersistent/InitClientResp/
// SaveClientData/FetchClientEntData, InitBodyQue/body_die/CopyToBodyQue/
// respawn, the six info_player_* spawn markers, and a pmove-driving
// ClientThink/ClientBeginServerFrame are ported -- this is the load-bearing
// "a client connects, is assigned a team, and spawns at the right point"
// path this unit's tests exercise.
//
// LATER PASS (this session) -- the per-frame client hooks and the death
// path were completed against lmctf60 directly:
//   - ClientThink's "fire weapon from final position" block
//     (p_client.c:2852) is now ported, so a held/tapped attack button
//     actually reaches Think_Weapon. Without it NO weapon ever fired.
//   - ClientThink's spectator/team-observer validation + chase controls
//     (p_client.c:2883) and the carried-flag follow block (p_client.c:2951,
//     which drags the flag model along behind its carrier) are ported.
//   - ClientBeginServerFrame (p_client.c:3047) regained RuneThinkHook, the
//     Check_Vote timeout tick, the spectator_respawn dispatch, the
//     STATS_PLAYER_SAMPLE_RATE ping sampling + referee PingAlert, the
//     fallback Think_Weapon call, and the goodskin skin re-assert.
//   - spectator_respawn (p_client.c:1667), PingAlert (p_client.c:2997) and
//     TossClientWeapon (p_client.c:648 -- now portable, g_items.ts has a
//     real Drop_Item) are ported; TossClientWeapon is wired at player_die.
//   - ClientObituary is now checked against lmctf60's own version rather
//     than ThreeWave's: IsNeutral (p_client.c:259) and its three "itself"
//     branches, Gimme_Any_Death_Message + the 44-entry Random_MSG_Kills1
//     pool behind CTF_RANDOM_DEATH_MSG, the New_Death_Messages "'s
//     <weapon>" suffixes, the MOD_PLASMA case, lmctf60's own MOD_CTF_GRAPPLE
//     wording, the Match_CanScore() gate on self-kills, ctf_BSafePrint in
//     place of gi.bprintf, and the stats_add scoring (including the
//     preserved quirk that friendly fire is only penalized while matchstate
//     is MATCH_RAILGUN_INPLAY).
//
// NOT PORTED (each cited at its call site below, not silently dropped):
//   - player_die's CTF flag-defense/carrier scoring block (attacker_flag/
//     defender_flag bonuses, ctf_validateflags, stats_add, sl_LogScore) --
//     depends on ctf_flagathome/ClientHasFlag (g_ctffunc.ts's own
//     documented "flag home/reset" SCOPE exclusion) and unit B's
//     p_stats.ts/gslog.ts. Skipped entirely rather than calling the
//     throwing stubs unconditionally on every death.
//   - ChangeWeapon (p_weapon.c, weapon-switch animation state machine): not
//     ported anywhere in this family (p_weapon.ts only has the offhand-hook
//     chain). PutClientInServer sets client.pers.weapon directly instead of
//     calling ChangeWeapon's real animation dispatch.
//   - PlayerNoise (p_weapon.c): still not ported -- it exists only to feed
//     monster hearing (MONSTERS_OK dead subsystem), so ClientThink's
//     jump-noise call remains dropped with a citation. Think_Weapon IS now
//     wired (see above).
//   - PlayerTrail_Add/PlayerTrail_LastSpot (p_trail.c) and g_ai.ts's
//     `visible` (monster-sighting trail): PlayerTrail exists solely to let
//     monsters follow a player's scent; no monster subsystem exists in this
//     port (MONSTERS_OK dead-code ruling), so this is dead functionality
//     regardless of whether p_trail.ts existed -- skipped, not stubbed.
//   - g_menu.ts's PMenu_Do_Update (LM_CTF's own popup-menu system,
//     replacing ZOID's pmenuhnd_t) -- unit B's SCOPE. ClientThink's
//     menu-update tail is dropped with a citation.
//   - Cmd_Observe_f (g_cmds.ts) -- ClientBeginDeathmatch's
//     "already an observer" branch throws a cited stub if actually reached
//     (a returning player who was already CTF_TEAM_OBSERVER*); the far more
//     common "new player" (CTF_TEAM_UNDEFINED -> TeamJoin) and "returning
//     team player" (ctf_SetEntTeamEx) branches are fully ported.
//   - sl_WriteStdLogPlayerEntered/sl_WriteStdLogDeath/sl_LogPlayerDisconnect
//     (StdLog -- unit B's gslog.ts/stdlog.ts) -- dropped, cited at each
//     call site.
//   - Coop-mode branches throughout (SP_info_player_start's SP_CreateCoopSpots
//     hack, SP_info_player_coop's SP_FixCoopSpots hack, PutClientInServer's
//     coop-inventory-carryover branch) are ported faithfully where cheap
//     (the coop branches themselves) but the two "gross ugly hack" map-fix
//     functions are ported verbatim from src/ctf/p_client.ts since lmctf60's
//     own versions are confirmed byte-identical in this region.
//   - CheckBlock (p_client.c:2595) / PrintPmove (p_client.c:2603): a pmove
//     checksum debug dumper. PrintPmove has NO call site anywhere in
//     lmctf60 and CheckBlock is only called by PrintPmove, so the pair is
//     unreachable -- dropped, not stubbed.
//   - ClientSetSkin (g_skins.c team-skin-file lookup, unit B's SCOPE) --
//     ClientUserinfoChanged writes the raw name\skin configstring directly
//     instead (same fallback ctf's own ClientUserinfoChanged uses when CTF
//     is disabled), cited inline.

import { vec3, type Vec3, VectorClear, VectorCopy, VectorLength, VectorNormalize2, VectorScale, VectorSubtract } from "../shared/math";
import {
  ANGLE2SHORT,
  ATTN_NORM,
  BUTTON_ANY,
  BUTTON_ATTACK,
  CHAN_BODY,
  CHAN_VOICE,
  CS_GENERAL,
  CS_PLAYERSKINS,
  type CvarT,
  DF_FIXED_FOV,
  DF_FORCE_RESPAWN,
  DF_QUAD_DROP,
  DF_SPAWN_FARTHEST,
  type EntityStateT,
  EntityEventT,
  Info_SetValueForKey,
  Info_ValueForKey,
  Info_Validate,
  MASK_DEADSOLID,
  MASK_PLAYERSOLID,
  MAX_INFO_STRING,
  MulticastT,
  MZ_LOGIN,
  MZ_LOGOUT,
  PITCH,
  PlayerStateT,
  PmTypeT,
  PmoveStateT,
  PmoveT,
  PMF_DUCKED,
  PMF_JUMP_HELD,
  PMF_NO_PREDICTION,
  PMF_TIME_TELEPORT,
  PRINT_HIGH,
  PRINT_MEDIUM,
  Q_stricmp,
  ROLL,
  SHORT2ANGLE,
  type UsercmdT,
  YAW,
} from "../shared/q_shared";
import { type Edict, type GTraceT, SolidT, SVF_DEADMONSTER, SVF_NOCLIENT } from "./game";
import { SV_FilterPacket } from "./g_svcmds";
import {
  BODY_QUEUE_SIZE,
  CTF_RANDOM_DEATH_MSG,
  isRef,
  CtfClientT,
  ClientPersistentT,
  ClientRespawnT,
  DEAD_DEAD,
  DEAD_NO,
  DamageT,
  type EdictT,
  FL_GODMODE,
  FL_NOTARGET,
  FL_NO_KNOCKBACK,
  FL_POWER_ARMOR,
  FRAMETIME,
  type GClientT,
  type GItemT,
  GIB_ORGANIC,
  MOD_CTF_GRAPPLE,
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
  MOD_FRIENDLY_FIRE,
  MOD_G_SPLASH,
  MOD_GRENADE,
  MOD_HANDGRENADE,
  MOD_HELD_GRENADE,
  MOD_HG_SPLASH,
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
  game,
  g_edicts,
  gameCvars,
  gi,
  level,
  meansOfDeathHolder,
  DROPPED_PLAYER_ITEM,
  svc_muzzleflash,
  svc_stufftext,
  world,
} from "./g_local";
import { G_Find, G_FreeEdict, G_InitEdict, G_Spawn, G_TouchTriggers, KillBox } from "./g_utils";
import { SP_misc_teleporter_dest, ThrowClientHead, ThrowGib } from "./g_misc";
import { Drop_Item, FindItem, FindItemByClassname, ITEM_INDEX, Touch_Item } from "./g_items";
import { UpdateChaseCam } from "./g_chase";
import {
  CTF_TEAM_ANYTEAM,
  CTF_TEAM_BLUE,
  CTF_TEAM_LIMIT,
  CTF_TEAM_MIN_LIMIT,
  CTF_TEAM_OBSERVER,
  CTF_TEAM_OBSERVER_BLUE,
  CTF_TEAM_OBSERVER_RED,
  CTF_TEAM_OPPOSING,
  CTF_TEAM_RED,
  CTF_TEAM_UNDEFINED,
  ctf_BSafePrint,
  ctf_SafePrint,
  ctf_findplayer,
  ctf_getteamflag,
  ctf_SetEntTeamEx,
} from "./g_ctffunc";
import { vectoangles } from "./g_utils";
import { SkinListInUse, SkinRandom, SkinValid } from "./g_skins";
// Death-message scoring + the per-frame hooks ClientBeginServerFrame runs.
// None of these modules import p_client.ts back, so these are plain static
// imports (no lazy-module indirection needed).
import { MOD_PLASMA } from "./plasma";
import { GamePaused, Match_CanScore } from "./g_tourney";
import { STATS_DEATHS, STATS_FRAGS, STATS_PING_SAMPLES, STATS_PING_TOTAL, STATS_PLAYER_SAMPLE_RATE, STATS_SCORE, stats_add } from "./p_stats";
import { RuneThinkHook } from "./g_runes";
import { Check_Vote, VoteStarted } from "./g_vote";
import { ChaseNext, GetChaseTarget, Team_Observer_OK } from "./g_chase";
import { Think_Weapon } from "./p_weapon";

// gameCvars entries are `CvarT | null` until InitGame resolves them; mirrors
// every other file's local cvarNum-style helper.
function cvarNum(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}
function cvarStr(c: CvarT | null): string {
  return c === null ? "" : c.string;
}

function atoiC(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

function requireItem(item: GItemT | null): GItemT {
  if (item !== null) return item;
  gi.error("p_client: expected item lookup to succeed");
}

// `client_persistent_t` is assigned by value in several C call sites; TS
// objects are references, so an explicit field-by-field clone is needed
// wherever the original relies on the copy being independently mutable
// afterward -- same rationale as src/ctf/p_client.ts's identical helper.
function cloneClientPersistent(src: ClientPersistentT): ClientPersistentT {
  const c = new ClientPersistentT();
  c.userinfo = src.userinfo;
  c.netname = src.netname;
  c.squad = src.squad;
  c.squadStatus = src.squadStatus;
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
  // RERELEASE CONTENT PORT -- the mission-pack ammo caps travel with the
  // rest of client_persistant_t across a level change / coop respawn, same
  // as vanilla's six above (src/rogue/p_client.ts, src/xatrix/p_client.ts).
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
}

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

// See src/ctf/p_client.ts's identical function for the full staleness-bug
// rationale (g_spawn.ts's SpawnEntities clears every edict including
// reserved player slots; a player slot's s.number is not restored until
// after ClientConnect runs). Recovering by reference identity avoids it.
function edictFromBoundary(entIn: Edict): EdictT {
  const found = g_edicts.find((e) => e === entIn);
  if (found !== undefined) return found;
  gi.error("lmctf/p_client: boundary edict not found in g_edicts");
}

// GetChaseTarget()/ChaseNext() reassign client.chase_target through the
// client object, which TypeScript's control-flow analysis cannot see. Reading
// the field through this helper returns its declared type rather than the
// stale narrowed one.
function currentChaseTarget(client: GClientT): EdictT | null {
  return client.chase_target;
}

function EDICT_NUM(e: EdictT): number {
  return g_edicts.indexOf(e);
}

//
// Gross, ugly, disgusting hack section -- byte-identical to
// src/ctf/p_client.ts's versions (confirmed no diff in this region between
// quake-2/ctf/p_client.c and lmctf60/p_client.c).
//
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
    self.think = SP_FixCoopSpots;
    self.nextthink = level.time + FRAMETIME;
  }
}

/*
CTF CODE -- LM_JORM (lmctf60/p_client.c:194/210)

Map-placed team spawn markers. If the map didn't give this spot a facing,
turn it to face the corresponding team's flag marker (redflag/blueflag,
set by g_spawn.ts's SP_info_flag_red/blue once those markers spawn --
map load order means the flag markers may not have spawned yet when this
runs, matching the C source's identical "if (!self->s.angles[1] &&
redflag)" null-check, not a bug this port introduces).
*/
export function SP_info_player_red(self: EdictT): void {
  if (self.s.angles[1] === 0 && redFlagRef() !== null) {
    const flag = redFlagRef();
    if (flag !== null) {
      const end = vec3();
      const angles = vec3();
      VectorSubtract(flag.s.origin, self.s.origin, end);
      vectoangles(end, angles);
      self.s.angles[1] = angles[1];
    }
  }
  self.classname = "info_player_red";
}

export function SP_info_player_blue(self: EdictT): void {
  if (self.s.angles[1] === 0 && blueFlagRef() !== null) {
    const flag = blueFlagRef();
    if (flag !== null) {
      const end = vec3();
      const angles = vec3();
      VectorSubtract(flag.s.origin, self.s.origin, end);
      vectoangles(end, angles);
      self.s.angles[1] = angles[1];
    }
  }
  self.classname = "info_player_blue";
}

// g_local.ts's redflag/blueflag are plain `let` exports (not const), so a
// live re-read at call time (not a static import binding snapshot) is
// needed -- these two tiny accessors exist only to satisfy that.
import { blueflag, redflag } from "./g_local";
function redFlagRef(): EdictT | null {
  return redflag;
}
function blueFlagRef(): EdictT | null {
  return blueflag;
}

/*QUAKED info_player_intermission (1 0 1) (-16 -16 -24) (16 16 32)
*/
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

/*
IsNeutral (lmctf60/p_client.c:259)

True when the client's userinfo "gender" is neither male nor female, which
makes ClientObituary use the "itself" wording instead of his/her. Note the
QUIRK carried over from the C: IsFemale reads the "skin" key while
IsNeutral reads the "gender" key -- the two disagree on which userinfo
field decides sex, and lmctf60 ships it that way.
*/
function IsNeutral(ent: EdictT): boolean {
  if (ent.client === null) return false;
  const info = Info_ValueForKey(ent.client.pers.userinfo, "gender");
  const c = info[0];
  return c !== "f" && c !== "F" && c !== "m" && c !== "M";
}

// Random_MSG_Kills1 (lmctf60/p_client.c:278, DIF_MSG_DEATHS == 44) -- the
// kill-phrase pool the CTF_RANDOM_DEATH_MSG ctfflag swaps in for the normal
// per-weapon obituary verb.
const Random_MSG_Kills1: string[] = [
  "bit the dust of",
  "visits the Grim Reaper by",
  "becomes one with death by",
  "drops 6 feet under by",
  "takes a high ride in the sky by",
  "camps under a gravestone from",
  "needs a tissue because of",
  "likes the taste of blood from",
  "has a crap connection from",
  "can't see so good from",
  "smokes a peace pipe with the gods and",
  "practices with",
  "cry's home to his momma from",
  "soiled his shorts from",
  "steps into a coffin from",
  "whines of his connection from",
  "would rather play alone than with",
  "gets caught checkin' Briana's booty and takes it from",
  "sees his brain splatter on the wall from",
  "is picking up pieces of his skull from",
  "is busy playing with his joystick and",
  "becomes bored with life from",
  "buys a ticket on the train of death from",
  "paints a pretty picture with his blood from",
  "is stinking up the field from",
  "leaves a poop stain on his seat from",
  "needs help finding his teeth from",
  "bites the big one from",
  "searches for his severed head from",
  "sucks on",
  "get's a lesson from",
  "enjoy's getting killed by",
  "was eeged by",
  "starts to cry from",
  "is hunted by",
  "gets flipped the bird from",
  "curses",
  "gets mud in the face from",
  "plays with",
  "takes it in the cooter from",
  "gets jarred in the jaw from",
  "bleeds in the gut from",
  "chokes on",
  "takes it up the arse from",
];

// Death_Msg_String (lmctf60/p_client.c:274) -- the C keeps one global
// scratch buffer that Gimme_Any_Death_Message fills and ClientObituary then
// points `message` at.
const deathMsgString = { value: "" };

/*
Gimme_Any_Death_Message (lmctf60/p_client.c:350)
*/
function Gimme_Any_Death_Message(): void {
  const index = Math.floor(Math.random() * Random_MSG_Kills1.length);
  deathMsgString.value = Random_MSG_Kills1[index] ?? "";
}

/*
ClientObituary -- see file header's Uncertainties note: the base MOD_*
message table is reused from src/ctf/p_client.ts (shared baseq2 heritage),
with MOD_GRAPPLE (ctf/ThreeWave's grapple, doesn't exist in lmctf60) swapped
for MOD_CTF_GRAPPLE (LM_CTF's own hook, g_local.ts). NOT independently
verified against lmctf60/p_client.c's own ClientObituary text (that
function is heavily interleaved with the unported CTF flag-defense scoring
block, making direct extraction difficult under this unit's time budget) --
flagged for follow-up verification.
*/
export function ClientObituary(self: EdictT, inflictor: EdictT, attacker: EdictT): void {
  if (cvarNum(gameCvars.coop) !== 0 && attacker.client !== null) {
    meansOfDeathHolder.meansOfDeath |= MOD_FRIENDLY_FIRE;
  }

  if (self.client === null) return;

  // New_Death_Messages (lmctf60/p_client.c:367) -- the SAME ctfflag that
  // swaps in the random kill phrases also turns on the extra "'s <weapon>"
  // suffixes below.
  const New_Death_Messages = (cvarNum(gameCvars.ctfflags) & CTF_RANDOM_DEATH_MSG) !== 0;

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
          // lmctf60/p_client.c:437 -- neutral gender takes priority over the
          // his/her split.
          message = IsNeutral(self)
            ? "tripped on its own grenade"
            : IsFemale(self)
              ? "tripped on her own grenade"
              : "tripped on his own grenade";
          break;
        case MOD_R_SPLASH:
          // lmctf60/p_client.c:445
          message = IsNeutral(self) ? "blew itself up" : IsFemale(self) ? "blew herself up" : "blew himself up";
          break;
        case MOD_BFG_BLAST:
          message = "should have used a smaller gun";
          break;
        default:
          // lmctf60/p_client.c:463
          message = IsNeutral(self) ? "killed itself" : IsFemale(self) ? "killed herself" : "killed himself";
          break;
      }
    }

    if (message !== null) {
      // lmctf60/p_client.c:473 -- the whole print+score is gated on
      // Match_CanScore(); `self.enemy = null` happens either way.
      if (Match_CanScore()) {
        ctf_BSafePrint(PRINT_HIGH, `${self.client.pers.netname} ${message}.\n`);
        if (cvarNum(gameCvars.deathmatch) !== 0) {
          self.client.resp.score--;
          stats_add(self, STATS_SCORE, -1);
          stats_add(self, STATS_DEATHS, 1);
        }
      }
      self.enemy = null;
      return;
    }

    self.enemy = attacker;
    if (attacker.client !== null) {
      switch (mod) {
        case MOD_BLASTER:
          message = "was blasted by";
          if (New_Death_Messages) message2 = "'s blaster";
          break;
        case MOD_SHOTGUN:
          message = "was gunned down by";
          if (New_Death_Messages) message2 = "'s shotgun";
          break;
        case MOD_SSHOTGUN:
          message = "was blown away by";
          message2 = "'s super shotgun";
          break;
        case MOD_MACHINEGUN:
          message = "was machinegunned by";
          if (New_Death_Messages) message2 = "'s machinegun";
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
          if (New_Death_Messages) message2 = "'s railgun";
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
        // lmctf60/p_client.c:565 (SKWiD plasma mod)
        case MOD_PLASMA:
          message = "got an infusion of plasma from";
          if (New_Death_Messages) message2 = "'s plasma rifle";
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
          message2 = New_Death_Messages ? "'s paingrenade" : "'s pain";
          break;
        case MOD_TELEFRAG:
          message = "tried to invade";
          message2 = "'s personal space";
          break;
        // lmctf60/p_client.c:595 -- lmctf60's own wording, NOT ThreeWave's
        // "was caught by"/"'s grapple".
        case MOD_CTF_GRAPPLE:
          message = "was gored by";
          message2 = "'s grappling hook";
          break;
      }
      if (message !== null) {
        // lmctf60/p_client.c:601 -- CTF_RANDOM_DEATH_MSG replaces the
        // per-weapon verb wholesale (message2 is still appended).
        if ((cvarNum(gameCvars.ctfflags) & CTF_RANDOM_DEATH_MSG) !== 0) {
          Gimme_Any_Death_Message();
          message = deathMsgString.value;
        }
        ctf_BSafePrint(PRINT_HIGH, `${self.client.pers.netname} ${message} ${attacker.client.pers.netname}${message2}\n`);
        if (cvarNum(gameCvars.deathmatch) !== 0) {
          // QUIRK preserved from lmctf60/p_client.c:613: a friendly-fire kill
          // is only penalized while matchstate is MATCH_RAILGUN_INPLAY. In
          // every other state a teamkill still INCREMENTS the killer's score,
          // exactly as the C does.
          if (ff && matchstate === MatchStatesT.MATCH_RAILGUN_INPLAY) {
            stats_add(attacker, STATS_SCORE, -1);
            stats_add(attacker, STATS_DEATHS, 1);
            attacker.client.resp.score--;
          } else {
            stats_add(attacker, STATS_SCORE, 1);
            stats_add(attacker, STATS_FRAGS, 1);
            attacker.client.resp.score++;
          }
        }
        return;
      }
    }
  }

  // lmctf60/p_client.c:632
  ctf_BSafePrint(PRINT_HIGH, `${self.client.pers.netname} died.\n`);
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    self.client.resp.score--;
    stats_add(self, STATS_SCORE, -1);
    stats_add(self, STATS_DEATHS, 1);
  }
}

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

let playerDieAnimIndex = 0;

/*
player_die -- see file header for the dropped CTF flag-defense scoring
block, TossClientWeapon's Drop_Item gap, and the animation-frame
simplification (m_player_frames.ts does not exist in this family; death
frame numbers are left at their EdictT default of 0 rather than inventing
frame constants, so the death POSE is generic but the STATE transition --
deadflag/movetype/gib-vs-normal branch/respawn timer -- is fully faithful).
*/
export function player_die(self: EdictT, inflictor: EdictT, attacker: EdictT, damage: number, _point: Vec3): void {
  VectorClear(self.avelocity);

  self.takedamage = DamageT.DAMAGE_YES;
  self.movetype = MovetypeT.MOVETYPE_TOSS;

  self.s.modelindex2 = 0;
  self.s.modelindex3 = 0;

  self.s.angles[0] = 0;
  self.s.angles[2] = 0;

  self.s.sound = 0;
  if (self.client !== null) self.client.weapon_sound = 0;

  self.maxs[2] = -8;
  self.svflags |= SVF_DEADMONSTER;

  if (self.client !== null && self.client.hook !== null) {
    G_FreeEdict(self.client.hook);
    self.client.hook = null;
  }

  if (self.deadflag === DEAD_NO) {
    if (self.client !== null) {
      self.client.respawn_time = level.time + 1.0;
      LookAtKiller(self, inflictor, attacker);
      self.client.ps.pmove.pm_type = PmTypeT.PM_DEAD;
    }
    ClientObituary(self, inflictor, attacker);
    TossClientWeapon(self);
  }

  if (self.client !== null) {
    self.client.quad_framenum = 0;
    self.client.invincible_framenum = 0;
    self.client.breather_framenum = 0;
    self.client.enviro_framenum = 0;
    self.flags &= ~FL_POWER_ARMOR;
    self.client.pers.inventory.fill(0);
  }

  if (self.health < -40) {
    gi.sound(self, CHAN_BODY, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
    for (let n = 0; n < 4; n++) {
      ThrowGib(self, "models/objects/gibs/sm_meat/tris.md2", damage, GIB_ORGANIC);
    }
    ThrowClientHead(self, damage);
    self.takedamage = DamageT.DAMAGE_NO;
  } else if (self.deadflag === DEAD_NO) {
    playerDieAnimIndex = (playerDieAnimIndex + 1) % 3;
    gi.sound(self, CHAN_VOICE, gi.soundindex(`*death${Math.floor(Math.random() * 4) + 1}.wav`), 1, ATTN_NORM, 0);
  }

  self.deadflag = DEAD_DEAD;
  gi.linkentity(self);
}

//=======================================================================

/*
InitClientPersistent (lmctf60/p_client.c:1108) -- gives every new client a
Grappling Hook (LM_CTF's always-owned weapon slot) alongside the Blaster,
matching the C source's two-item inventory seed exactly.
*/
export function InitClientPersistent(client: GClientT): void {
  client.pers = new ClientPersistentT();

  const hook = FindItem("Grappling Hook");
  if (hook !== null) client.pers.inventory[ITEM_INDEX(hook)] = 1;

  const item = requireItem(FindItem("Blaster"));
  client.pers.selected_item = ITEM_INDEX(item);
  client.pers.inventory[client.pers.selected_item] = 1;
  client.pers.weapon = item;

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
  // taken verbatim from their own sources.
  // ROGUE
  client.pers.max_prox = 50;
  client.pers.max_tesla = 50;
  client.pers.max_flechettes = 200;
  // ROGUE
  // RAFAEL
  client.pers.max_magslug = 50;
  client.pers.max_trap = 5;
  // RAFAEL
  // The disruptor's cap. 12 is the value the rerelease's own
  // InitClientPersistant uses (src/kexgame/p_client.ts:
  // `max_ammo[AMMO_DISRUPTOR] = 12`). Seeded here rather than hardcoded at
  // the Add_Ammo call site so a Bandolier/Ammo Pack can raise it like
  // every other cap.
  client.pers.max_rounds = 12;
  // NOTE: `max_mines` is in ClientPersistantT but neither rogue nor xatrix
  // seeds it or reads it -- rogue's mines (prox/tesla) use max_prox and
  // max_tesla. Left at its ClientPersistantT default of 0 on purpose; no
  // ported code reads it. Flagged in the port report.

  client.pers.connected = true;
}

/*
InitClientResp (lmctf60/p_client.c:1145) -- preserves client.ctf and
p_stats_player across the reset (matching the C source's
ctftemp/playertemp save-restore dance), and applies the CTF_TEAM_RESET
ctfflags bit if set (forces a non-observer back to CTF_TEAM_UNDEFINED so
ClientBeginDeathmatch's TeamJoin re-picks a team). p_stats_player-related
mutation elsewhere is unit B's SCOPE; only the save/restore copy (a plain
field assignment, no stats logic) is reproduced here.
*/
import { CTF_TEAM_RESET } from "./g_local";
export function InitClientResp(client: GClientT): void {
  const ctf = client.ctf;
  const pStatsPlayer = client.p_stats_player;

  client.resp = new ClientRespawnT();
  client.resp.enterframe = level.framenum;

  client.ctf = ctf;
  client.p_stats_player = pStatsPlayer;

  const ctfflags = gameCvars.ctfflags === null ? 0 : gameCvars.ctfflags.value;
  if ((ctfflags & CTF_TEAM_RESET) !== 0) {
    if (
      client.ctf.teamnum !== CTF_TEAM_OBSERVER &&
      client.ctf.teamnum !== -2 /* CTF_TEAM_OBSERVER_RED */ &&
      client.ctf.teamnum !== -3 /* CTF_TEAM_OBSERVER_BLUE */
    ) {
      client.ctf.teamnum = CTF_TEAM_UNDEFINED;
    }
  }

  client.resp.coop_respawn = cloneClientPersistent(client.pers);
}

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
  if (ent.client === null) return;
  ent.health = ent.client.pers.health;
  ent.max_health = ent.client.pers.max_health;
  ent.flags |= ent.client.pers.savedFlags;
  if (cvarNum(gameCvars.coop) !== 0) {
    ent.client.resp.score = ent.client.pers.score;
  }
}

//=======================================================================
// SelectSpawnPoint
//=======================================================================

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

  let selection = Math.floor(Math.random() * count);

  spot = null;
  do {
    spot = G_Find(spot, "classname", "info_player_deathmatch");
    if (spot === spot1 || spot === spot2) selection++;
  } while (selection-- !== 0);

  return spot;
}

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

  return G_Find(null, "classname", "info_player_deathmatch");
}

/*
CTF CODE -- LM_JORM: SelectTeamSpawnPoint / SelectAnySpawnPoint
(lmctf60/p_client.c:1369/1413) -- byte-identical logic to the C source.
*/
export function SelectTeamSpawnPoint(ent: EdictT): EdictT | null {
  if (ent.client === null) return null;
  const spawntype = ent.client.ctf.teamnum === CTF_TEAM_RED ? "info_player_red" : "info_player_blue";

  let bestspot: EdictT | null = null;
  let bestdistance = 0;
  let spot: EdictT | null = null;

  while ((spot = G_Find(spot, "classname", spawntype)) !== null) {
    const bestplayerdistance = PlayersRangeFromSpot(spot);
    if (bestplayerdistance > bestdistance) {
      bestspot = spot;
      bestdistance = bestplayerdistance;
    }
  }

  if (bestspot !== null) return bestspot;

  return G_Find(null, "classname", spawntype);
}

export function SelectAnySpawnPoint(ent: EdictT): EdictT | null {
  const spot1 =
    ((cvarNum(gameCvars.dmflags) | 0) & DF_SPAWN_FARTHEST) !== 0
      ? SelectFarthestDeathmatchSpawnPoint()
      : SelectRandomDeathmatchSpawnPoint();

  if (spot1 === null) return null;
  const distance1 = PlayersRangeFromSpot(spot1);

  const spot2 = SelectTeamSpawnPoint(ent);
  if (spot2 === null) return spot1; // no team spawn points

  const distance2 = PlayersRangeFromSpot(spot2);
  return distance1 > distance2 ? spot1 : spot2;
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
  if (index === 0) return null;

  let spot: EdictT | null = null;
  for (;;) {
    spot = G_Find(spot, "classname", "info_player_coop");
    if (spot === null) return null;

    const target = spot.targetname ?? "";
    if (Q_stricmp(game.spawnpoint, target) === 0) {
      index--;
      if (index === 0) return spot;
    }
  }
}

/*
SelectSpawnPoint (lmctf60/p_client.c:1544) -- LM_CTF's own spawn priority
chain: team spawn point first if just-entered this frame, then any spawn
point (weighing team vs deathmatch farthest), then plain deathmatch, then
coop, then finally the flag markers themselves as a last resort. Falls
through to the single-player info_player_start search exactly like ctf's
version when none of the above find anything.
*/
export function SelectSpawnPoint(ent: EdictT, origin: Vec3, angles: Vec3): void {
  let spot: EdictT | null = null;

  if (ent.client !== null && ent.client.resp.enterframe === level.framenum) {
    spot = SelectTeamSpawnPoint(ent);
  }

  if (spot === null) spot = SelectAnySpawnPoint(ent);
  if (spot === null) spot = SelectDeathmatchSpawnPoint();
  if (spot === null) spot = SelectCoopSpawnPoint(ent);
  if (spot === null) spot = G_Find(null, "classname", "info_flag_red");
  if (spot === null) spot = G_Find(null, "classname", "info_flag_blue");

  if (spot === null) {
    while ((spot = G_Find(spot, "classname", "info_player_start")) !== null) {
      if (game.spawnpoint.length === 0 && spot.targetname === null) break;
      if (game.spawnpoint.length === 0 || spot.targetname === null) continue;
      if (Q_stricmp(game.spawnpoint, spot.targetname) === 0) break;
    }

    if (spot === null && game.spawnpoint.length === 0) {
      spot = G_Find(null, "classname", "info_player_start");
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
  const bodyIndex = (cvarNum(gameCvars.maxclients) | 0) + level.body_que + 1;
  const body = g_edicts[bodyIndex];
  level.body_que = (level.body_que + 1) % BODY_QUEUE_SIZE;

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

/*
respawn (lmctf60/p_client.c:1620) -- drops the MATCH_RAILGUN_INPLAY special
case (g_tourney.ts's matchstate is not currently advanced past MATCH_NONE
by anything in this unit's SCOPE, so that branch is unreachable in
practice; ported anyway for fidelity) and Menu_Free (g_menu.ts, unit B's
SCOPE -- GClientT.clear() inside PutClientInServer already discards the
menu state a real memset would, so nothing leaks either way in this port).
*/
import { matchstate, MatchStatesT } from "./g_tourney";
export function respawn(self: EdictT): void {
  if (matchstate === MatchStatesT.MATCH_RAILGUN_INPLAY) {
    self.movetype = MovetypeT.MOVETYPE_NOCLIP;
    self.solid = SolidT.SOLID_NOT;
    self.svflags |= SVF_NOCLIENT;
    self.health = 0;
    return;
  }

  if (cvarNum(gameCvars.deathmatch) !== 0 || cvarNum(gameCvars.coop) !== 0) {
    if (self.movetype !== MovetypeT.MOVETYPE_NOCLIP) CopyToBodyQue(self);
    self.svflags &= ~SVF_NOCLIENT;
    // Menu_Free(self) -- not ported, see doc comment above.
    PutClientInServer(self);
    self.s.event = EntityEventT.EV_PLAYER_TELEPORT;

    if (self.client !== null) {
      self.client.ps.pmove.pm_flags = PMF_TIME_TELEPORT;
      self.client.ps.pmove.pm_time = 14;
      self.client.respawn_time = level.time;
    }
    return;
  }

  gi.AddCommandString("menu_loadgame\n");
}

//==============================================================

/*
PutClientInServer (lmctf60/p_client.c:1802) -- see file header for the
ChangeWeapon simplification (client.pers.weapon set directly instead of
calling the unported animation dispatcher) and the dropped
ctf.ctfid/showctfhud/extra_flags cosmetic setup (real fields on
CtfClientT, but their only consumers -- the CTF HUD/radio-sound system --
are unit B's SCOPE, so setting them here would be a write with no reader
in this unit).
*/
export function PutClientInServer(ent: EdictT): void {
  const mins: Vec3 = vec3(-16, -16, -24);
  const maxs: Vec3 = vec3(16, 16, 32);
  const spawn_origin = vec3();
  const spawn_angles = vec3();

  SelectSpawnPoint(ent, spawn_origin, spawn_angles);

  const index = EDICT_NUM(ent) - 1;
  if (ent.client === null) return;
  const client = ent.client;

  let resp: ClientRespawnT;

  if (cvarNum(gameCvars.deathmatch) !== 0) {
    resp = client.resp;
    const userinfo = client.pers.userinfo;
    const savedSquad = client.pers.squad;
    InitClientPersistent(client);
    ClientUserinfoChanged(ent, userinfo);
    client.pers.squad = savedSquad;
  } else if (cvarNum(gameCvars.coop) !== 0) {
    resp = client.resp;
    const userinfo = client.pers.userinfo;
    resp.coop_respawn.game_helpchanged = client.pers.game_helpchanged;
    resp.coop_respawn.helpchanged = client.pers.helpchanged;
    client.pers = cloneClientPersistent(resp.coop_respawn);
    ClientUserinfoChanged(ent, userinfo);
    if (resp.score > client.pers.score) client.pers.score = resp.score;
  } else {
    resp = new ClientRespawnT();
  }

  const savedCtf = client.ctf;
  const savedStats = client.p_stats_player;

  client.clear();
  if (client.pers.health <= 0) InitClientPersistent(client);
  client.resp = resp;

  FetchClientEntData(ent);

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

  client.ps = new PlayerStateT();

  client.ps.pmove.origin[0] = spawn_origin[0] * 8;
  client.ps.pmove.origin[1] = spawn_origin[1] * 8;
  client.ps.pmove.origin[2] = spawn_origin[2] * 8;

  if (cvarNum(gameCvars.deathmatch) !== 0 && ((cvarNum(gameCvars.dmflags) | 0) & DF_FIXED_FOV) !== 0) {
    client.ps.fov = 90;
  } else {
    client.ps.fov = atoiC(Info_ValueForKey(client.pers.userinfo, "fov"));
    if (client.ps.fov < 1) client.ps.fov = 90;
    else if (client.ps.fov > 160) client.ps.fov = 160;
  }

  const weapon = client.pers.weapon;
  if (weapon !== null) client.ps.gunindex = gi.modelindex(weapon.view_model ?? "");

  ent.s.effects = 0;
  ent.s.modelindex = 255;
  ent.s.modelindex2 = 255;
  ent.s.skinnum = index;

  ent.s.frame = 0;
  VectorCopy(spawn_origin, ent.s.origin);
  ent.s.origin[2] += 1;
  VectorCopy(ent.s.origin, ent.s.old_origin);

  for (let i = 0; i < 3; i++) {
    client.ps.pmove.delta_angles[i] = ANGLE2SHORT(spawn_angles[i] - client.resp.cmd_angles[i]);
  }

  ent.s.angles[PITCH] = 0;
  ent.s.angles[YAW] = spawn_angles[YAW];
  ent.s.angles[ROLL] = 0;
  VectorCopy(ent.s.angles, client.ps.viewangles);
  VectorCopy(ent.s.angles, client.v_angle);

  if (client.pers.spectator) {
    client.chase_target = null;
    client.resp.spectator = true;
    ent.movetype = MovetypeT.MOVETYPE_NOCLIP;
    ent.solid = SolidT.SOLID_NOT;
    ent.svflags |= SVF_NOCLIENT;
    client.ps.gunindex = 0;
    gi.linkentity(ent);
  } else {
    client.resp.spectator = false;

    if (!KillBox(ent)) {
      // couldn't spawn in -- try to kill whatever's blocking (CTF CODE --
      // LM_JORM: possibly a teammate)
      for (;;) {
        const tr = gi.trace(ent.s.origin, ent.mins, ent.maxs, ent.s.origin, null, MASK_PLAYERSOLID);
        if (tr.ent === null) break;
        const blocker = g_edicts[tr.ent.s.number];
        // FIXME (C source's own comment) -- this will look like a suicide
        requireTDamage()(blocker, blocker, blocker, vec3(), ent.s.origin, vec3(), 100000, 0, DAMAGE_NO_PROTECTION_VAL, MOD_TELEFRAG);
        if (blocker.solid !== SolidT.SOLID_NOT) break;
      }
    }

    gi.linkentity(ent);
  }

  client.ctf = savedCtf;
  client.p_stats_player = savedStats;

  // force the current weapon up -- ChangeWeapon not ported, see file header.
  client.newweapon = client.pers.weapon;
  client.pers.weapon = client.newweapon;
}

// Lazy require for T_Damage: g_combat.ts does not import p_client.ts, so
// this isn't strictly a cycle, but T_Damage is only needed for the rare
// KillBox-failed teamkill-retry branch above; resolved through a tiny
// accessor rather than a top-level import to keep this file's import list
// focused on the common path.
import { T_Damage } from "./g_combat";
import { DAMAGE_NO_PROTECTION } from "./g_local";
const DAMAGE_NO_PROTECTION_VAL = DAMAGE_NO_PROTECTION;
function requireTDamage(): typeof T_Damage {
  return T_Damage;
}

/*
ClientBeginDeathmatch (lmctf60/p_client.c:2033) -- the team-assignment
entry point. New players (teamnum === CTF_TEAM_UNDEFINED) auto-join via
TeamJoin; returning team players rejoin via ctf_SetEntTeamEx with
nopenalty=1; returning observers (teamnum < CTF_TEAM_UNDEFINED) throw a
cited stub (Cmd_Observe_f, unit B's p_observer.ts) since that path is rare
and genuinely unported.
*/
export function ClientBeginDeathmatch(ent: EdictT): void {
  G_InitEdict(ent);
  if (ent.client === null) return;

  InitClientResp(ent.client);

  const oldteam = ent.client.ctf.teamnum;
  if (oldteam === CTF_TEAM_UNDEFINED) {
    TeamJoin(ent);
  } else if (oldteam < CTF_TEAM_UNDEFINED) {
    throw new Error("ClientBeginDeathmatch: Cmd_Observe_f (lmctf60/p_client.c) is unit B's SCOPE (p_observer.ts), not ported");
  } else {
    ctf_SetEntTeamEx(ent, oldteam, 1);
  }

  PutClientInServer(ent);

  if (level.intermissiontime !== 0) {
    moveClientToIntermissionMod().MoveClientToIntermission(ent);
  } else {
    gi.WriteByte(svc_muzzleflash);
    gi.WriteShort(EDICT_NUM(ent));
    gi.WriteByte(MZ_LOGIN);
    gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);
  }

  ctf_BSafePrint(PRINT_HIGH, `${ent.client.pers.netname} entered the game\n`);
}

// Lazy require, not a static import: p_hud.ts (MoveClientToIntermission)
// does not exist yet at the time this file was written -- another part of
// this same unit is building it concurrently. Same precedent as
// src/lmctf/g_target.ts.
import type * as PHudModule from "./p_hud";
function moveClientToIntermissionMod(): typeof PHudModule {
  return require("./p_hud") as typeof PHudModule;
}

/*
ClientBegin (lmctf60/p_client.c:2214)
*/
export function ClientBegin(entIn: Edict): void {
  const ent = edictFromBoundary(entIn);
  const client = game.clients[EDICT_NUM(ent) - 1];
  ent.client = client;

  if (cvarNum(gameCvars.deathmatch) !== 0) {
    ClientBeginDeathmatch(ent);
    return;
  }

  if (ent.inuse === true) {
    for (let i = 0; i < 3; i++) {
      client.ps.pmove.delta_angles[i] = ANGLE2SHORT(client.ps.viewangles[i]);
    }
  } else {
    G_InitEdict(ent);
    ent.classname = "player";
    InitClientResp(client);
    PutClientInServer(ent);
  }

  if (level.intermissiontime !== 0) {
    moveClientToIntermissionMod().MoveClientToIntermission(ent);
  } else if (game.maxclients > 1) {
    gi.WriteByte(svc_muzzleflash);
    gi.WriteShort(EDICT_NUM(ent));
    gi.WriteByte(MZ_LOGIN);
    gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);
    ctf_BSafePrint(PRINT_HIGH, `${client.pers.netname} entered the game\n`);
  }
}

/*
ClientUserinfoChanged (lmctf60/p_client.c:2304) -- ClientSetSkin (g_skins.c
team-skin-file lookup, unit B's SCOPE) is not called; the raw name\\skin
configstring is written directly instead, same fallback ctf's own
ClientUserinfoChanged uses when its CTF cvar is disabled.
*/
export function ClientUserinfoChanged(entIn: Edict, userinfoIn: string): void {
  const ent = edictFromBoundary(entIn);
  if (ent.client === null) return;
  const client = ent.client;

  let userinfo = userinfoIn;
  if (!Info_Validate(userinfo)) {
    userinfo = "\\name\\badinfo\\skin\\male/grunt";
  }

  let s = Info_ValueForKey(userinfo, "name");
  client.pers.netname = s.slice(0, 15);

  client.pers.squad = "Uncommitted";
  client.pers.squadStatus = "Unknown";

  s = Info_ValueForKey(userinfo, "spectator");
  client.pers.spectator = cvarNum(gameCvars.deathmatch) !== 0 && s.length > 0 && s !== "0";

  const skin = Info_ValueForKey(userinfo, "skin");
  const playernum = EDICT_NUM(ent) - 1;
  gi.configstring(CS_PLAYERSKINS + playernum, `${client.pers.netname}\\${skin}`);
  gi.configstring(CS_GENERAL + playernum, client.pers.netname);

  if (cvarNum(gameCvars.deathmatch) !== 0 && ((cvarNum(gameCvars.dmflags) | 0) & DF_FIXED_FOV) !== 0) {
    client.ps.fov = 90;
  } else {
    client.ps.fov = atoiC(Info_ValueForKey(userinfo, "fov"));
    if (client.ps.fov < 1) client.ps.fov = 90;
    else if (client.ps.fov > 160) client.ps.fov = 160;
  }

  s = Info_ValueForKey(userinfo, "hand");
  if (s.length > 0) client.pers.hand = atoiC(s);

  client.pers.userinfo = userinfo.slice(0, MAX_INFO_STRING - 1);
}

/*
ClientConnect (lmctf60/p_client.c:2380) -- the spectator-password/count
gate and the stats-player dropped-record restore (p_stats_player, unit B's
SCOPE) are not reproduced; core admission gates (IP ban, password, name
required) are.
*/
export function ClientConnect(entIn: Edict, userinfoIn: string): { allowed: boolean; userinfo: string } {
  const ent = edictFromBoundary(entIn);
  let userinfo = userinfoIn;

  let value = Info_ValueForKey(userinfo, "ip");
  if (SV_FilterPacket(value)) {
    userinfo = Info_SetValueForKey(userinfo, "rejmsg", "Banned.");
    return { allowed: false, userinfo };
  }

  value = Info_ValueForKey(userinfo, "spectator");
  const isSpectatorRequest = cvarNum(gameCvars.deathmatch) !== 0 && value.length > 0 && value !== "0";
  if (!isSpectatorRequest) {
    value = Info_ValueForKey(userinfo, "password");
    const pass = cvarStr(gameCvars.password);
    if (pass.length > 0 && pass !== "none" && pass !== value) {
      userinfo = Info_SetValueForKey(userinfo, "rejmsg", "Password required or incorrect.");
      return { allowed: false, userinfo };
    }
  }

  value = Info_ValueForKey(userinfo, "name");
  if (value === "") {
    userinfo = Info_SetValueForKey(userinfo, "rejmsg", "You must have a name.");
    return { allowed: false, userinfo };
  }

  const client = game.clients[EDICT_NUM(ent) - 1];
  ent.client = client;
  client.p_stats_player = null;

  if (ent.inuse === false) {
    InitClientResp(client);
    if (!game.autosaved || client.pers.weapon === null) InitClientPersistent(client);
  }

  ClientUserinfoChanged(ent, userinfo);

  // lmctf60/p_client.c:2471-2473 -- CTF_SPAM_BAND_MAX/CTF_SPAM_FREQ_MIN
  // (g_ctffunc.h) are 450/0; this line previously had the wrong literal
  // (24) for CTF_SPAM_BAND_MAX -- fixed now that ctf_SpamCheck (g_ctffunc.ts,
  // gates PlayTeamSound/PlayVoiceSound, g_cmds.ts) is a real dependent.
  client.spam_band_count = 450; // CTF_SPAM_BAND_MAX
  client.spam_freq_count = 0; // CTF_SPAM_FREQ_MIN
  client.spam_freq_time = level.time;

  if (game.maxclients > 1) gi.dprintf(`${client.pers.netname} connected\n`);

  ent.svflags = 0;
  client.pers.connected = true;
  return { allowed: true, userinfo };
}

/*
ClientDisconnect (lmctf60/p_client.c:2510) -- Drop_Rune/ClientHasFlag/
ctf_playerdropflag are not called (unit B's g_runes.ts and g_ctffunc.ts's
documented-unported flag chain, respectively); the hook cleanup (real,
self-contained) IS ported.
*/
export function ClientDisconnect(entIn: Edict): void {
  const ent = edictFromBoundary(entIn);
  if (ent.client === null) return;

  if (ent.client.hook !== null) {
    G_FreeEdict(ent.client.hook);
    ent.client.hook = null;
  }

  ent.client.ctf.extra_flags &= ~2; // CTF_EXTRAFLAGS_REFEREE
  ent.client.ctf.extra_flags &= ~4; // CTF_EXTRAFLAGS_RCON

  ctf_BSafePrint(PRINT_HIGH, `${ent.client.pers.netname} disconnected\n`);

  gi.WriteByte(svc_muzzleflash);
  gi.WriteShort(EDICT_NUM(ent));
  gi.WriteByte(MZ_LOGOUT);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  gi.unlinkentity(ent);
  ent.s.modelindex = 0;
  ent.solid = SolidT.SOLID_NOT;
  ent.inuse = false;
  ent.classname = "disconnected";
  ent.client.p_stats_player = null;
  ent.client.pers.connected = false;

  const playernum = EDICT_NUM(ent) - 1;
  gi.configstring(CS_PLAYERSKINS + playernum, "");
}

/*
=================
ClientHasFlag (lmctf60/p_client.c:106) -- byte-identical to the C source.
Needed by g_cmds.ts's Drop_All (drops the enemy flag on death/observer
transition if the client is currently carrying one).
=================
*/
export function ClientHasFlag(ent: EdictT): EdictT | null {
  if (ent.client === null) return null;
  const teamnum = ent.client.ctf.teamnum;

  // Were we carrying a flag?
  const flag = ctf_getteamflag(teamnum, CTF_TEAM_OPPOSING);

  if (flag !== null && flag.item !== null) {
    if (ent.client.pers.inventory[ITEM_INDEX(flag.item)]) return flag;
    return null;
  }
  return null;
}

//==============================================================
// Team assignment: Num_Of_Players / Team_To_Join / TeamJoin
// (lmctf60/p_client.c:3310/3340/3376)
//==============================================================

/*
Num_Of_Players (lmctf60/p_client.c:3310) -- byte-identical to the C
source. This is what g_chase.ts's Team_Observer_OK was missing (that
file's own report traced it here and documented the citation -- this
export resolves it).
*/
export function Num_Of_Players(ent: EdictT, ctfTeam: number): number {
  let red = 0;
  let blue = 0;
  let player = ctf_findplayer(null, ent, CTF_TEAM_ANYTEAM);
  while (player !== null) {
    if (player.client !== null) {
      if (player.client.ctf.teamnum === CTF_TEAM_RED) red++;
      else if (player.client.ctf.teamnum === CTF_TEAM_BLUE) blue++;
    }
    player = ctf_findplayer(player, ent, CTF_TEAM_ANYTEAM);
  }

  if (ctfTeam === CTF_TEAM_BLUE) return blue;
  if (ctfTeam === CTF_TEAM_RED) return red;
  return 0;
}

/*
Team_To_Join (lmctf60/p_client.c:3340) -- byte-identical to the C source.
NOTE: `redscore`/`bluescore` (lmctf60/g_local.h externs, maintained by
unit B's g_tourney.c/g_replace.c-adjacent scoring code) have no port
anywhere in this family; both read as 0 here (module-local, never
written), so the "teams even" tie-break always resolves to CTF_TEAM_RED
(0 > 0 is false) instead of consulting real team scores. Documented
deviation -- team BALANCE (red vs blue player count) is still fully
correct, only the score-based tie-break for perfectly even teams differs.
*/
let redscore = 0;
let bluescore = 0;
export function Team_To_Join(ent: EdictT): number {
  let red = 0;
  let blue = 0;
  let player = ctf_findplayer(null, ent, CTF_TEAM_ANYTEAM);
  while (player !== null) {
    if (player.client !== null) {
      if (player.client.ctf.teamnum === CTF_TEAM_RED) red++;
      else if (player.client.ctf.teamnum === CTF_TEAM_BLUE) blue++;
    }
    player = ctf_findplayer(player, ent, CTF_TEAM_ANYTEAM);
  }

  if (red === blue) {
    return redscore > bluescore ? CTF_TEAM_BLUE : CTF_TEAM_RED;
  }
  return red > blue ? CTF_TEAM_BLUE : CTF_TEAM_RED;
}

/*
TeamJoin (lmctf60/p_client.c:3376) -- ClientSetSkin's skin refresh
(unit B's g_skins.c) is not called; ForceCommand("spectator 0") IS called
(g_cmds.ts, already ported by the foundation).
*/
import { Cmd_Observe_f, Drop_All, ForceCommand } from "./g_cmds";
export function TeamJoin(ent: EdictT): void {
  if (ent.client === null) return;
  const oldTeam = ent.client.ctf.teamnum;
  const newTeam = Team_To_Join(ent);

  if (oldTeam > CTF_TEAM_UNDEFINED) {
    ctf_SetEntTeamEx(ent, oldTeam, 0);
  } else if (oldTeam <= CTF_TEAM_OBSERVER) {
    ent.client.ctf.New_Team = newTeam;
    ForceCommand(ent, "spectator 0");
  } else {
    ctf_SetEntTeamEx(ent, newTeam, 0);
  }
}

//==============================================================
// ClientSetSkin / ClientOldSetSkin (lmctf60/p_client.c:3145/3181)
//==============================================================

function cvarNumSkin(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

/*
=================
ClientOldSetSkin (lmctf60/p_client.c:3181)

The legacy (pre-SkinListInUse) skin resolver: picks a team-colored
male/female skin variant, preferring to preserve the caller's existing
gender/number choice when their current skin string already parses as a
valid "<dir>/<set>-<color><gender><num>" name. `sscanf(s, "%d", &skinnum)`
(does `s` start with a parseable integer at all?) is reproduced as
Number.parseInt(s, 10) not being NaN; the finer-grained
"%[^/]/%[^-]-%c%c%d" parse is reproduced with a regex capturing the same
five fields.
=================
*/
export function ClientOldSetSkin(ent: EdictT, _input: string): void {
  if (ent.client === null) return;

  let curset: string;
  switch (Math.floor(cvarNumSkin(gameCvars.skinset))) {
    case 1:
      curset = "lm";
      break;
    case 2:
      curset = "cr";
      break;
    case 3:
      curset = "w";
      break;
    default:
      curset = "rb";
      break;
  }

  // get skin
  const s = Info_ValueForKey(ent.client.pers.userinfo, "skin");

  let num = -1;
  let gender = "u"; // unassigned
  let color = "u"; // unassigned
  let skinvalid = false;
  let dirvalid = 0;
  let matchedDir = "";
  let matchedSet = "";
  const skinnumParsed = Number.parseInt(s, 10);
  const skinnum = Number.isNaN(skinnumParsed) ? 0 : skinnumParsed;

  // See if we have only specified a skin number (C: `sscanf(s, "%d", &skinnum)`
  // -- true whenever `s` starts with a parseable integer, matched here by
  // `s` beginning with an optional sign then a digit)
  if (/^[+-]?\d/.test(s)) {
    // First, check if skin matches proper format "<dir>/<set>-<color><gender><num>"
    const m = /^([^/]+)\/([^-]+)-(.)(.)(\d+)/.exec(s);
    if (m !== null) {
      const dir = m[1] ?? "";
      matchedDir = dir;
      matchedSet = m[2] ?? "";
      const parsedGender = m[4] ?? "";
      const parsedNum = Number.parseInt(m[5] ?? "0", 10);

      if (dir === "female") {
        dirvalid = 2;
        if (parsedGender === "f" && parsedNum <= 2 && parsedNum >= 1) {
          skinvalid = true;
          gender = parsedGender;
          num = parsedNum;
          color = m[3] ?? "u";
        }
      } else if (dir === "male") {
        dirvalid = 1;
        if (parsedGender === "m" && parsedNum <= 3 && parsedNum >= 1) {
          skinvalid = true;
          gender = parsedGender;
          num = parsedNum;
          color = m[3] ?? "u";
        }
      }
    }
  }

  let finalSkin: string | null = null;

  // If our skin is valid, only change if our color doesn't match
  if (skinvalid) {
    if (
      (ent.client.ctf.teamnum === CTF_TEAM_RED && color !== "r") ||
      (ent.client.ctf.teamnum === CTF_TEAM_BLUE && color !== "b") ||
      matchedSet !== curset
    ) {
      color = ent.client.ctf.teamnum === CTF_TEAM_RED ? "r" : "b";
      finalSkin = `${matchedDir}/${curset}-${color}${gender}${num}`;
    }
  } else {
    // Did we have a valid gender?
    let dir: string;
    if (dirvalid === 0 || dirvalid === 1) {
      dir = "male";
      gender = "m";
      color = ent.client.ctf.teamnum === CTF_TEAM_RED ? "r" : "b";
      num = skinnum % 4 === 0 ? Math.floor(Math.random() * 3) + 1 : skinnum % 4;
    } else {
      // female
      dir = "female";
      gender = "f";
      color = ent.client.ctf.teamnum === CTF_TEAM_RED ? "r" : "b";
      num = skinnum % 3 === 0 ? Math.floor(Math.random() * 2) + 1 : skinnum % 3;
    }
    finalSkin = `${dir}/${curset}-${color}${gender}${num}`;
  }

  const playernum = EDICT_NUM(ent) - 1;
  const displaySkin = finalSkin ?? s;

  // combine name and skin into a configstring
  gi.configstring(CS_PLAYERSKINS + playernum, `${ent.client.pers.netname}\\${displaySkin}`);

  if (finalSkin !== null) {
    ent.client.pers.userinfo = Info_SetValueForKey(ent.client.pers.userinfo, "skin", finalSkin);
    ent.client.ctf.goodskin = false; // We need to re-force our skin
  }
}

/*
=================
ClientSetSkin (lmctf60/p_client.c:3145) -- byte-identical to the C source.
Wires to g_skins.ts's real SkinListInUse/SkinValid/SkinRandom (the "new"
skin-list system); falls back to ClientOldSetSkin above when no skin list
is loaded, exactly like the C source.
=================
*/
export function ClientSetSkin(ent: EdictT, skin: string): void {
  if (ent.client === null) return;

  if (!SkinListInUse()) {
    ClientOldSetSkin(ent, skin);
    return;
  }

  // get skin
  const s = Info_ValueForKey(ent.client.pers.userinfo, "skin");

  let newskin: string;
  if (!SkinValid(ent, skin)) {
    newskin = SkinValid(ent, s) ? s : SkinRandom(ent);
  } else {
    newskin = skin;
  }

  const playernum = EDICT_NUM(ent) - 1;

  // combine name and skin into a configstring
  gi.configstring(CS_PLAYERSKINS + playernum, `${ent.client.pers.netname}\\${newskin}`);

  ent.client.pers.userinfo = Info_SetValueForKey(ent.client.pers.userinfo, "skin", newskin);
  ent.client.ctf.goodskin = false; // We need to re-force our skin
}

//==============================================================
// ClientThink / ClientBeginServerFrame
//==============================================================

let pm_passent: EdictT | null = null;

function PM_trace(start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3): GTraceT {
  if (pm_passent !== null && pm_passent.health > 0) {
    return gi.trace(start, mins, maxs, end, pm_passent, MASK_PLAYERSOLID);
  }
  return gi.trace(start, mins, maxs, end, pm_passent, MASK_DEADSOLID);
}

/*
ClientThink -- see file header for the dropped weapon-fire dispatch
(Think_Weapon/PlayerNoise, p_weapon.c, not ported beyond the hook chain),
hook-pull (handled per-frame by p_view.ts's ClientEndServerFrame instead,
not inline here like ctf's ctf_grapple), rune-regen tick (unit B), and
popup-menu update (unit B) -- the core pmove simulation, ground/touch
handling, and chase-cam update are fully ported.
*/
export function ClientThink(entIn: Edict, ucmd: UsercmdT): void {
  const ent = edictFromBoundary(entIn);
  if (ent.client === null) return;
  const client = ent.client;

  level.current_entity = ent;

  if (level.intermissiontime !== 0) {
    client.ps.pmove.pm_type = PmTypeT.PM_FREEZE;
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

  const pm = new PmoveT();

  if (ent.movetype === MovetypeT.MOVETYPE_NOCLIP) client.ps.pmove.pm_type = PmTypeT.PM_SPECTATOR;
  else if (ent.s.modelindex !== 255) client.ps.pmove.pm_type = PmTypeT.PM_GIB;
  else if (ent.deadflag !== DEAD_NO) client.ps.pmove.pm_type = PmTypeT.PM_DEAD;
  else client.ps.pmove.pm_type = PmTypeT.PM_NORMAL;

  client.ps.pmove.gravity = cvarNum(gameCvars.sv_gravity);
  pm.s = clonePmoveState(client.ps.pmove);

  for (let i = 0; i < 3; i++) {
    pm.s.origin[i] = ent.s.origin[i] * 8;
    pm.s.velocity[i] = ent.velocity[i] * 8;
  }

  if (!pmoveStateEqual(client.old_pmove, pm.s)) pm.snapinitial = true;

  pm.cmd = ucmd;
  pm.trace = PM_trace;
  pm.pointcontents = gi.pointcontents;

  gi.Pmove(pm);

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
    // PlayerNoise(ent, ent.s.origin, PNOISE_SELF) -- not ported, see file header.
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

  gi.linkentity(ent);

  if (ent.movetype !== MovetypeT.MOVETYPE_NOCLIP) G_TouchTriggers(ent);

  for (let i = 0; i < pm.numtouch; i++) {
    const otherRaw = pm.touchents[i];
    let j = 0;
    for (; j < i; j++) {
      if (pm.touchents[j] === otherRaw) break;
    }
    if (j !== i) continue;
    const other = recoverEdict(otherRaw);
    if (other === null) continue;
    if (other.touch === null) continue;
    other.touch(other, ent, null, null);
  }

  client.oldbuttons = client.buttons;
  client.buttons = ucmd.buttons;
  client.latched_buttons |= client.buttons & ~client.oldbuttons;

  ent.light_level = ucmd.lightlevel;

  // fire weapon from final position if needed (lmctf60/p_client.c:2852).
  // This is the block that actually advances the weapon state machine on the
  // server frame -- without it a held/tapped attack button never reaches
  // Think_Weapon and no weapon ever fires.
  if (!GamePaused()) {
    if ((client.latched_buttons & BUTTON_ATTACK) !== 0) {
      if (client.resp.spectator) {
        client.latched_buttons = 0;
        if (client.chase_target !== null) {
          client.chase_target = null;
          client.ps.pmove.pm_flags &= ~PMF_NO_PREDICTION;
        } else {
          GetChaseTarget(ent);
        }
      } else if (!client.weapon_thunk) {
        client.weapon_thunk = true;
        Think_Weapon(ent);
      }
    }
  }

  if (client.resp.spectator) {
    // lmctf60/p_client.c:2883 -- a team observer whose team is no longer a
    // legal thing to observe gets dropped back to the neutral observer team.
    if (client.ctf.teamnum === CTF_TEAM_OBSERVER_RED && !Team_Observer_OK(CTF_TEAM_RED, ent)) {
      Cmd_Observe_f(ent, CTF_TEAM_OBSERVER);
      return;
    } else if (client.ctf.teamnum === CTF_TEAM_OBSERVER_BLUE && !Team_Observer_OK(CTF_TEAM_BLUE, ent)) {
      Cmd_Observe_f(ent, CTF_TEAM_OBSERVER);
      return;
    }

    // When we first start, we are observing nobody.
    // (`chaseTarget` is re-read into a local because the fire-button block
    // above can null the field out, which narrows the property type; the
    // field is still reassigned by GetChaseTarget through `client`.)
    if (client.ctf.teamnum === CTF_TEAM_OBSERVER_RED || client.ctf.teamnum === CTF_TEAM_OBSERVER_BLUE) {
      const wantTeam = client.ctf.teamnum === CTF_TEAM_OBSERVER_RED ? CTF_TEAM_RED : CTF_TEAM_BLUE;
      const chaseTarget = currentChaseTarget(client);
      if (chaseTarget === null) {
        GetChaseTarget(ent);
        return;
      } else if (chaseTarget.client === null || chaseTarget.client.ctf.teamnum !== wantTeam) {
        Cmd_Observe_f(ent, CTF_TEAM_OBSERVER);
        return;
      }
    }

    if (ucmd.upmove >= 10) {
      if ((client.ps.pmove.pm_flags & PMF_JUMP_HELD) === 0) {
        client.ps.pmove.pm_flags |= PMF_JUMP_HELD;
        const chaseTarget = currentChaseTarget(client);
        if (chaseTarget !== null) ChaseNext(ent);
        else GetChaseTarget(ent);
      }
    } else {
      client.ps.pmove.pm_flags &= ~PMF_JUMP_HELD;
    }
  } else {
    // CTF CODE -- LM_JORM (lmctf60/p_client.c:2951): drag the carried flag
    // along with its carrier, offset 6 units behind the player's facing.
    // Without this the flag model stays parked at its home position while
    // someone is carrying it.
    const flag = ClientHasFlag(ent);
    if (flag !== null) {
      const offset = vec3();
      VectorCopy(ent.s.origin, flag.s.origin);
      VectorNormalize2(ent.s.angles, offset);
      VectorScale(offset, 6, offset);
      VectorSubtract(flag.s.origin, offset, flag.s.origin);
      VectorCopy(ent.velocity, flag.velocity);
      VectorCopy(offset, flag.movedir);
      vectoangles(offset, flag.s.angles);
    }
  }

  // update chase cam if being followed
  const maxclients = cvarNum(gameCvars.maxclients);
  for (let i = 1; i <= maxclients; i++) {
    const other = g_edicts[i];
    if (other !== undefined && other.inuse && other.client !== null && other.client.chase_target === ent) {
      UpdateChaseCam(other);
    }
  }
}


/*
spectator_respawn (lmctf60/p_client.c:1667)

Runs when pers.spectator and resp.spectator disagree -- i.e. the player used
the "spectator" command. Checks the relevant password, enforces
maxspectators, then re-runs PutClientInServer on the new side.
*/
export function spectator_respawn(ent: EdictT): void {
  if (ent.client === null) return;
  const client = ent.client;

  // if the user wants to become a spectator, make sure he doesn't exceed
  // max_spectators
  if (client.pers.spectator) {
    const value = Info_ValueForKey(client.pers.userinfo, "spectator");
    const sp = cvarStr(gameCvars.spectator_password);
    if (sp !== "" && sp !== "none" && sp !== value) {
      gi.cprintf(ent, PRINT_HIGH, "Spectator password incorrect.\n");
      client.pers.spectator = false;
      gi.WriteByte(svc_stufftext);
      gi.WriteString("spectator 0\n");
      gi.unicast(ent, true);
      return;
    }

    // count spectators
    let numspec = 0;
    const maxclients = cvarNum(gameCvars.maxclients);
    for (let i = 1; i <= maxclients; i++) {
      const other = g_edicts[i];
      if (other !== undefined && other.inuse && other.client !== null && other.client.pers.spectator) numspec++;
    }

    if (numspec >= cvarNum(gameCvars.maxspectators)) {
      // QUIRK preserved: the C omits the trailing newline on this one message.
      gi.cprintf(ent, PRINT_HIGH, "Server spectator limit is full.");
      client.pers.spectator = false;
      gi.WriteByte(svc_stufftext);
      gi.WriteString("spectator 0\n");
      gi.unicast(ent, true);
      return;
    }
  } else {
    // he was a spectator and wants to join the game -- he must have the
    // right password
    const value = Info_ValueForKey(client.pers.userinfo, "password");
    const pw = cvarStr(gameCvars.password);
    if (pw !== "" && pw !== "none" && pw !== value) {
      gi.cprintf(ent, PRINT_HIGH, "Password incorrect.\n");
      client.pers.spectator = true;
      gi.WriteByte(svc_stufftext);
      gi.WriteString("spectator 1\n");
      gi.unicast(ent, true);
      return;
    }
  }

  // clear client on respawn
  client.resp.score = 0;
  client.pers.score = 0;

  ent.svflags &= ~SVF_NOCLIENT;

  PutClientInServer(ent);

  // add a teleportation effect
  if (!client.pers.spectator) {
    gi.WriteByte(svc_muzzleflash);
    gi.WriteShort(EDICT_NUM(ent));
    gi.WriteByte(MZ_LOGIN);
    gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

    // hold in place briefly
    client.ps.pmove.pm_flags = PMF_TIME_TELEPORT;
    client.ps.pmove.pm_time = 14;
  }

  client.respawn_time = level.time;

  if (client.pers.spectator) {
    Drop_All(ent);
    if (client.ctf.teamnum === CTF_TEAM_OBSERVER_RED) {
      gi.bprintf(PRINT_HIGH, `${client.pers.netname} is observing the red team\n`);
    } else if (client.ctf.teamnum === CTF_TEAM_OBSERVER_BLUE) {
      gi.bprintf(PRINT_HIGH, `${client.pers.netname} is observing the blue team\n`);
    } else {
      gi.bprintf(PRINT_HIGH, `${client.pers.netname} has moved to the sidelines\n`);
      client.ctf.teamnum = CTF_TEAM_OBSERVER;
    }
  } else {
    // only do this if they actually typed the spectator command
    if (client.ctf.teamnum !== CTF_TEAM_RED && client.ctf.teamnum !== CTF_TEAM_BLUE) {
      client.ctf.New_Team = Team_To_Join(ent);
    }
    gi.bprintf(PRINT_HIGH, `${client.pers.netname} joined the game\n`);
  }
}

/*
PingAlert (lmctf60/p_client.c:2997)

Referee-only: warn the referee about any in-game player whose ping falls
outside his configured pingalert floor/ceiling.
*/
export function PingAlert(ent: EdictT): void {
  if (ent.client === null) return;
  const client = ent.client;

  // Check if they are turned off
  if (client.ctf.pingalertfloor === 0 && client.ctf.pingalertceiling === 0) return;

  for (let j = 1; j <= game.maxclients; j++) {
    const other = g_edicts[j];
    if (other === undefined || !other.inuse) continue;
    if (other.client === null || other.client.ctf.teamnum <= CTF_TEAM_OBSERVER) continue;

    if (client.ctf.pingalertfloor !== 0 && other.client.ping < client.ctf.pingalertfloor) {
      ctf_SafePrint(
        ent,
        PRINT_HIGH,
        `PING ALERT: ${other.client.pers.netname} has a ${other.client.ping} ping (below ${client.ctf.pingalertfloor}).\n`,
      );
    }
    if (client.ctf.pingalertceiling !== 0 && other.client.ping > client.ctf.pingalertceiling) {
      ctf_SafePrint(
        ent,
        PRINT_HIGH,
        `PING ALERT: ${other.client.pers.netname} has a ${other.client.ping} ping (above ${client.ctf.pingalertceiling}).\n`,
      );
    }
  }
}

/*
TossClientWeapon (lmctf60/p_client.c:648)

Drops the dead player's current weapon (and, with DF_QUAD_DROP, a live quad)
so the killer can pick it up. Now portable: g_items.ts has a real Drop_Item.
*/
export function TossClientWeapon(self: EdictT): void {
  if (self.client === null) return;
  if (cvarNum(gameCvars.deathmatch) === 0) return;

  let item: GItemT | null = self.client.pers.weapon;
  if (item === null) return;

  if (self.client.pers.inventory[self.client.ammo_index] === 0) item = null;
  if (item !== null && item.pickup_name === "Blaster") item = null;
  // CTF CODE -- LM_JORM: never drop the hook
  if (item !== null && item.pickup_name === "Grappling Hook") item = null;

  let quad: boolean;
  if ((cvarNum(gameCvars.dmflags) & DF_QUAD_DROP) === 0) quad = false;
  else quad = self.client.quad_framenum > level.framenum + 10;

  const spread = item !== null && quad ? 22.5 : 0.0;

  if (item !== null) {
    self.client.v_angle[YAW] -= spread;
    const drop = Drop_Item(self, item);
    self.client.v_angle[YAW] += spread;
    drop.spawnflags = DROPPED_PLAYER_ITEM;
  }

  if (quad) {
    self.client.v_angle[YAW] += spread;
    const quadItem = FindItemByClassname("item_quad");
    if (quadItem === null) return;
    const drop = Drop_Item(self, quadItem);
    self.client.v_angle[YAW] -= spread;
    drop.spawnflags |= DROPPED_PLAYER_ITEM;
    drop.touch = Touch_Item;
    drop.nextthink = level.time + (self.client.quad_framenum - level.framenum) * FRAMETIME;
    drop.think = G_FreeEdict;
  }
}

/*
ClientBeginServerFrame (lmctf60/p_client.c:3047)

Called once per server frame per client, before any other entity runs. This
is where the per-frame rune tick, the vote timeout check, the spectator
toggle, the referee ping alerts and -- critically -- the fallback
Think_Weapon call all live.
*/
export function ClientBeginServerFrame(ent: EdictT): void {
  if (ent.client === null) return;

  // CTF CODE -- LM_JORM: these two run even during intermission.
  RuneThinkHook(ent);
  if (VoteStarted) Check_Vote();

  if (level.intermissiontime !== 0) return;

  const client = ent.client;

  if (
    cvarNum(gameCvars.deathmatch) !== 0 &&
    client.pers.spectator !== client.resp.spectator &&
    level.time - client.respawn_time >= 5
  ) {
    spectator_respawn(ent);
    return;
  }

  // STATS-BEGIN LM_Hati
  if (level.framenum % STATS_PLAYER_SAMPLE_RATE === 0) {
    if (client.p_stats_player !== null) {
      stats_add(ent, STATS_PING_TOTAL, client.ping);
      stats_add(ent, STATS_PING_SAMPLES, 1);
    }
    // Alert referee if others have failed his pingalerts.
    // Only referees can have ping alerts.
    if (isRef(ent)) PingAlert(ent);
  }
  // STATS-END LM_Hati

  // run weapon animations if it hasn't been done by a ucmd_t
  if (!client.weapon_thunk && !client.resp.spectator) Think_Weapon(ent);
  else client.weapon_thunk = false;

  if (ent.deadflag !== DEAD_NO) {
    // wait for any button just going down
    if (level.time > client.respawn_time) {
      // in deathmatch, only wait for attack button
      const buttonMask = cvarNum(gameCvars.deathmatch) !== 0 ? BUTTON_ATTACK : -1;
      if (
        (client.latched_buttons & buttonMask) !== 0 ||
        (cvarNum(gameCvars.deathmatch) !== 0 && ((cvarNum(gameCvars.dmflags) | 0) & DF_FORCE_RESPAWN) !== 0)
      ) {
        respawn(ent);
        client.latched_buttons = 0;
      }
    }
    return;
  }

  // PlayerTrail_Add/visible -- not ported (MONSTERS_OK dead subsystem: the
  // trail exists only so monsters can follow a player's scent).

  client.latched_buttons = 0;

  // lmctf60/p_client.c:3133 -- re-assert the player's skin once after every
  // userinfo change; ClientUserinfoChanged/ClientSetSkin clear goodskin and
  // this is the only place that pushes the skin back to the client.
  if (!client.ctf.goodskin) {
    const skin = Info_ValueForKey(client.pers.userinfo, "skin");
    try {
      ForceCommand(ent, `skin ${skin}\n`);
    } finally {
      // Latch in a `finally` so the stuff is attempted exactly once, in the
      // C's order (stuff, then latch). The C's ForceCommand cannot fail, but
      // this port's gi.unicast can throw when a client's reliable buffer is
      // full; without the latch that one failure would retry on every
      // subsequent server frame instead of the C's single attempt.
      client.ctf.goodskin = true;
    }
  }
}
