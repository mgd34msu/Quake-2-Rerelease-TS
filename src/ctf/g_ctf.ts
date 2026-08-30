// g_ctf.c / g_ctf.h -- ThreeWave Capture the Flag core: team/flag logic,
// tech powerups, the grapple hook, team chat, match/election flow, and the
// pmenu-driven join/admin menus.
//
// Everything here imports from ./g_local (the ctf copy of g_local.ts) and
// sibling ctf/* modules, never from ../game, per this unit's SCOPE.

import { random, vec3, vec3_origin, VectorAdd, VectorClear, VectorCopy, VectorLength, VectorMA, VectorNormalize, VectorScale, VectorSet, VectorSubtract, AngleVectors, DotProduct, type Vec3 } from "../shared/math";
import { fixedLength } from "../shared/fixed";
import {
  ANGLE2SHORT,
  ATTN_NONE,
  ATTN_NORM,
  BUTTON_ATTACK,
  CHAN_AUTO,
  CHAN_NO_PHS_ADD,
  CHAN_RELIABLE,
  CHAN_VOICE,
  CHAN_WEAPON,
  Com_sprintf,
  CS_AIRACCEL,
  CS_GENERAL,
  CS_PLAYERSKINS,
  type CplaneT,
  type CsurfaceT,
  type CvarT,
  CVAR_SERVERINFO,
  DF_INSTANT_ITEMS,
  DF_QUAD_DROP,
  DF_SPAWN_FARTHEST,
  DF_WEAPONS_STAY,
  EF_FLAG1,
  EF_FLAG2,
  EF_PENT,
  EF_QUAD,
  EntityEventT,
  Info_ValueForKey,
  MASK_SHOT,
  MASK_SOLID,
  MAX_CLIENTS,
  MulticastT,
  PITCH,
  PMF_NO_PREDICTION,
  PMF_TIME_TELEPORT,
  PmTypeT,
  PRINT_CHAT,
  PRINT_HIGH,
  PRINT_MEDIUM,
  Q_stricmp,
  RF_GLOW,
  ROLL,
  SURF_SKY,
  TempEventT,
  YAW,
} from "../shared/q_shared";
import { SolidT, SVF_NOCLIENT } from "./game";
import {
  ANIM_DEATH,
  DEAD_DEAD,
  DEAD_NO,
  DROPPED_ITEM,
  type EdictT,
  FL_GODMODE,
  FL_RESPAWN,
  FRAMETIME,
  g_edicts,
  game,
  gameCvars,
  type GClientT,
  gi,
  GhostT,
  type GItemT,
  globals,
  IT_TECH,
  level,
  MOD_GRAPPLE,
  MovetypeT,
  PNOISE_IMPACT,
  PNOISE_WEAPON,
  svc_layout,
  svc_temp_entity,
  WeaponstateT,
  world,
} from "./g_local";
import { ArmorIndex, Drop_Item, FindItem, FindItemByClassname, GetItemByIndex, ITEM_INDEX, PowerArmorType, Touch_Item, DoRespawn } from "./g_items";
import { CheckTeamDamage, T_Damage } from "./g_combat";
import { ClientUserinfoChanged, InitClientPersistant, PlayersRangeFromSpot, PutClientInServer, SelectFarthestDeathmatchSpawnPoint, SelectRandomDeathmatchSpawnPoint, player_die, respawn } from "./p_client";
import { DeathmatchScoreboard } from "./p_hud";
import { P_ProjectSource, PlayerNoise, Weapon_Generic } from "./p_weapon";
import { G_Find, G_FreeEdict, G_Spawn, KillBox, tv, vectoangles, vtos } from "./g_utils";
import { SV_AddGravity } from "./g_phys";
import { FRAME_death308 } from "./m_player_frames";
import { EndDMLevel } from "./g_main";
import { PMenu_Close, PMenu_Open, PMenu_Update, PMenu_UpdateEntry, PMENU_ALIGN_CENTER, PMENU_ALIGN_LEFT, PMENU_ALIGN_RIGHT, PmenuHndT, PmenuT, type SelectFuncT } from "./p_menu";
import { CheckFlood } from "./g_cmds";

//===========================================================================
// g_ctf.h
//===========================================================================

const CTF_VERSION = "1.52";
export const CTF_STRING_VERSION = CTF_VERSION;

export const STAT_CTF_TEAM1_PIC = 17;
export const STAT_CTF_TEAM1_CAPS = 18;
export const STAT_CTF_TEAM2_PIC = 19;
export const STAT_CTF_TEAM2_CAPS = 20;
export const STAT_CTF_FLAG_PIC = 21;
export const STAT_CTF_JOINED_TEAM1_PIC = 22;
export const STAT_CTF_JOINED_TEAM2_PIC = 23;
export const STAT_CTF_TEAM1_HEADER = 24;
export const STAT_CTF_TEAM2_HEADER = 25;
export const STAT_CTF_TECH = 26;
export const STAT_CTF_ID_VIEW = 27;
export const STAT_CTF_MATCH = 28;
export const STAT_CTF_ID_VIEW_COLOR = 29;
export const STAT_CTF_TEAMINFO = 30;

export const CONFIG_CTF_MATCH = CS_AIRACCEL - 1;
export const CONFIG_CTF_TEAMINFO = CS_AIRACCEL - 2;

export enum CtfTeamT {
  CTF_NOTEAM,
  CTF_TEAM1,
  CTF_TEAM2,
}

export enum CtfGrapplestateT {
  CTF_GRAPPLE_STATE_FLY,
  CTF_GRAPPLE_STATE_PULL,
  CTF_GRAPPLE_STATE_HANG,
}

export const CTF_TEAM1_SKIN = "ctf_r";
export const CTF_TEAM2_SKIN = "ctf_b";

export const DF_CTF_FORCEJOIN = 131072;
export const DF_ARMOR_PROTECT = 262144;
export const DF_CTF_NO_TECH = 524288;

export const CTF_CAPTURE_BONUS = 15;
export const CTF_TEAM_BONUS = 10;
export const CTF_RECOVERY_BONUS = 1;
export const CTF_FLAG_BONUS = 0;
export const CTF_FRAG_CARRIER_BONUS = 2;
export const CTF_FLAG_RETURN_TIME = 40;

export const CTF_CARRIER_DANGER_PROTECT_BONUS = 2;
export const CTF_CARRIER_PROTECT_BONUS = 1;
export const CTF_FLAG_DEFENSE_BONUS = 1;
export const CTF_RETURN_FLAG_ASSIST_BONUS = 1;
export const CTF_FRAG_CARRIER_ASSIST_BONUS = 2;

export const CTF_TARGET_PROTECT_RADIUS = 400;
export const CTF_ATTACKER_PROTECT_RADIUS = 400;

export const CTF_CARRIER_DANGER_PROTECT_TIMEOUT = 8;
export const CTF_FRAG_CARRIER_ASSIST_TIMEOUT = 10;
export const CTF_RETURN_FLAG_ASSIST_TIMEOUT = 10;

export const CTF_AUTO_FLAG_RETURN_TIMEOUT = 30;

export const CTF_TECH_TIMEOUT = 60;

export const CTF_GRAPPLE_SPEED = 650;
export const CTF_GRAPPLE_PULL_SPEED = 650;

// `ghost_t` (g_ctf.h's type) lives in g_local.ts as `GhostT` instead of
// here -- see g_local.ts's GhostT comment for why -- and is re-exported
// under its own name so callers can still `import { GhostT } from
// "./g_ctf"` as if this were g_ctf.h.
export type { GhostT } from "./g_local";

//===========================================================================
// ctfgame_t / cvars (g_ctf.c file-scope globals)
//===========================================================================

enum MatchT {
  MATCH_NONE,
  MATCH_SETUP,
  MATCH_PREGAME,
  MATCH_GAME,
  MATCH_POST,
}

enum ElectT {
  ELECT_NONE,
  ELECT_MATCH,
  ELECT_ADMIN,
  ELECT_MAP,
}

class CtfGameT {
  team1 = 0;
  team2 = 0;
  total1 = 0; // only set when going into intermission
  total2 = 0;
  last_flag_capture = 0;
  last_capture_team = 0;

  match: MatchT = MatchT.MATCH_NONE;
  matchtime = 0;
  lasttime = 0;
  countdown = false; // has audio countdown started?

  election: ElectT = ElectT.ELECT_NONE;
  etarget: EdictT | null = null;
  elevel = "";
  evotes = 0;
  needvotes = 0;
  electtime = 0;
  emsg = "";
  warnactive = 0; // true if stat string 30 is active

  ghosts: GhostT[] = Array.from({ length: MAX_CLIENTS }, () => new GhostT());

  clear(): void {
    Object.assign(this, new CtfGameT());
  }
}

const ctfgame = new CtfGameT();

let ctf: CvarT | null = null;
let ctf_forcejoin: CvarT | null = null;

let competition: CvarT | null = null;
let matchlock: CvarT | null = null;
let electpercentage: CvarT | null = null;
let matchtime: CvarT | null = null;
let matchsetuptime: CvarT | null = null;
let matchstarttime: CvarT | null = null;
let admin_password: CvarT | null = null;
let allow_admin: CvarT | null = null;
let warp_list: CvarT | null = null;
let warn_unbalanced: CvarT | null = null;

// Index for various CTF pics, this saves us from calling gi.imageindex
// all the time and saves a few CPU cycles since we don't have to do
// a bunch of string compares all the time.
// These are set in CTFPrecache() called from worldspawn
let imageindex_i_ctf1 = 0;
let imageindex_i_ctf2 = 0;
let imageindex_i_ctf1d = 0;
let imageindex_i_ctf2d = 0;
let imageindex_i_ctf1t = 0;
let imageindex_i_ctf2t = 0;
let imageindex_i_ctfj = 0;
let imageindex_sbfctf1 = 0;
let imageindex_sbfctf2 = 0;
let imageindex_ctfsb1 = 0;
let imageindex_ctfsb2 = 0;

function cvarNum(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}
function cvarStr(c: CvarT | null): string {
  return c === null ? "" : c.string;
}

export const ctf_statusbar =
  "yb\t-24 " +
  "xv\t0 " +
  "hnum " +
  "xv\t50 " +
  "pic 0 " +
  "if 2 " +
  "\txv\t100 " +
  "\tanum " +
  "\txv\t150 " +
  "\tpic 2 " +
  "endif " +
  "if 4 " +
  "\txv\t200 " +
  "\trnum " +
  "\txv\t250 " +
  "\tpic 4 " +
  "endif " +
  "if 6 " +
  "\txv\t296 " +
  "\tpic 6 " +
  "endif " +
  "yb\t-50 " +
  "if 7 " +
  "\txv\t0 " +
  "\tpic 7 " +
  "\txv\t26 " +
  "\tyb\t-42 " +
  "\tstat_string 8 " +
  "\tyb\t-50 " +
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
  "xr\t-50 " +
  "yt 2 " +
  "num 3 14 " +
  "yb -129 " +
  "if 26 " +
  "xr -26 " +
  "pic 26 " +
  "endif " +
  "yb -102 " +
  "if 17 " +
  "xr -26 " +
  "pic 17 " +
  "endif " +
  "xr -62 " +
  "num 2 18 " +
  "if 22 " +
  "yb -104 " +
  "xr -28 " +
  "pic 22 " +
  "endif " +
  "yb -75 " +
  "if 19 " +
  "xr -26 " +
  "pic 19 " +
  "endif " +
  "xr -62 " +
  "num 2 20 " +
  "if 23 " +
  "yb -77 " +
  "xr -28 " +
  "pic 23 " +
  "endif " +
  "if 21 " +
  "yt 26 " +
  "xr -24 " +
  "pic 21 " +
  "endif " +
  "if 27 " +
  "xv 112 " +
  "yb -58 " +
  "stat_string 27 " +
  "endif " +
  "if 29 " +
  "xv 96 " +
  "yb -58 " +
  "pic 29 " +
  "endif " +
  "if 28 " +
  "xl 0 " +
  "yb -78 " +
  "stat_string 28 " +
  "endif " +
  "if 30 " +
  "xl 0 " +
  "yb -88 " +
  "stat_string 30 " +
  "endif ";

const tnames = ["item_tech1", "item_tech2", "item_tech3", "item_tech4"];

export function stuffcmd(ent: EdictT, s: string): void {
  gi.WriteByte(11);
  gi.WriteString(s);
  gi.unicast(ent, true);
}

/*--------------------------------------------------------------------------*/

// Returns entities that have origins within a spherical area. Deliberately
// separate from g_utils.ts's findradius(): unlike that helper this one can
// return the world entity (index 0) when `from` is null, and never skips
// SOLID_NOT entities (the C source's `#if 0` guard for that is dead code).
function loc_findradius(from: EdictT | null, org: Vec3, rad: number): EdictT | null {
  const start = from === null ? 0 : from.s.number + 1;
  for (let i = start; i < globals.num_edicts; i++) {
    const ent = g_edicts[i];
    if (!ent.inuse) continue;
    const eorg = vec3();
    for (let j = 0; j < 3; j++) {
      eorg[j] = org[j] - (ent.s.origin[j] + (ent.mins[j] + ent.maxs[j]) * 0.5);
    }
    if (VectorLength(eorg) > rad) continue;
    return ent;
  }
  return null;
}

// Faithful port, including the C source's own bug: p[6]/p[7] are derived
// from p[0] (mins corner) rather than p[4] (maxs corner).
function loc_buildboxpoints(p: Vec3[], org: Vec3, mins: Vec3, maxs: Vec3): void {
  const p0 = p[0];
  const p1 = p[1];
  const p2 = p[2];
  const p3 = p[3];
  const p4 = p[4];
  const p5 = p[5];
  const p6 = p[6];
  const p7 = p[7];
  if (p0 === undefined || p1 === undefined || p2 === undefined || p3 === undefined || p4 === undefined || p5 === undefined || p6 === undefined || p7 === undefined) {
    return;
  }
  VectorAdd(org, mins, p0);
  VectorCopy(p0, p1);
  p1[0] -= mins[0];
  VectorCopy(p0, p2);
  p2[1] -= mins[1];
  VectorCopy(p0, p3);
  p3[0] -= mins[0];
  p3[1] -= mins[1];
  VectorAdd(org, maxs, p4);
  VectorCopy(p4, p5);
  p5[0] -= maxs[0];
  VectorCopy(p0, p6);
  p6[1] -= maxs[1];
  VectorCopy(p0, p7);
  p7[0] -= maxs[0];
  p7[1] -= maxs[1];
}

function loc_CanSee(targ: EdictT, inflictor: EdictT): boolean {
  if (targ.movetype === MovetypeT.MOVETYPE_PUSH) return false; // bmodels not supported

  const targpoints: Vec3[] = [vec3(), vec3(), vec3(), vec3(), vec3(), vec3(), vec3(), vec3()];
  loc_buildboxpoints(targpoints, targ.s.origin, targ.mins, targ.maxs);

  const viewpoint = vec3();
  VectorCopy(inflictor.s.origin, viewpoint);
  viewpoint[2] += inflictor.viewheight;

  for (let i = 0; i < 8; i++) {
    const point = targpoints[i];
    if (point === undefined) continue;
    const trace = gi.trace(viewpoint, vec3_origin, vec3_origin, point, inflictor, MASK_SOLID);
    if (trace.fraction === 1.0) return true;
  }

  return false;
}

/*--------------------------------------------------------------------------*/

let flag1_item: GItemT | null = null;
let flag2_item: GItemT | null = null;

export function CTFSpawn(): void {
  if (flag1_item === null) flag1_item = FindItemByClassname("item_flag_team1");
  if (flag2_item === null) flag2_item = FindItemByClassname("item_flag_team2");
  ctfgame.clear();
  CTFSetupTechSpawn();

  if (cvarNum(competition) > 1) {
    ctfgame.match = MatchT.MATCH_SETUP;
    ctfgame.matchtime = level.time + cvarNum(matchsetuptime) * 60;
  }
}

export function CTFInit(): void {
  ctf = gi.cvar("ctf", "1", CVAR_SERVERINFO);
  ctf_forcejoin = gi.cvar("ctf_forcejoin", "", 0);
  competition = gi.cvar("competition", "0", CVAR_SERVERINFO);
  matchlock = gi.cvar("matchlock", "1", CVAR_SERVERINFO);
  electpercentage = gi.cvar("electpercentage", "66", 0);
  matchtime = gi.cvar("matchtime", "20", CVAR_SERVERINFO);
  matchsetuptime = gi.cvar("matchsetuptime", "10", 0);
  matchstarttime = gi.cvar("matchstarttime", "20", 0);
  admin_password = gi.cvar("admin_password", "", 0);
  allow_admin = gi.cvar("allow_admin", "1", 0);
  warp_list = gi.cvar("warp_list", "q2ctf1 q2ctf2 q2ctf3 q2ctf4 q2ctf5", 0);
  warn_unbalanced = gi.cvar("warn_unbalanced", "1", 0);
  void ctf;
  void ctf_forcejoin;
}

/*
 * Precache CTF items
 */
export function CTFPrecache(): void {
  imageindex_i_ctf1 = gi.imageindex("i_ctf1");
  imageindex_i_ctf2 = gi.imageindex("i_ctf2");
  imageindex_i_ctf1d = gi.imageindex("i_ctf1d");
  imageindex_i_ctf2d = gi.imageindex("i_ctf2d");
  imageindex_i_ctf1t = gi.imageindex("i_ctf1t");
  imageindex_i_ctf2t = gi.imageindex("i_ctf2t");
  imageindex_i_ctfj = gi.imageindex("i_ctfj");
  imageindex_sbfctf1 = gi.imageindex("sbfctf1");
  imageindex_sbfctf2 = gi.imageindex("sbfctf2");
  imageindex_ctfsb1 = gi.imageindex("ctfsb1");
  imageindex_ctfsb2 = gi.imageindex("ctfsb2");
}

/*--------------------------------------------------------------------------*/

export function CTFTeamName(team: number): string {
  switch (team) {
    case CtfTeamT.CTF_TEAM1:
      return "RED";
    case CtfTeamT.CTF_TEAM2:
      return "BLUE";
    default:
      return "UNKNOWN"; // Hanzo pointed out this was spelled wrong as "UKNOWN"
  }
}

export function CTFOtherTeamName(team: number): string {
  switch (team) {
    case CtfTeamT.CTF_TEAM1:
      return "BLUE";
    case CtfTeamT.CTF_TEAM2:
      return "RED";
    default:
      return "UNKNOWN"; // Hanzo pointed out this was spelled wrong as "UKNOWN"
  }
}

export function CTFOtherTeam(team: number): number {
  switch (team) {
    case CtfTeamT.CTF_TEAM1:
      return CtfTeamT.CTF_TEAM2;
    case CtfTeamT.CTF_TEAM2:
      return CtfTeamT.CTF_TEAM1;
    default:
      return -1; // invalid value
  }
}

/*--------------------------------------------------------------------------*/

export function CTFAssignSkin(ent: EdictT, s: string): void {
  if (ent.client === null) return;
  const playernum = ent.s.number - 1;
  const slash = s.indexOf("/");
  const t = slash >= 0 ? s.slice(0, slash + 1) : "male/";

  switch (ent.client.resp.ctf_team) {
    case CtfTeamT.CTF_TEAM1:
      gi.configstring(CS_PLAYERSKINS + playernum, `${ent.client.pers.netname}\\${t}${CTF_TEAM1_SKIN}`);
      break;
    case CtfTeamT.CTF_TEAM2:
      gi.configstring(CS_PLAYERSKINS + playernum, `${ent.client.pers.netname}\\${t}${CTF_TEAM2_SKIN}`);
      break;
    default:
      gi.configstring(CS_PLAYERSKINS + playernum, `${ent.client.pers.netname}\\${s}`);
      break;
  }
}

export function CTFAssignTeam(who: GClientT): void {
  who.resp.ctf_state = 0;

  if ((cvarNum(gameCvars.dmflags) & DF_CTF_FORCEJOIN) === 0) {
    who.resp.ctf_team = CtfTeamT.CTF_NOTEAM;
    return;
  }

  let team1count = 0;
  let team2count = 0;
  const maxclients = cvarNum(gameCvars.maxclients);
  for (let i = 1; i <= maxclients; i++) {
    const player = g_edicts[i];
    if (!player.inuse || player.client === who || player.client === null) continue;

    if (player.client.resp.ctf_team === CtfTeamT.CTF_TEAM1) team1count++;
    else if (player.client.resp.ctf_team === CtfTeamT.CTF_TEAM2) team2count++;
  }
  if (team1count < team2count) who.resp.ctf_team = CtfTeamT.CTF_TEAM1;
  else if (team2count < team1count) who.resp.ctf_team = CtfTeamT.CTF_TEAM2;
  else who.resp.ctf_team = random() < 0.5 ? CtfTeamT.CTF_TEAM1 : CtfTeamT.CTF_TEAM2;
}

/*
================
SelectCTFSpawnPoint

go to a ctf point, but NOT the two points closest to other players
================
*/
export function SelectCTFSpawnPoint(ent: EdictT): EdictT | null {
  if (ent.client === null) return SelectRandomDeathmatchSpawnPoint();

  if (ent.client.resp.ctf_state !== 0) {
    if ((cvarNum(gameCvars.dmflags) & DF_SPAWN_FARTHEST) !== 0) return SelectFarthestDeathmatchSpawnPoint();
    return SelectRandomDeathmatchSpawnPoint();
  }

  ent.client.resp.ctf_state++;

  let cname: string;
  switch (ent.client.resp.ctf_team) {
    case CtfTeamT.CTF_TEAM1:
      cname = "info_player_team1";
      break;
    case CtfTeamT.CTF_TEAM2:
      cname = "info_player_team2";
      break;
    default:
      return SelectRandomDeathmatchSpawnPoint();
  }

  let count = 0;
  let range1 = 99999;
  let range2 = 99999;
  let spot1: EdictT | null = null;
  let spot2: EdictT | null = null;
  let spot: EdictT | null = null;

  for (;;) {
    spot = G_Find(spot, "classname", cname);
    if (spot === null) break;
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

  if (count === 0) return SelectRandomDeathmatchSpawnPoint();

  if (count <= 2) {
    spot1 = null;
    spot2 = null;
  } else {
    count -= 2;
  }

  let selection = Math.floor(random() * count);

  spot = null;
  do {
    spot = G_Find(spot, "classname", cname);
    if (spot === spot1 || spot === spot2) selection++;
  } while (selection-- > 0);

  return spot;
}

/*--------------------------------------------------------------------------*/
/*
CTFFragBonuses

Calculate the bonuses for flag defense, flag carrier defense, etc. Note
that bonuses are not cumulative. You get one, they are in importance order.
*/
export function CTFFragBonuses(targ: EdictT, _inflictor: EdictT, attacker: EdictT): void {
  if (targ.client !== null && attacker.client !== null) {
    if (attacker.client.resp.ghost !== null && attacker !== targ) attacker.client.resp.ghost.kills++;
    if (targ.client.resp.ghost !== null) targ.client.resp.ghost.deaths++;
  }

  // no bonus for fragging yourself
  if (targ.client === null || attacker.client === null || targ === attacker) return;

  const otherteam = CTFOtherTeam(targ.client.resp.ctf_team);
  if (otherteam < 0) return; // whoever died isn't on a team

  if (flag1_item === null || flag2_item === null) return;

  let flag_item: GItemT;
  let enemy_flag_item: GItemT;
  if (targ.client.resp.ctf_team === CtfTeamT.CTF_TEAM1) {
    flag_item = flag1_item;
    enemy_flag_item = flag2_item;
  } else {
    flag_item = flag2_item;
    enemy_flag_item = flag1_item;
  }

  const maxclients = cvarNum(gameCvars.maxclients);

  // did the attacker frag the flag carrier?
  if (targ.client.pers.inventory[ITEM_INDEX(enemy_flag_item)]) {
    attacker.client.resp.ctf_lastfraggedcarrier = level.time;
    attacker.client.resp.score += CTF_FRAG_CARRIER_BONUS;
    gi.cprintf(attacker, PRINT_MEDIUM, `BONUS: ${CTF_FRAG_CARRIER_BONUS} points for fragging enemy flag carrier.\n`);

    for (let i = 1; i <= maxclients; i++) {
      const ent = g_edicts[i];
      if (ent.inuse && ent.client !== null && ent.client.resp.ctf_team === otherteam) {
        ent.client.resp.ctf_lasthurtcarrier = 0;
      }
    }
    return;
  }

  if (
    targ.client.resp.ctf_lasthurtcarrier !== 0 &&
    level.time - targ.client.resp.ctf_lasthurtcarrier < CTF_CARRIER_DANGER_PROTECT_TIMEOUT &&
    !attacker.client.pers.inventory[ITEM_INDEX(flag_item)]
  ) {
    // attacker is on the same team as the flag carrier and fragged a guy
    // who hurt our flag carrier
    attacker.client.resp.score += CTF_CARRIER_DANGER_PROTECT_BONUS;
    gi.bprintf(
      PRINT_MEDIUM,
      `${attacker.client.pers.netname} defends ${CTFTeamName(attacker.client.resp.ctf_team)}'s flag carrier against an agressive enemy\n`,
    );
    if (attacker.client.resp.ghost !== null) attacker.client.resp.ghost.carrierdef++;
    return;
  }

  // flag and flag carrier area defense bonuses -- find the flag and carrier entities
  let c: string;
  switch (attacker.client.resp.ctf_team) {
    case CtfTeamT.CTF_TEAM1:
      c = "item_flag_team1";
      break;
    case CtfTeamT.CTF_TEAM2:
      c = "item_flag_team2";
      break;
    default:
      return;
  }

  let flag: EdictT | null = null;
  for (;;) {
    flag = G_Find(flag, "classname", c);
    if (flag === null) break;
    if ((flag.spawnflags & DROPPED_ITEM) === 0) break;
  }

  if (flag === null) return; // can't find attacker's flag

  let carrier: EdictT | null = null;
  for (let i = 1; i <= maxclients; i++) {
    const cand = g_edicts[i];
    if (cand.inuse && cand.client !== null && cand.client.pers.inventory[ITEM_INDEX(flag_item)]) {
      carrier = cand;
      break;
    }
  }

  const v1 = vec3();
  const v2 = vec3();
  VectorSubtract(targ.s.origin, flag.s.origin, v1);
  VectorSubtract(attacker.s.origin, flag.s.origin, v2);

  if (
    (VectorLength(v1) < CTF_TARGET_PROTECT_RADIUS ||
      VectorLength(v2) < CTF_TARGET_PROTECT_RADIUS ||
      loc_CanSee(flag, targ) ||
      loc_CanSee(flag, attacker)) &&
    attacker.client.resp.ctf_team !== targ.client.resp.ctf_team
  ) {
    attacker.client.resp.score += CTF_FLAG_DEFENSE_BONUS;
    if (flag.solid === SolidT.SOLID_NOT) {
      gi.bprintf(PRINT_MEDIUM, `${attacker.client.pers.netname} defends the ${CTFTeamName(attacker.client.resp.ctf_team)} base.\n`);
    } else {
      gi.bprintf(PRINT_MEDIUM, `${attacker.client.pers.netname} defends the ${CTFTeamName(attacker.client.resp.ctf_team)} flag.\n`);
    }
    if (attacker.client.resp.ghost !== null) attacker.client.resp.ghost.basedef++;
    return;
  }

  if (carrier !== null && carrier !== attacker) {
    // faithful to the C source: both VectorSubtracts below write into v1;
    // v2 is left holding its earlier flag-relative value on purpose (a bug
    // in the original ThreeWave code, not something this port corrects).
    VectorSubtract(targ.s.origin, carrier.s.origin, v1);
    VectorSubtract(attacker.s.origin, carrier.s.origin, v1);

    if (
      VectorLength(v1) < CTF_ATTACKER_PROTECT_RADIUS ||
      VectorLength(v2) < CTF_ATTACKER_PROTECT_RADIUS ||
      loc_CanSee(carrier, targ) ||
      loc_CanSee(carrier, attacker)
    ) {
      attacker.client.resp.score += CTF_CARRIER_PROTECT_BONUS;
      gi.bprintf(PRINT_MEDIUM, `${attacker.client.pers.netname} defends the ${CTFTeamName(attacker.client.resp.ctf_team)}'s flag carrier.\n`);
      if (attacker.client.resp.ghost !== null) attacker.client.resp.ghost.carrierdef++;
    }
  }
}

export function CTFCheckHurtCarrier(targ: EdictT, attacker: EdictT): void {
  if (targ.client === null || attacker.client === null) return;
  if (flag1_item === null || flag2_item === null) return;

  const flag_item = targ.client.resp.ctf_team === CtfTeamT.CTF_TEAM1 ? flag2_item : flag1_item;

  if (targ.client.pers.inventory[ITEM_INDEX(flag_item)] && targ.client.resp.ctf_team !== attacker.client.resp.ctf_team) {
    attacker.client.resp.ctf_lasthurtcarrier = level.time;
  }
}

/*--------------------------------------------------------------------------*/

export function CTFResetFlag(ctf_team: number): void {
  let c: string;
  switch (ctf_team) {
    case CtfTeamT.CTF_TEAM1:
      c = "item_flag_team1";
      break;
    case CtfTeamT.CTF_TEAM2:
      c = "item_flag_team2";
      break;
    default:
      return;
  }

  let ent: EdictT | null = null;
  for (;;) {
    ent = G_Find(ent, "classname", c);
    if (ent === null) break;
    if ((ent.spawnflags & DROPPED_ITEM) !== 0) {
      G_FreeEdict(ent);
    } else {
      ent.svflags &= ~SVF_NOCLIENT;
      ent.solid = SolidT.SOLID_TRIGGER;
      gi.linkentity(ent);
      ent.s.event = EntityEventT.EV_ITEM_RESPAWN;
    }
  }
}

export function CTFResetFlags(): void {
  CTFResetFlag(CtfTeamT.CTF_TEAM1);
  CTFResetFlag(CtfTeamT.CTF_TEAM2);
}

export function CTFPickup_Flag(ent: EdictT, other: EdictT): boolean {
  if (other.client === null) return false;
  if (flag1_item === null || flag2_item === null) return false;

  let ctf_team: number;
  if (ent.classname === "item_flag_team1") ctf_team = CtfTeamT.CTF_TEAM1;
  else if (ent.classname === "item_flag_team2") ctf_team = CtfTeamT.CTF_TEAM2;
  else {
    gi.cprintf(ent, PRINT_HIGH, "Don't know what team the flag is on.\n");
    return false;
  }

  let flag_item: GItemT;
  let enemy_flag_item: GItemT;
  if (ctf_team === CtfTeamT.CTF_TEAM1) {
    flag_item = flag1_item;
    enemy_flag_item = flag2_item;
  } else {
    flag_item = flag2_item;
    enemy_flag_item = flag1_item;
  }

  const maxclients = cvarNum(gameCvars.maxclients);

  if (ctf_team === other.client.resp.ctf_team) {
    if ((ent.spawnflags & DROPPED_ITEM) === 0) {
      // the flag is at home base. if the player has the enemy flag, he's
      // just won!
      if (other.client.pers.inventory[ITEM_INDEX(enemy_flag_item)]) {
        gi.bprintf(PRINT_HIGH, `${other.client.pers.netname} captured the ${CTFOtherTeamName(ctf_team)} flag!\n`);
        other.client.pers.inventory[ITEM_INDEX(enemy_flag_item)] = 0;

        ctfgame.last_flag_capture = level.time;
        ctfgame.last_capture_team = ctf_team;
        if (ctf_team === CtfTeamT.CTF_TEAM1) ctfgame.team1++;
        else ctfgame.team2++;

        gi.sound(ent, CHAN_RELIABLE + CHAN_NO_PHS_ADD + CHAN_VOICE, gi.soundindex("ctf/flagcap.wav"), 1, ATTN_NONE, 0);

        other.client.resp.score += CTF_CAPTURE_BONUS;
        if (other.client.resp.ghost !== null) other.client.resp.ghost.caps++;

        for (let i = 1; i <= maxclients; i++) {
          const player = g_edicts[i];
          if (!player.inuse || player.client === null) continue;

          if (player.client.resp.ctf_team !== other.client.resp.ctf_team) {
            player.client.resp.ctf_lasthurtcarrier = -5;
          } else if (player.client.resp.ctf_team === other.client.resp.ctf_team) {
            if (player !== other) player.client.resp.score += CTF_TEAM_BONUS;
            if (player.client.resp.ctf_lastreturnedflag + CTF_RETURN_FLAG_ASSIST_TIMEOUT > level.time) {
              gi.bprintf(PRINT_HIGH, `${player.client.pers.netname} gets an assist for returning the flag!\n`);
              player.client.resp.score += CTF_RETURN_FLAG_ASSIST_BONUS;
            }
            if (player.client.resp.ctf_lastfraggedcarrier + CTF_FRAG_CARRIER_ASSIST_TIMEOUT > level.time) {
              gi.bprintf(PRINT_HIGH, `${player.client.pers.netname} gets an assist for fragging the flag carrier!\n`);
              player.client.resp.score += CTF_FRAG_CARRIER_ASSIST_BONUS;
            }
          }
        }

        CTFResetFlags();
        return false;
      }
      return false; // its at home base already
    }
    // hey, its not home. return it by teleporting it back
    gi.bprintf(PRINT_HIGH, `${other.client.pers.netname} returned the ${CTFTeamName(ctf_team)} flag!\n`);
    other.client.resp.score += CTF_RECOVERY_BONUS;
    other.client.resp.ctf_lastreturnedflag = level.time;
    gi.sound(ent, CHAN_RELIABLE + CHAN_NO_PHS_ADD + CHAN_VOICE, gi.soundindex("ctf/flagret.wav"), 1, ATTN_NONE, 0);
    // CTFResetFlag will remove this entity! We must return false
    CTFResetFlag(ctf_team);
    return false;
  }

  // hey, its not our flag, pick it up
  gi.bprintf(PRINT_HIGH, `${other.client.pers.netname} got the ${CTFTeamName(ctf_team)} flag!\n`);
  other.client.resp.score += CTF_FLAG_BONUS;

  other.client.pers.inventory[ITEM_INDEX(flag_item)] = 1;
  other.client.resp.ctf_flagsince = level.time;

  // pick up the flag: if it's not a dropped flag, we just make it
  // disappear; if it's dropped, it will be removed by the pickup caller
  if ((ent.spawnflags & DROPPED_ITEM) === 0) {
    ent.flags |= FL_RESPAWN;
    ent.svflags |= SVF_NOCLIENT;
    ent.solid = SolidT.SOLID_NOT;
  }
  return true;
}

function CTFDropFlagTouch(ent: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  // owner (who dropped us) can't touch for two secs
  if (other === ent.owner && ent.nextthink - level.time > CTF_AUTO_FLAG_RETURN_TIMEOUT - 2) return;

  Touch_Item(ent, other, plane, surf);
}

function CTFDropFlagThink(ent: EdictT): void {
  // auto return the flag; CTFResetFlag will remove ourselves
  if (ent.classname === "item_flag_team1") {
    CTFResetFlag(CtfTeamT.CTF_TEAM1);
    gi.bprintf(PRINT_HIGH, `The ${CTFTeamName(CtfTeamT.CTF_TEAM1)} flag has returned!\n`);
  } else if (ent.classname === "item_flag_team2") {
    CTFResetFlag(CtfTeamT.CTF_TEAM2);
    gi.bprintf(PRINT_HIGH, `The ${CTFTeamName(CtfTeamT.CTF_TEAM2)} flag has returned!\n`);
  }
}

// Called from PlayerDie, to drop the flag from a dying player
export function CTFDeadDropFlag(self: EdictT): void {
  if (self.client === null || flag1_item === null || flag2_item === null) return;

  let dropped: EdictT | null = null;

  if (self.client.pers.inventory[ITEM_INDEX(flag1_item)]) {
    dropped = Drop_Item(self, flag1_item);
    self.client.pers.inventory[ITEM_INDEX(flag1_item)] = 0;
    gi.bprintf(PRINT_HIGH, `${self.client.pers.netname} lost the ${CTFTeamName(CtfTeamT.CTF_TEAM1)} flag!\n`);
  } else if (self.client.pers.inventory[ITEM_INDEX(flag2_item)]) {
    dropped = Drop_Item(self, flag2_item);
    self.client.pers.inventory[ITEM_INDEX(flag2_item)] = 0;
    gi.bprintf(PRINT_HIGH, `${self.client.pers.netname} lost the ${CTFTeamName(CtfTeamT.CTF_TEAM2)} flag!\n`);
  }

  if (dropped !== null) {
    dropped.think = CTFDropFlagThink;
    dropped.nextthink = level.time + CTF_AUTO_FLAG_RETURN_TIMEOUT;
    dropped.touch = CTFDropFlagTouch;
  }
}

export function CTFDrop_Flag(ent: EdictT, _item: GItemT): boolean {
  if (random() < 0.5) gi.cprintf(ent, PRINT_HIGH, "Only lusers drop flags.\n");
  else gi.cprintf(ent, PRINT_HIGH, "Winners don't drop flags.\n");
  return false;
}

function CTFFlagThink(ent: EdictT): void {
  if (ent.solid !== SolidT.SOLID_NOT) ent.s.frame = 173 + ((ent.s.frame - 173 + 1) % 16);
  ent.nextthink = level.time + FRAMETIME;
}

export function CTFFlagSetup(ent: EdictT): void {
  VectorSet(ent.mins, -15, -15, -15);
  VectorSet(ent.maxs, 15, 15, 15);

  if (ent.model !== null) gi.setmodel(ent, ent.model);
  else if (ent.item !== null && ent.item.world_model !== null) gi.setmodel(ent, ent.item.world_model);
  ent.solid = SolidT.SOLID_TRIGGER;
  ent.movetype = MovetypeT.MOVETYPE_TOSS;
  ent.touch = Touch_Item;

  const dest = vec3();
  VectorAdd(ent.s.origin, tv(0, 0, -128), dest);

  const tr = gi.trace(ent.s.origin, ent.mins, ent.maxs, dest, ent, MASK_SOLID);
  if (tr.startsolid) {
    gi.dprintf(`CTFFlagSetup: ${ent.classname ?? ""} startsolid at ${vtos(ent.s.origin)}\n`);
    G_FreeEdict(ent);
    return;
  }

  VectorCopy(tr.endpos, ent.s.origin);

  gi.linkentity(ent);

  ent.nextthink = level.time + FRAMETIME;
  ent.think = CTFFlagThink;
}

export function CTFEffects(player: EdictT): void {
  if (player.client === null || flag1_item === null || flag2_item === null) return;

  player.s.effects &= ~(EF_FLAG1 | EF_FLAG2);
  if (player.health > 0) {
    if (player.client.pers.inventory[ITEM_INDEX(flag1_item)]) player.s.effects |= EF_FLAG1;
    if (player.client.pers.inventory[ITEM_INDEX(flag2_item)]) player.s.effects |= EF_FLAG2;
  }

  if (player.client.pers.inventory[ITEM_INDEX(flag1_item)]) player.s.modelindex3 = gi.modelindex("players/male/flag1.md2");
  else if (player.client.pers.inventory[ITEM_INDEX(flag2_item)]) player.s.modelindex3 = gi.modelindex("players/male/flag2.md2");
  else player.s.modelindex3 = 0;
}

// called when we enter the intermission
export function CTFCalcScores(): void {
  ctfgame.total1 = 0;
  ctfgame.total2 = 0;
  const maxclients = cvarNum(gameCvars.maxclients);
  for (let i = 0; i < maxclients; i++) {
    if (!g_edicts[i + 1].inuse) continue;
    const cl = game.clients[i];
    if (cl.resp.ctf_team === CtfTeamT.CTF_TEAM1) ctfgame.total1 += cl.resp.score;
    else if (cl.resp.ctf_team === CtfTeamT.CTF_TEAM2) ctfgame.total2 += cl.resp.score;
  }
}

export function CTFID_f(ent: EdictT): void {
  if (ent.client === null) return;
  if (ent.client.resp.id_state) {
    gi.cprintf(ent, PRINT_HIGH, "Disabling player identication display.\n");
    ent.client.resp.id_state = false;
  } else {
    gi.cprintf(ent, PRINT_HIGH, "Activating player identication display.\n");
    ent.client.resp.id_state = true;
  }
}

function CTFSetIDView(ent: EdictT): void {
  if (ent.client === null) return;

  // only check every few frames
  if (level.time - ent.client.resp.lastidtime < 0.25) return;
  ent.client.resp.lastidtime = level.time;

  ent.client.ps.stats[STAT_CTF_ID_VIEW] = 0;
  ent.client.ps.stats[STAT_CTF_ID_VIEW_COLOR] = 0;

  let forward = vec3();
  AngleVectors(ent.client.v_angle, forward, null, null);
  VectorScale(forward, 1024, forward);
  VectorAdd(ent.s.origin, forward, forward);
  const tr = gi.trace(ent.s.origin, null, null, forward, ent, MASK_SOLID);
  const trEnt = tr.ent === null ? null : g_edicts[tr.ent.s.number];
  if (tr.fraction < 1 && trEnt !== null && trEnt !== undefined && trEnt.client !== null) {
    ent.client.ps.stats[STAT_CTF_ID_VIEW] = CS_GENERAL + (trEnt.s.number - 1);
    if (trEnt.client.resp.ctf_team === CtfTeamT.CTF_TEAM1) ent.client.ps.stats[STAT_CTF_ID_VIEW_COLOR] = imageindex_sbfctf1;
    else if (trEnt.client.resp.ctf_team === CtfTeamT.CTF_TEAM2) ent.client.ps.stats[STAT_CTF_ID_VIEW_COLOR] = imageindex_sbfctf2;
    return;
  }

  forward = vec3();
  AngleVectors(ent.client.v_angle, forward, null, null);
  let best: EdictT | null = null;
  let bd = 0;
  const maxclients = cvarNum(gameCvars.maxclients);
  for (let i = 1; i <= maxclients; i++) {
    const who = g_edicts[i];
    if (!who.inuse || who.solid === SolidT.SOLID_NOT) continue;
    const dir = vec3();
    VectorSubtract(who.s.origin, ent.s.origin, dir);
    VectorNormalize(dir);
    const d = DotProduct(forward, dir);
    if (d > bd && loc_CanSee(ent, who)) {
      bd = d;
      best = who;
    }
  }
  if (bd > 0.9 && best !== null) {
    ent.client.ps.stats[STAT_CTF_ID_VIEW] = CS_GENERAL + (best.s.number - 1);
    if (best.client !== null && best.client.resp.ctf_team === CtfTeamT.CTF_TEAM1) ent.client.ps.stats[STAT_CTF_ID_VIEW_COLOR] = imageindex_sbfctf1;
    else if (best.client !== null && best.client.resp.ctf_team === CtfTeamT.CTF_TEAM2) ent.client.ps.stats[STAT_CTF_ID_VIEW_COLOR] = imageindex_sbfctf2;
  }
}

export function SetCTFStats(ent: EdictT): void {
  if (ent.client === null) return;
  const client = ent.client;

  client.ps.stats[STAT_CTF_MATCH] = ctfgame.match > MatchT.MATCH_NONE ? CONFIG_CTF_MATCH : 0;

  if (ctfgame.warnactive !== 0) client.ps.stats[STAT_CTF_TEAMINFO] = CONFIG_CTF_TEAMINFO;
  else client.ps.stats[STAT_CTF_TEAMINFO] = 0;

  // ghosting
  if (client.resp.ghost !== null) {
    client.resp.ghost.score = client.resp.score;
    client.resp.ghost.netname = client.pers.netname;
    client.resp.ghost.number = ent.s.number;
  }

  // logo headers for the frag display
  client.ps.stats[STAT_CTF_TEAM1_HEADER] = imageindex_ctfsb1;
  client.ps.stats[STAT_CTF_TEAM2_HEADER] = imageindex_ctfsb2;

  // if during intermission, we must blink the team header of the winning team
  if (level.intermissiontime !== 0 && (level.framenum & 8) !== 0) {
    if (ctfgame.team1 > ctfgame.team2) client.ps.stats[STAT_CTF_TEAM1_HEADER] = 0;
    else if (ctfgame.team2 > ctfgame.team1) client.ps.stats[STAT_CTF_TEAM2_HEADER] = 0;
    else if (ctfgame.total1 > ctfgame.total2) client.ps.stats[STAT_CTF_TEAM1_HEADER] = 0;
    else if (ctfgame.total2 > ctfgame.total1) client.ps.stats[STAT_CTF_TEAM2_HEADER] = 0;
    else {
      client.ps.stats[STAT_CTF_TEAM1_HEADER] = 0;
      client.ps.stats[STAT_CTF_TEAM2_HEADER] = 0;
    }
  }

  // tech icon
  client.ps.stats[STAT_CTF_TECH] = 0;
  for (const tname of tnames) {
    const tech = FindItemByClassname(tname);
    if (tech !== null && client.pers.inventory[ITEM_INDEX(tech)] && tech.icon !== null) {
      client.ps.stats[STAT_CTF_TECH] = gi.imageindex(tech.icon);
      break;
    }
  }

  const maxclients = cvarNum(gameCvars.maxclients);

  // figure out what icon to display for team logos: flag at base, flag
  // taken, or flag dropped
  let p1 = imageindex_i_ctf1;
  let e = G_Find(null, "classname", "item_flag_team1");
  if (e !== null) {
    if (e.solid === SolidT.SOLID_NOT) {
      p1 = imageindex_i_ctf1d; // default to dropped
      if (flag1_item !== null) {
        for (let i = 1; i <= maxclients; i++) {
          const pe = g_edicts[i];
          if (pe.inuse && pe.client !== null && pe.client.pers.inventory[ITEM_INDEX(flag1_item)]) {
            p1 = imageindex_i_ctf1t; // enemy has it
            break;
          }
        }
      }
    } else if ((e.spawnflags & DROPPED_ITEM) !== 0) {
      p1 = imageindex_i_ctf1d;
    }
  }

  let p2 = imageindex_i_ctf2;
  e = G_Find(null, "classname", "item_flag_team2");
  if (e !== null) {
    if (e.solid === SolidT.SOLID_NOT) {
      p2 = imageindex_i_ctf2d;
      if (flag2_item !== null) {
        for (let i = 1; i <= maxclients; i++) {
          const pe = g_edicts[i];
          if (pe.inuse && pe.client !== null && pe.client.pers.inventory[ITEM_INDEX(flag2_item)]) {
            p2 = imageindex_i_ctf2t;
            break;
          }
        }
      }
    } else if ((e.spawnflags & DROPPED_ITEM) !== 0) {
      p2 = imageindex_i_ctf2d;
    }
  }

  client.ps.stats[STAT_CTF_TEAM1_PIC] = p1;
  client.ps.stats[STAT_CTF_TEAM2_PIC] = p2;

  if (ctfgame.last_flag_capture !== 0 && level.time - ctfgame.last_flag_capture < 5) {
    if (ctfgame.last_capture_team === CtfTeamT.CTF_TEAM1) {
      client.ps.stats[STAT_CTF_TEAM1_PIC] = (level.framenum & 8) !== 0 ? p1 : 0;
    } else {
      client.ps.stats[STAT_CTF_TEAM2_PIC] = (level.framenum & 8) !== 0 ? p2 : 0;
    }
  }

  client.ps.stats[STAT_CTF_TEAM1_CAPS] = ctfgame.team1;
  client.ps.stats[STAT_CTF_TEAM2_CAPS] = ctfgame.team2;

  client.ps.stats[STAT_CTF_FLAG_PIC] = 0;
  if (
    flag2_item !== null &&
    client.resp.ctf_team === CtfTeamT.CTF_TEAM1 &&
    client.pers.inventory[ITEM_INDEX(flag2_item)] &&
    (level.framenum & 8) !== 0
  ) {
    client.ps.stats[STAT_CTF_FLAG_PIC] = imageindex_i_ctf2;
  } else if (
    flag1_item !== null &&
    client.resp.ctf_team === CtfTeamT.CTF_TEAM2 &&
    client.pers.inventory[ITEM_INDEX(flag1_item)] &&
    (level.framenum & 8) !== 0
  ) {
    client.ps.stats[STAT_CTF_FLAG_PIC] = imageindex_i_ctf1;
  }

  client.ps.stats[STAT_CTF_JOINED_TEAM1_PIC] = 0;
  client.ps.stats[STAT_CTF_JOINED_TEAM2_PIC] = 0;
  if (client.resp.ctf_team === CtfTeamT.CTF_TEAM1) client.ps.stats[STAT_CTF_JOINED_TEAM1_PIC] = imageindex_i_ctfj;
  else if (client.resp.ctf_team === CtfTeamT.CTF_TEAM2) client.ps.stats[STAT_CTF_JOINED_TEAM2_PIC] = imageindex_i_ctfj;

  if (client.resp.id_state) CTFSetIDView(ent);
  else {
    client.ps.stats[STAT_CTF_ID_VIEW] = 0;
    client.ps.stats[STAT_CTF_ID_VIEW_COLOR] = 0;
  }
}

/*--------------------------------------------------------------------------*/

/*QUAKED info_player_team1 (1 0 0) (-16 -16 -24) (16 16 32)
potential team1 spawning position for ctf games
*/
export function SP_info_player_team1(_self: EdictT): void {}

/*QUAKED info_player_team2 (0 0 1) (-16 -16 -24) (16 16 32)
potential team2 spawning position for ctf games
*/
export function SP_info_player_team2(_self: EdictT): void {}

/*--------------------------------------------------------------------------*/
/* GRAPPLE                                                                  */
/*--------------------------------------------------------------------------*/

// ent is player
export function CTFPlayerResetGrapple(ent: EdictT): void {
  if (ent.client !== null && ent.client.ctf_grapple !== null) CTFResetGrapple(ent.client.ctf_grapple);
}

// self is grapple, not player
export function CTFResetGrapple(self: EdictT): void {
  if (self.owner === null || self.owner.client === null) return;
  const cl = self.owner.client;
  if (cl.ctf_grapple !== null) {
    let volume = 1.0;
    if (cl.silencer_shots) volume = 0.2;

    gi.sound(self.owner, CHAN_RELIABLE + CHAN_WEAPON, gi.soundindex("weapons/grapple/grreset.wav"), volume, ATTN_NORM, 0);
    cl.ctf_grapple = null;
    cl.ctf_grapplereleasetime = level.time;
    cl.ctf_grapplestate = CtfGrapplestateT.CTF_GRAPPLE_STATE_FLY; // we're firing, not on hook
    cl.ps.pmove.pm_flags &= ~PMF_NO_PREDICTION;
    G_FreeEdict(self);
  }
}

export function CTFGrappleTouch(self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  if (other === self.owner) return;
  if (self.owner === null || self.owner.client === null) return;
  if (self.owner.client.ctf_grapplestate !== CtfGrapplestateT.CTF_GRAPPLE_STATE_FLY) return;

  if (surf !== null && (surf.flags & SURF_SKY) !== 0) {
    CTFResetGrapple(self);
    return;
  }

  let volume = 1.0;

  VectorCopy(vec3_origin, self.velocity);

  PlayerNoise(self.owner, self.s.origin, PNOISE_IMPACT);

  if (other.takedamage) {
    T_Damage(other, self, self.owner, self.velocity, self.s.origin, plane !== null ? plane.normal : vec3_origin, self.dmg, 1, 0, MOD_GRAPPLE);
    CTFResetGrapple(self);
    return;
  }

  self.owner.client.ctf_grapplestate = CtfGrapplestateT.CTF_GRAPPLE_STATE_PULL; // we're on hook
  self.enemy = other;

  self.solid = SolidT.SOLID_NOT;

  if (self.owner.client.silencer_shots) volume = 0.2;

  gi.sound(self.owner, CHAN_RELIABLE + CHAN_WEAPON, gi.soundindex("weapons/grapple/grpull.wav"), volume, ATTN_NORM, 0);
  gi.sound(self, CHAN_WEAPON, gi.soundindex("weapons/grapple/grhit.wav"), volume, ATTN_NORM, 0);

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_SPARKS);
  gi.WritePosition(self.s.origin);
  gi.WriteDir(plane !== null ? plane.normal : vec3_origin);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);
}

// draw beam between grapple and self
export function CTFGrappleDrawCable(self: EdictT): void {
  if (self.owner === null || self.owner.client === null) return;

  const f = vec3();
  const r = vec3();
  const offset = vec3();
  const start = vec3();
  const end = vec3();
  const dir = vec3();

  AngleVectors(self.owner.client.v_angle, f, r, null);
  VectorSet(offset, 16, 16, self.owner.viewheight - 8);
  P_ProjectSource(self.owner.client, self.owner.s.origin, offset, f, r, start);

  VectorSubtract(start, self.owner.s.origin, offset);

  VectorSubtract(start, self.s.origin, dir);
  const distance = VectorLength(dir);
  // don't draw cable if close
  if (distance < 64) return;

  VectorCopy(self.s.origin, end);

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_GRAPPLE_CABLE);
  gi.WriteShort(self.owner.s.number);
  gi.WritePosition(self.owner.s.origin);
  gi.WritePosition(end);
  gi.WritePosition(offset);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);
}

// pull the player toward the grapple
export function CTFGrapplePull(self: EdictT): void {
  const owner = self.owner;
  if (owner === null || owner.client === null) return;
  const client = owner.client;

  if (
    client.pers.weapon !== null &&
    client.pers.weapon.classname === "weapon_grapple" &&
    client.newweapon === null &&
    client.weaponstate !== WeaponstateT.WEAPON_FIRING &&
    client.weaponstate !== WeaponstateT.WEAPON_ACTIVATING
  ) {
    CTFResetGrapple(self);
    return;
  }

  if (self.enemy !== null) {
    if (self.enemy.solid === SolidT.SOLID_NOT) {
      CTFResetGrapple(self);
      return;
    }
    if (self.enemy.solid === SolidT.SOLID_BBOX) {
      const v = vec3();
      VectorScale(self.enemy.size, 0.5, v);
      VectorAdd(v, self.enemy.s.origin, v);
      VectorAdd(v, self.enemy.mins, self.s.origin);
      gi.linkentity(self);
    } else {
      VectorCopy(self.enemy.velocity, self.velocity);
    }
    if (self.enemy.takedamage && !CheckTeamDamage(self.enemy, owner)) {
      let volume = 1.0;
      if (client.silencer_shots) volume = 0.2;

      T_Damage(self.enemy, self, owner, self.velocity, self.s.origin, vec3_origin, 1, 1, 0, MOD_GRAPPLE);
      gi.sound(self, CHAN_WEAPON, gi.soundindex("weapons/grapple/grhurt.wav"), volume, ATTN_NORM, 0);
    }
    if (self.enemy.deadflag) {
      CTFResetGrapple(self);
      return;
    }
  }

  CTFGrappleDrawCable(self);

  if (client.ctf_grapplestate > CtfGrapplestateT.CTF_GRAPPLE_STATE_FLY) {
    // pull player toward grapple
    const forward = vec3();
    const up = vec3();
    const v = vec3();
    const hookdir = vec3();

    AngleVectors(client.v_angle, forward, null, up);
    VectorCopy(owner.s.origin, v);
    v[2] += owner.viewheight;
    VectorSubtract(self.s.origin, v, hookdir);

    const vlen = VectorLength(hookdir);

    if (client.ctf_grapplestate === CtfGrapplestateT.CTF_GRAPPLE_STATE_PULL && vlen < 64) {
      let volume = 1.0;
      if (client.silencer_shots) volume = 0.2;

      client.ps.pmove.pm_flags |= PMF_NO_PREDICTION;
      gi.sound(owner, CHAN_RELIABLE + CHAN_WEAPON, gi.soundindex("weapons/grapple/grhang.wav"), volume, ATTN_NORM, 0);
      client.ctf_grapplestate = CtfGrapplestateT.CTF_GRAPPLE_STATE_HANG;
    }

    VectorNormalize(hookdir);
    VectorScale(hookdir, CTF_GRAPPLE_PULL_SPEED, hookdir);
    VectorCopy(hookdir, owner.velocity);
    SV_AddGravity(owner);
  }
}

export function CTFFireGrapple(self: EdictT, start: Vec3, dir: Vec3, damage: number, speed: number, effect: number): void {
  if (self.client === null) return;
  VectorNormalize(dir);

  const grapple = G_Spawn();
  VectorCopy(start, grapple.s.origin);
  VectorCopy(start, grapple.s.old_origin);
  vectoangles(dir, grapple.s.angles);
  VectorScale(dir, speed, grapple.velocity);
  grapple.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  grapple.clipmask = MASK_SHOT;
  grapple.solid = SolidT.SOLID_BBOX;
  grapple.s.effects |= effect;
  VectorClear(grapple.mins);
  VectorClear(grapple.maxs);
  grapple.s.modelindex = gi.modelindex("models/weapons/grapple/hook/tris.md2");
  grapple.owner = self;
  grapple.touch = CTFGrappleTouch;
  grapple.dmg = damage;
  self.client.ctf_grapple = grapple;
  self.client.ctf_grapplestate = CtfGrapplestateT.CTF_GRAPPLE_STATE_FLY; // we're firing, not on hook
  gi.linkentity(grapple);

  const tr = gi.trace(self.s.origin, null, null, grapple.s.origin, grapple, MASK_SHOT);
  if (tr.fraction < 1.0 && tr.ent !== null && grapple.touch !== null) {
    VectorMA(grapple.s.origin, -10, dir, grapple.s.origin);
    const other = g_edicts[tr.ent.s.number];
    grapple.touch(grapple, other, null, null);
  }
}

export function CTFGrappleFire(ent: EdictT, g_offset: Vec3, damage: number, effect: number): void {
  if (ent.client === null) return;
  if (ent.client.ctf_grapplestate > CtfGrapplestateT.CTF_GRAPPLE_STATE_FLY) return; // it's already out

  const forward = vec3();
  const right = vec3();
  const offset = vec3();
  const start = vec3();
  let volume = 1.0;

  AngleVectors(ent.client.v_angle, forward, right, null);
  VectorSet(offset, 24, 8, ent.viewheight - 8 + 2);
  VectorAdd(offset, g_offset, offset);
  P_ProjectSource(ent.client, ent.s.origin, offset, forward, right, start);

  VectorScale(forward, -2, ent.client.kick_origin);
  ent.client.kick_angles[0] = -1;

  if (ent.client.silencer_shots) volume = 0.2;

  gi.sound(ent, CHAN_RELIABLE + CHAN_WEAPON, gi.soundindex("weapons/grapple/grfire.wav"), volume, ATTN_NORM, 0);
  CTFFireGrapple(ent, start, forward, damage, CTF_GRAPPLE_SPEED, effect);

  PlayerNoise(ent, start, PNOISE_WEAPON);
}

export function CTFWeapon_Grapple_Fire(ent: EdictT): void {
  if (ent.client === null) return;
  const damage = 10;
  CTFGrappleFire(ent, vec3_origin, damage, 0);
  ent.client.ps.gunframe++;
}

export function CTFWeapon_Grapple(ent: EdictT): void {
  if (ent.client === null) return;
  const client = ent.client;
  const pause_frames = [10, 18, 27, 0];
  const fire_frames = [6, 0];

  // if the attack button is still down, stay in the firing frame
  if ((client.buttons & BUTTON_ATTACK) !== 0 && client.weaponstate === WeaponstateT.WEAPON_FIRING && client.ctf_grapple !== null) {
    client.ps.gunframe = 9;
  }

  if ((client.buttons & BUTTON_ATTACK) === 0 && client.ctf_grapple !== null) {
    CTFResetGrapple(client.ctf_grapple);
    if (client.weaponstate === WeaponstateT.WEAPON_FIRING) client.weaponstate = WeaponstateT.WEAPON_READY;
  }

  if (
    client.newweapon !== null &&
    client.ctf_grapplestate > CtfGrapplestateT.CTF_GRAPPLE_STATE_FLY &&
    client.weaponstate === WeaponstateT.WEAPON_FIRING
  ) {
    // he wants to change weapons while grappled
    client.weaponstate = WeaponstateT.WEAPON_DROPPING;
    client.ps.gunframe = 32;
  }

  const prevstate = client.weaponstate;
  Weapon_Generic(ent, 5, 9, 31, 36, pause_frames, fire_frames, CTFWeapon_Grapple_Fire);

  // if we just switched back to grapple, immediately go to fire frame
  if (
    prevstate === WeaponstateT.WEAPON_ACTIVATING &&
    client.weaponstate === WeaponstateT.WEAPON_READY &&
    client.ctf_grapplestate > CtfGrapplestateT.CTF_GRAPPLE_STATE_FLY
  ) {
    if ((client.buttons & BUTTON_ATTACK) === 0) client.ps.gunframe = 9;
    else client.ps.gunframe = 5;
    client.weaponstate = WeaponstateT.WEAPON_FIRING;
  }
}

/*--------------------------------------------------------------------------*/

export function CTFTeam_f(ent: EdictT): void {
  if (ent.client === null) return;
  const t = gi.args();
  if (t.length === 0) {
    gi.cprintf(ent, PRINT_HIGH, `You are on the ${CTFTeamName(ent.client.resp.ctf_team)} team.\n`);
    return;
  }

  if (ctfgame.match > MatchT.MATCH_SETUP) {
    gi.cprintf(ent, PRINT_HIGH, "Can't change teams in a match.\n");
    return;
  }

  let desired_team: number;
  if (Q_stricmp(t, "red") === 0) desired_team = CtfTeamT.CTF_TEAM1;
  else if (Q_stricmp(t, "blue") === 0) desired_team = CtfTeamT.CTF_TEAM2;
  else {
    gi.cprintf(ent, PRINT_HIGH, `Unknown team ${t}.\n`);
    return;
  }

  if (ent.client.resp.ctf_team === desired_team) {
    gi.cprintf(ent, PRINT_HIGH, `You are already on the ${CTFTeamName(ent.client.resp.ctf_team)} team.\n`);
    return;
  }

  ent.svflags = 0;
  ent.flags &= ~FL_GODMODE;
  ent.client.resp.ctf_team = desired_team;
  ent.client.resp.ctf_state = 0;
  const s = Info_ValueForKey(ent.client.pers.userinfo, "skin");
  CTFAssignSkin(ent, s);

  if (ent.solid === SolidT.SOLID_NOT) {
    // spectator
    PutClientInServer(ent);
    ent.s.event = EntityEventT.EV_PLAYER_TELEPORT;
    ent.client.ps.pmove.pm_flags = PMF_TIME_TELEPORT;
    ent.client.ps.pmove.pm_time = 14;
    gi.bprintf(PRINT_HIGH, `${ent.client.pers.netname} joined the ${CTFTeamName(desired_team)} team.\n`);
    return;
  }

  ent.health = 0;
  player_die(ent, ent, ent, 100000, vec3_origin);
  // don't even bother waiting for death frames
  ent.deadflag = DEAD_DEAD;
  respawn(ent);

  ent.client.resp.score = 0;

  gi.bprintf(PRINT_HIGH, `${ent.client.pers.netname} changed to the ${CTFTeamName(desired_team)} team.\n`);
}

/*
==================
CTFScoreboardMessage
==================
*/
export function CTFScoreboardMessage(_ent: EdictT, _killer: EdictT | null): void {
  const total: [number, number] = [0, 0];
  const totalscore: [number, number] = [0, 0];
  const last: [number, number] = [0, 0];
  const sorted: number[][] = [[], []];
  const sortedscores: number[][] = [[], []];

  const maxclients = game.maxclients;

  for (let i = 0; i < maxclients; i++) {
    const cl_ent = g_edicts[1 + i];
    if (!cl_ent.inuse) continue;
    const clResp = game.clients[i].resp;
    let team: number;
    if (clResp.ctf_team === CtfTeamT.CTF_TEAM1) team = 0;
    else if (clResp.ctf_team === CtfTeamT.CTF_TEAM2) team = 1;
    else continue; // unknown team?

    const score = clResp.score;
    const sortedTeam = sortedscores[team];
    if (sortedTeam === undefined) continue;
    let j = 0;
    while (j < total[team]! && score <= sortedTeam[j]!) j++;
    sorted[team]?.splice(j, 0, i);
    sortedTeam.splice(j, 0, score);
    totalscore[team] += score;
    total[team]++;
  }

  let string = Com_sprintf(
    'if 24 xv 8 yv 8 pic 24 endif xv 40 yv 28 string "%4d/%-3d" xv 98 yv 12 num 2 18 if 25 xv 168 yv 8 pic 25 endif xv 200 yv 28 string "%4d/%-3d" xv 256 yv 12 num 2 20 ',
    totalscore[0],
    total[0],
    totalscore[1],
    total[1],
  );

  for (let i = 0; i < 16; i++) {
    if (i >= total[0] && i >= total[1]) break; // we're done

    if (i < total[0]) {
      const idx = sorted[0]?.[i] ?? -1;
      const cl = game.clients[idx];
      const cl_ent = g_edicts[1 + idx];
      if (cl !== undefined && cl_ent !== undefined) {
        let entry = Com_sprintf("ctf 0 %d %d %d %d ", 42 + i * 8, idx, cl.resp.score, cl.ping > 999 ? 999 : cl.ping);
        if (flag2_item !== null && cl_ent.client !== null && cl_ent.client.pers.inventory[ITEM_INDEX(flag2_item)]) {
          entry += Com_sprintf("xv 56 yv %d picn sbfctf2 ", 42 + i * 8);
        }
        if (1000 - string.length > entry.length) {
          string += entry;
          last[0] = i;
        }
      }
    }

    if (i < total[1]) {
      const idx = sorted[1]?.[i] ?? -1;
      const cl = game.clients[idx];
      const cl_ent = g_edicts[1 + idx];
      if (cl !== undefined && cl_ent !== undefined) {
        let entry = Com_sprintf("ctf 160 %d %d %d %d ", 42 + i * 8, idx, cl.resp.score, cl.ping > 999 ? 999 : cl.ping);
        if (flag1_item !== null && cl_ent.client !== null && cl_ent.client.pers.inventory[ITEM_INDEX(flag1_item)]) {
          entry += Com_sprintf("xv 216 yv %d picn sbfctf1 ", 42 + i * 8);
        }
        if (1000 - string.length > entry.length) {
          string += entry;
          last[1] = i;
        }
      }
    }
  }

  // put in spectators if we have enough room
  const j2 = last[0] > last[1] ? last[0] : last[1];
  let y = (j2 + 2) * 8 + 42;

  let k = 0;
  let n = 0;
  if (1000 - string.length > 50) {
    for (let i = 0; i < maxclients; i++) {
      const cl_ent = g_edicts[1 + i];
      const cl = game.clients[i];
      if (!cl_ent.inuse || cl_ent.solid !== SolidT.SOLID_NOT || cl.resp.ctf_team !== CtfTeamT.CTF_NOTEAM) continue;

      if (k === 0) {
        k = 1;
        string += Com_sprintf('xv 0 yv %d string2 "Spectators" ', y);
        y += 8;
      }

      const entry = Com_sprintf("ctf %d %d %d %d %d ", n % 2 === 1 ? 160 : 0, y, i, cl.resp.score, cl.ping > 999 ? 999 : cl.ping);
      if (1000 - string.length > entry.length) string += entry;

      if (n % 2 === 1) y += 8;
      n++;
    }
  }

  if (total[0] - last[0] > 1) {
    string += Com_sprintf('xv 8 yv %d string "..and %d more" ', 42 + (last[0] + 1) * 8, total[0] - last[0] - 1);
  }
  if (total[1] - last[1] > 1) {
    string += Com_sprintf('xv 168 yv %d string "..and %d more" ', 42 + (last[1] + 1) * 8, total[1] - last[1] - 1);
  }

  gi.WriteByte(svc_layout);
  gi.WriteString(string);
}

/*--------------------------------------------------------------------------*/
/* TECH                                                                    */
/*--------------------------------------------------------------------------*/

export function CTFHasTech(who: EdictT): void {
  if (who.client === null) return;
  if (level.time - who.client.ctf_lasttechmsg > 2) {
    gi.centerprintf(who, "You already have a TECH powerup.");
    who.client.ctf_lasttechmsg = level.time;
  }
}

export function CTFWhat_Tech(ent: EdictT): GItemT | null {
  if (ent.client === null) return null;
  for (const tname of tnames) {
    const tech = FindItemByClassname(tname);
    if (tech !== null && ent.client.pers.inventory[ITEM_INDEX(tech)]) return tech;
  }
  return null;
}

export function CTFPickup_Tech(ent: EdictT, other: EdictT): boolean {
  if (other.client === null || ent.item === null) return false;

  for (const tname of tnames) {
    const tech = FindItemByClassname(tname);
    if (tech !== null && other.client.pers.inventory[ITEM_INDEX(tech)]) {
      CTFHasTech(other);
      return false; // has this one
    }
  }

  // client only gets one tech
  other.client.pers.inventory[ITEM_INDEX(ent.item)]++;
  other.client.ctf_regentime = level.time;
  return true;
}

function FindTechSpawn(): EdictT | null {
  let spot: EdictT | null = null;
  const count = Math.floor(random() * 16);
  for (let n = 0; n < count; n++) {
    spot = G_Find(spot, "classname", "info_player_deathmatch");
  }
  if (spot === null) spot = G_Find(spot, "classname", "info_player_deathmatch");
  return spot;
}

function TechThink(tech: EdictT): void {
  const spot = FindTechSpawn();
  if (spot !== null) {
    if (tech.item !== null) SpawnTech(tech.item, spot);
    G_FreeEdict(tech);
  } else {
    tech.nextthink = level.time + CTF_TECH_TIMEOUT;
    tech.think = TechThink;
  }
}

export function CTFDrop_Tech(ent: EdictT, item: GItemT): void {
  if (ent.client === null) return;
  const tech = Drop_Item(ent, item);
  tech.nextthink = level.time + CTF_TECH_TIMEOUT;
  tech.think = TechThink;
  ent.client.pers.inventory[ITEM_INDEX(item)] = 0;
}

export function CTFDeadDropTech(ent: EdictT): void {
  if (ent.client === null) return;
  for (const tname of tnames) {
    const tech = FindItemByClassname(tname);
    if (tech !== null && ent.client.pers.inventory[ITEM_INDEX(tech)]) {
      const dropped = Drop_Item(ent, tech);
      // hack the velocity to make it bounce random
      dropped.velocity[0] = Math.floor(random() * 600) - 300;
      dropped.velocity[1] = Math.floor(random() * 600) - 300;
      dropped.nextthink = level.time + CTF_TECH_TIMEOUT;
      dropped.think = TechThink;
      dropped.owner = null;
      ent.client.pers.inventory[ITEM_INDEX(tech)] = 0;
    }
  }
}

function SpawnTech(item: GItemT, spot: EdictT): void {
  const ent = G_Spawn();

  ent.classname = item.classname;
  ent.item = item;
  ent.spawnflags = DROPPED_ITEM;
  ent.s.effects = item.world_model_flags;
  ent.s.renderfx = RF_GLOW;
  VectorSet(ent.mins, -15, -15, -15);
  VectorSet(ent.maxs, 15, 15, 15);
  if (item.world_model !== null) gi.setmodel(ent, item.world_model);
  ent.solid = SolidT.SOLID_TRIGGER;
  ent.movetype = MovetypeT.MOVETYPE_TOSS;
  ent.touch = Touch_Item;
  ent.owner = ent;

  const angles = vec3();
  angles[0] = 0;
  angles[1] = Math.floor(random() * 360);
  angles[2] = 0;

  const forward = vec3();
  const right = vec3();
  AngleVectors(angles, forward, right, null);
  VectorCopy(spot.s.origin, ent.s.origin);
  ent.s.origin[2] += 16;
  VectorScale(forward, 100, ent.velocity);
  ent.velocity[2] = 300;

  ent.nextthink = level.time + CTF_TECH_TIMEOUT;
  ent.think = TechThink;

  gi.linkentity(ent);
}

function SpawnTechs(ent: EdictT | null): void {
  for (const tname of tnames) {
    const tech = FindItemByClassname(tname);
    const spot = tech !== null ? FindTechSpawn() : null;
    if (tech !== null && spot !== null) SpawnTech(tech, spot);
  }
  if (ent !== null) G_FreeEdict(ent);
}

// frees the passed edict!
export function CTFRespawnTech(ent: EdictT): void {
  const spot = FindTechSpawn();
  if (spot !== null && ent.item !== null) SpawnTech(ent.item, spot);
  G_FreeEdict(ent);
}

export function CTFSetupTechSpawn(): void {
  if ((cvarNum(gameCvars.dmflags) & DF_CTF_NO_TECH) !== 0) return;

  const ent = G_Spawn();
  ent.nextthink = level.time + 2;
  ent.think = SpawnTechs;
}

export function CTFResetTech(): void {
  for (let i = 1; i < globals.num_edicts; i++) {
    const ent = g_edicts[i];
    if (ent.inuse && ent.item !== null && (ent.item.flags & IT_TECH) !== 0) G_FreeEdict(ent);
  }
  SpawnTechs(null);
}

let techItem1: GItemT | null = null; // item_tech1 (resistance)
let techItem2: GItemT | null = null; // item_tech2 (strength)
let techItem3: GItemT | null = null; // item_tech3 (haste)
let techItem4: GItemT | null = null; // item_tech4 (regeneration)
// The C source uses one independent function-local `static gitem_t *tech`
// per function (six separate caches for two tech types); consolidated here
// into one module cache per tech classname since FindItemByClassname is
// idempotent and the extra per-function caches had no observable effect.

export function CTFApplyResistance(ent: EdictT, dmg: number): number {
  let volume = 1.0;
  if (ent.client !== null && ent.client.silencer_shots) volume = 0.2;

  if (techItem1 === null) techItem1 = FindItemByClassname("item_tech1");
  if (dmg !== 0 && techItem1 !== null && ent.client !== null && ent.client.pers.inventory[ITEM_INDEX(techItem1)]) {
    gi.sound(ent, CHAN_VOICE, gi.soundindex("ctf/tech1.wav"), volume, ATTN_NORM, 0);
    return Math.trunc(dmg / 2);
  }
  return dmg;
}

export function CTFApplyStrength(ent: EdictT, dmg: number): number {
  if (techItem2 === null) techItem2 = FindItemByClassname("item_tech2");
  if (dmg !== 0 && techItem2 !== null && ent.client !== null && ent.client.pers.inventory[ITEM_INDEX(techItem2)]) {
    return dmg * 2;
  }
  return dmg;
}

export function CTFApplyStrengthSound(ent: EdictT): boolean {
  let volume = 1.0;
  if (ent.client !== null && ent.client.silencer_shots) volume = 0.2;

  if (techItem2 === null) techItem2 = FindItemByClassname("item_tech2");
  if (techItem2 !== null && ent.client !== null && ent.client.pers.inventory[ITEM_INDEX(techItem2)]) {
    if (ent.client.ctf_techsndtime < level.time) {
      ent.client.ctf_techsndtime = level.time + 1;
      if (ent.client.quad_framenum > level.framenum) gi.sound(ent, CHAN_VOICE, gi.soundindex("ctf/tech2x.wav"), volume, ATTN_NORM, 0);
      else gi.sound(ent, CHAN_VOICE, gi.soundindex("ctf/tech2.wav"), volume, ATTN_NORM, 0);
    }
    return true;
  }
  return false;
}

export function CTFApplyHaste(ent: EdictT): boolean {
  if (techItem3 === null) techItem3 = FindItemByClassname("item_tech3");
  return techItem3 !== null && ent.client !== null && ent.client.pers.inventory[ITEM_INDEX(techItem3)] !== 0;
}

export function CTFApplyHasteSound(ent: EdictT): void {
  let volume = 1.0;
  if (ent.client !== null && ent.client.silencer_shots) volume = 0.2;

  if (techItem3 === null) techItem3 = FindItemByClassname("item_tech3");
  if (
    techItem3 !== null &&
    ent.client !== null &&
    ent.client.pers.inventory[ITEM_INDEX(techItem3)] &&
    ent.client.ctf_techsndtime < level.time
  ) {
    ent.client.ctf_techsndtime = level.time + 1;
    gi.sound(ent, CHAN_VOICE, gi.soundindex("ctf/tech3.wav"), volume, ATTN_NORM, 0);
  }
}

export function CTFApplyRegeneration(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  let volume = 1.0;
  if (client.silencer_shots) volume = 0.2;

  if (techItem4 === null) techItem4 = FindItemByClassname("item_tech4");

  let noise = false;
  if (techItem4 !== null && client.pers.inventory[ITEM_INDEX(techItem4)]) {
    if (client.ctf_regentime < level.time) {
      client.ctf_regentime = level.time;
      if (ent.health < 150) {
        ent.health += 5;
        if (ent.health > 150) ent.health = 150;
        client.ctf_regentime += 0.5;
        noise = true;
      }
      const index = ArmorIndex(ent);
      if (index !== 0 && client.pers.inventory[index]! < 150) {
        client.pers.inventory[index] += 5;
        if (client.pers.inventory[index]! > 150) client.pers.inventory[index] = 150;
        client.ctf_regentime += 0.5;
        noise = true;
      }
    }
    if (noise && client.ctf_techsndtime < level.time) {
      client.ctf_techsndtime = level.time + 1;
      gi.sound(ent, CHAN_VOICE, gi.soundindex("ctf/tech4.wav"), volume, ATTN_NORM, 0);
    }
  }
}

export function CTFHasRegeneration(ent: EdictT): boolean {
  if (techItem4 === null) techItem4 = FindItemByClassname("item_tech4");
  return techItem4 !== null && ent.client !== null && ent.client.pers.inventory[ITEM_INDEX(techItem4)] !== 0;
}

/*
======================================================================
SAY_TEAM
======================================================================
*/

// in 'importance order': what items are more important when reporting names
const locNames: { classname: string; priority: number }[] = [
  { classname: "item_flag_team1", priority: 1 },
  { classname: "item_flag_team2", priority: 1 },
  { classname: "item_quad", priority: 2 },
  { classname: "item_invulnerability", priority: 2 },
  { classname: "weapon_bfg", priority: 3 },
  { classname: "weapon_railgun", priority: 4 },
  { classname: "weapon_rocketlauncher", priority: 4 },
  { classname: "weapon_hyperblaster", priority: 4 },
  { classname: "weapon_chaingun", priority: 4 },
  { classname: "weapon_grenadelauncher", priority: 4 },
  { classname: "weapon_machinegun", priority: 4 },
  { classname: "weapon_supershotgun", priority: 4 },
  { classname: "weapon_shotgun", priority: 4 },
  { classname: "item_power_screen", priority: 5 },
  { classname: "item_power_shield", priority: 5 },
  { classname: "item_armor_body", priority: 6 },
  { classname: "item_armor_combat", priority: 6 },
  { classname: "item_armor_jacket", priority: 6 },
  { classname: "item_silencer", priority: 7 },
  { classname: "item_breather", priority: 7 },
  { classname: "item_enviro", priority: 7 },
  { classname: "item_adrenaline", priority: 7 },
  { classname: "item_bandolier", priority: 8 },
  { classname: "item_pack", priority: 8 },
];

function CTFSay_Team_Location(who: EdictT): string {
  let hot: EdictT | null = null;
  let hotdist = 999999;
  // Faithful to the C source's bug: this is initialized as (and, at the
  // bottom of the loop, reassigned to) a loc_names[] array INDEX, even
  // though every other assignment stores a *priority* value -- the two are
  // compared against each other as if they were the same unit.
  let hotindex = 999;
  let hotsee = false;
  let what: EdictT | null = null;

  for (;;) {
    what = loc_findradius(what, who.s.origin, 1024);
    if (what === null) break;
    if (what.classname === null) continue;
    const idx = locNames.findIndex((ln) => ln.classname === what?.classname);
    if (idx < 0) continue;
    const entry = locNames[idx];
    if (entry === undefined) continue;

    const cansee = loc_CanSee(what, who);
    if (cansee && !hotsee) {
      hotsee = true;
      hotindex = entry.priority;
      hot = what;
      const v = vec3();
      VectorSubtract(what.s.origin, who.s.origin, v);
      hotdist = VectorLength(v);
      continue;
    }
    if (hotsee && !cansee) continue;
    if (hotsee && hotindex < entry.priority) continue;

    const v = vec3();
    VectorSubtract(what.s.origin, who.s.origin, v);
    const newdist = VectorLength(v);
    if (newdist < hotdist || (cansee && entry.priority < hotindex)) {
      hot = what;
      hotdist = newdist;
      hotindex = idx;
      hotsee = loc_CanSee(hot, who);
    }
  }

  if (hot === null) return "nowhere";

  let nearteam = -1;
  what = null;
  for (;;) {
    what = G_Find(what, "classname", hot.classname ?? "");
    if (what === null) break;
    if (what === hot) continue;
    const flag1 = G_Find(null, "classname", "item_flag_team1");
    const flag2 = G_Find(null, "classname", "item_flag_team2");
    if (flag1 !== null && flag2 !== null) {
      const v1 = vec3();
      const v2 = vec3();
      VectorSubtract(hot.s.origin, flag1.s.origin, v1);
      const d1 = VectorLength(v1);
      VectorSubtract(hot.s.origin, flag2.s.origin, v2);
      const d2 = VectorLength(v2);
      if (d1 < d2) nearteam = CtfTeamT.CTF_TEAM1;
      else if (d1 > d2) nearteam = CtfTeamT.CTF_TEAM2;
    }
    break;
  }

  const item = hot.classname !== null ? FindItemByClassname(hot.classname) : null;
  if (item === null || item.pickup_name === null) return "nowhere";

  let buf = who.waterlevel !== 0 ? "in the water " : "";

  const v = vec3();
  VectorSubtract(who.s.origin, hot.s.origin, v);
  if (Math.abs(v[2]) > Math.abs(v[0]) && Math.abs(v[2]) > Math.abs(v[1])) buf += v[2] > 0 ? "above " : "below ";
  else buf += "near ";

  if (nearteam === CtfTeamT.CTF_TEAM1) buf += "the red ";
  else if (nearteam === CtfTeamT.CTF_TEAM2) buf += "the blue ";
  else buf += "the ";

  buf += item.pickup_name;
  return buf;
}

function CTFSay_Team_Armor(who: EdictT): string {
  const client = who.client;
  if (client === null) return "no armor";

  let buf = "";

  const power_armor_type = PowerArmorType(who);
  if (power_armor_type !== 0) {
    const cellsItem = FindItem("cells");
    const cells = cellsItem !== null ? client.pers.inventory[ITEM_INDEX(cellsItem)] : 0;
    if (cells) {
      buf += Com_sprintf("%s with %i cells ", power_armor_type === 1 ? "Power Screen" : "Power Shield", cells);
    }
  }

  const index = ArmorIndex(who);
  if (index !== 0) {
    const item = GetItemByIndex(index);
    if (item !== null && item.pickup_name !== null) {
      if (buf.length > 0) buf += "and ";
      buf += Com_sprintf("%i units of %s", client.pers.inventory[index], item.pickup_name);
    }
  }

  if (buf.length === 0) buf = "no armor";
  return buf;
}

function CTFSay_Team_Health(who: EdictT): string {
  return who.health <= 0 ? "dead" : Com_sprintf("%i health", who.health);
}

function CTFSay_Team_Tech(who: EdictT): string {
  if (who.client === null) return "no powerup";
  for (const tname of tnames) {
    const tech = FindItemByClassname(tname);
    if (tech !== null && who.client.pers.inventory[ITEM_INDEX(tech)] && tech.pickup_name !== null) {
      return `the ${tech.pickup_name}`;
    }
  }
  return "no powerup";
}

function CTFSay_Team_Weapon(who: EdictT): string {
  if (who.client !== null && who.client.pers.weapon !== null && who.client.pers.weapon.pickup_name !== null) {
    return who.client.pers.weapon.pickup_name;
  }
  return "none";
}

function CTFSay_Team_Sight(who: EdictT): string {
  let s = "";
  let s2 = "";
  let n = 0;
  const maxclients = cvarNum(gameCvars.maxclients);
  for (let i = 1; i <= maxclients; i++) {
    const targ = g_edicts[i];
    if (!targ.inuse || targ === who || !loc_CanSee(targ, who)) continue;
    if (s2.length > 0) {
      if (s.length + s2.length + 3 < 1024) {
        if (n) s += ", ";
        s += s2;
        s2 = "";
      }
      n++;
    }
    s2 = targ.client !== null ? targ.client.pers.netname : "";
  }
  if (s2.length > 0) {
    if (s.length + s2.length + 6 < 1024) {
      if (n) s += " and ";
      s += s2;
    }
    return s;
  }
  return "no one";
}

export function CTFSay_Team(who: EdictT, msgIn: string): void {
  if (CheckFlood(who)) return;

  let msg = msgIn;
  if (msg.startsWith('"')) {
    msg = msg.slice(1);
    if (msg.endsWith('"')) msg = msg.slice(0, -1);
  }

  // char outmsg[256] in C; the loop bound (sizeof(outmsg)-2) and the
  // per-substitution length check before each append are ported literally
  // even though JS strings don't have a fixed buffer, to keep the truncated
  // output length faithful to 3.21 (3.19/3.20 used a 1024-byte buffer).
  let outmsg = "";
  for (let i = 0; i < msg.length && outmsg.length < 254; i++) {
    const ch = msg[i];
    if (ch === "%") {
      i++;
      const code = msg[i];
      let buf = "";
      switch (code) {
        case "l":
        case "L":
          buf = CTFSay_Team_Location(who);
          break;
        case "a":
        case "A":
          buf = CTFSay_Team_Armor(who);
          break;
        case "h":
        case "H":
          buf = CTFSay_Team_Health(who);
          break;
        case "t":
        case "T":
          buf = CTFSay_Team_Tech(who);
          break;
        case "w":
        case "W":
          buf = CTFSay_Team_Weapon(who);
          break;
        case "n":
        case "N":
          buf = CTFSay_Team_Sight(who);
          break;
        default:
          if (code !== undefined) outmsg += code;
          continue;
      }
      if (buf.length + outmsg.length < 254) outmsg += buf;
    } else if (ch !== undefined) {
      outmsg += ch;
    }
  }

  if (who.client === null) return;
  const maxclients = cvarNum(gameCvars.maxclients);
  for (let i = 0; i < maxclients; i++) {
    const cl_ent = g_edicts[1 + i];
    if (!cl_ent.inuse || cl_ent.client === null) continue;
    if (cl_ent.client.resp.ctf_team === who.client.resp.ctf_team) {
      gi.cprintf(cl_ent, PRINT_CHAT, `(${who.client.pers.netname}): ${outmsg}\n`);
    }
  }
}

/*-----------------------------------------------------------------------*/
/*QUAKED misc_ctf_banner (1 .5 0) (-4 -64 0) (4 64 248) TEAM2
The origin is the bottom of the banner. The banner is 248 tall.
*/
function misc_ctf_banner_think(ent: EdictT): void {
  ent.s.frame = (ent.s.frame + 1) % 16;
  ent.nextthink = level.time + FRAMETIME;
}

export function SP_misc_ctf_banner(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_NOT;
  ent.s.modelindex = gi.modelindex("models/ctf/banner/tris.md2");
  if ((ent.spawnflags & 1) !== 0) ent.s.skinnum = 1;

  ent.s.frame = Math.floor(random() * 16);
  gi.linkentity(ent);

  ent.think = misc_ctf_banner_think;
  ent.nextthink = level.time + FRAMETIME;
}

/*QUAKED misc_ctf_small_banner (1 .5 0) (-4 -32 0) (4 32 124) TEAM2
The origin is the bottom of the banner. The banner is 124 tall.
*/
export function SP_misc_ctf_small_banner(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_NOT;
  ent.s.modelindex = gi.modelindex("models/ctf/banner/small.md2");
  if ((ent.spawnflags & 1) !== 0) ent.s.skinnum = 1;

  ent.s.frame = Math.floor(random() * 16);
  gi.linkentity(ent);

  ent.think = misc_ctf_banner_think;
  ent.nextthink = level.time + FRAMETIME;
}

/*-----------------------------------------------------------------------*/

function SetLevelName(p: PmenuT): void {
  const raw = g_edicts[0].message !== null ? g_edicts[0].message : level.mapname;
  p.text = `*${raw}`.slice(0, 32);
}

/*-----------------------------------------------------------------------*/
/* ELECTIONS */

export function CTFBeginElection(ent: EdictT, type: ElectT, msg: string): boolean {
  if (cvarNum(electpercentage) === 0) {
    gi.cprintf(ent, PRINT_HIGH, "Elections are disabled, only an admin can process this action.\n");
    return false;
  }

  if (ctfgame.election !== ElectT.ELECT_NONE) {
    gi.cprintf(ent, PRINT_HIGH, "Election already in progress.\n");
    return false;
  }

  let count = 0;
  const maxclients = cvarNum(gameCvars.maxclients);
  for (let i = 1; i <= maxclients; i++) {
    const e = g_edicts[i];
    if (e.client !== null) e.client.resp.voted = false;
    if (e.inuse) count++;
  }

  if (count < 2) {
    gi.cprintf(ent, PRINT_HIGH, "Not enough players for election.\n");
    return false;
  }

  ctfgame.etarget = ent;
  ctfgame.election = type;
  ctfgame.evotes = 0;
  ctfgame.needvotes = Math.trunc((count * cvarNum(electpercentage)) / 100);
  ctfgame.electtime = level.time + 20; // twenty seconds for election
  ctfgame.emsg = msg;

  gi.bprintf(PRINT_CHAT, `${ctfgame.emsg}\n`);
  gi.bprintf(PRINT_HIGH, "Type YES or NO to vote on this request.\n");
  gi.bprintf(PRINT_HIGH, `Votes: ${ctfgame.evotes}  Needed: ${ctfgame.needvotes}  Time left: ${Math.trunc(ctfgame.electtime - level.time)}s\n`);

  return true;
}

export function CTFResetAllPlayers(): void {
  const maxclients = cvarNum(gameCvars.maxclients);
  for (let i = 1; i <= maxclients; i++) {
    const ent = g_edicts[i];
    if (!ent.inuse || ent.client === null) continue;

    if (ent.client.menu !== null) PMenu_Close(ent);

    CTFPlayerResetGrapple(ent);
    CTFDeadDropFlag(ent);
    CTFDeadDropTech(ent);

    ent.client.resp.ctf_team = CtfTeamT.CTF_NOTEAM;
    ent.client.resp.ready = false;

    ent.svflags = 0;
    ent.flags &= ~FL_GODMODE;
    PutClientInServer(ent);
  }

  CTFResetTech();
  CTFResetFlags();

  for (let i = 1; i < globals.num_edicts; i++) {
    const ent = g_edicts[i];
    if (ent.inuse && ent.client === null) {
      if (ent.solid === SolidT.SOLID_NOT && ent.think === DoRespawn && ent.nextthink >= level.time) {
        ent.nextthink = 0;
        DoRespawn(ent);
      }
    }
  }
  if (ctfgame.match === MatchT.MATCH_SETUP) ctfgame.matchtime = level.time + cvarNum(matchsetuptime) * 60;
}

export function CTFAssignGhost(ent: EdictT): void {
  if (ent.client === null) return;
  let ghost = 0;
  for (; ghost < MAX_CLIENTS; ghost++) {
    if (ctfgame.ghosts[ghost]?.code === 0) break;
  }
  if (ghost === MAX_CLIENTS) return;

  const g = ctfgame.ghosts[ghost];
  if (g === undefined) return;

  g.team = ent.client.resp.ctf_team;
  g.score = 0;
  for (;;) {
    g.code = 10000 + Math.floor(random() * 90000);
    let i = 0;
    for (; i < MAX_CLIENTS; i++) {
      if (i !== ghost && ctfgame.ghosts[i]?.code === g.code) break;
    }
    if (i === MAX_CLIENTS) break;
  }
  g.ent = ent;
  g.netname = ent.client.pers.netname;
  ent.client.resp.ghost = g;
  gi.cprintf(ent, PRINT_CHAT, `Your ghost code is **** ${g.code} ****\n`);
  gi.cprintf(ent, PRINT_HIGH, `If you lose connection, you can rejoin with your score intact by typing "ghost ${g.code}".\n`);
}

export function CTFStartMatch(): void {
  ctfgame.match = MatchT.MATCH_GAME;
  ctfgame.matchtime = level.time + cvarNum(matchtime) * 60;
  ctfgame.countdown = false;

  ctfgame.team1 = 0;
  ctfgame.team2 = 0;

  ctfgame.ghosts = Array.from({ length: MAX_CLIENTS }, () => new GhostT());

  const maxclients = cvarNum(gameCvars.maxclients);
  for (let i = 1; i <= maxclients; i++) {
    const ent = g_edicts[i];
    if (!ent.inuse || ent.client === null) continue;

    ent.client.resp.score = 0;
    ent.client.resp.ctf_state = 0;
    ent.client.resp.ghost = null;

    gi.centerprintf(ent, "******************\n\nMATCH HAS STARTED!\n\n******************");

    if (ent.client.resp.ctf_team !== CtfTeamT.CTF_NOTEAM) {
      // make up a ghost code
      CTFAssignGhost(ent);
      CTFPlayerResetGrapple(ent);
      ent.svflags = SVF_NOCLIENT;
      ent.flags &= ~FL_GODMODE;

      ent.client.respawn_time = level.time + 1.0 + Math.floor(random() * 30) / 10.0;
      ent.client.ps.pmove.pm_type = PmTypeT.PM_DEAD;
      ent.client.anim_priority = ANIM_DEATH;
      ent.s.frame = FRAME_death308 - 1;
      ent.client.anim_end = FRAME_death308;
      ent.deadflag = DEAD_DEAD;
      ent.movetype = MovetypeT.MOVETYPE_NOCLIP;
      ent.client.ps.gunindex = 0;
      gi.linkentity(ent);
    }
  }
}

export function CTFEndMatch(): void {
  ctfgame.match = MatchT.MATCH_POST;
  gi.bprintf(PRINT_CHAT, "MATCH COMPLETED!\n");

  CTFCalcScores();

  gi.bprintf(PRINT_HIGH, `RED TEAM:  ${ctfgame.team1} captures, ${ctfgame.total1} points\n`);
  gi.bprintf(PRINT_HIGH, `BLUE TEAM:  ${ctfgame.team2} captures, ${ctfgame.total2} points\n`);

  if (ctfgame.team1 > ctfgame.team2) {
    gi.bprintf(PRINT_CHAT, `RED team won over the BLUE team by ${ctfgame.team1 - ctfgame.team2} CAPTURES!\n`);
  } else if (ctfgame.team2 > ctfgame.team1) {
    gi.bprintf(PRINT_CHAT, `BLUE team won over the RED team by ${ctfgame.team2 - ctfgame.team1} CAPTURES!\n`);
  } else if (ctfgame.total1 > ctfgame.total2) {
    gi.bprintf(PRINT_CHAT, `RED team won over the BLUE team by ${ctfgame.total1 - ctfgame.total2} POINTS!\n`);
  } else if (ctfgame.total2 > ctfgame.total1) {
    gi.bprintf(PRINT_CHAT, `BLUE team won over the RED team by ${ctfgame.total2 - ctfgame.total1} POINTS!\n`);
  } else {
    gi.bprintf(PRINT_CHAT, "TIE GAME!\n");
  }

  EndDMLevel();
}

export function CTFNextMap(): boolean {
  if (ctfgame.match === MatchT.MATCH_POST) {
    ctfgame.match = MatchT.MATCH_SETUP;
    CTFResetAllPlayers();
    return true;
  }
  return false;
}

export function CTFWinElection(): void {
  switch (ctfgame.election) {
    case ElectT.ELECT_MATCH:
      if (cvarNum(competition) < 3) gi.cvar_set("competition", "2");
      ctfgame.match = MatchT.MATCH_SETUP;
      CTFResetAllPlayers();
      break;

    case ElectT.ELECT_ADMIN:
      if (ctfgame.etarget !== null && ctfgame.etarget.client !== null) {
        ctfgame.etarget.client.resp.admin = true;
        gi.bprintf(PRINT_HIGH, `${ctfgame.etarget.client.pers.netname} has become an admin.\n`);
        gi.cprintf(ctfgame.etarget, PRINT_HIGH, "Type 'admin' to access the adminstration menu.\n");
      }
      break;

    case ElectT.ELECT_MAP:
      if (ctfgame.etarget !== null && ctfgame.etarget.client !== null) {
        gi.bprintf(PRINT_HIGH, `${ctfgame.etarget.client.pers.netname} is warping to level ${ctfgame.elevel}.\n`);
      }
      level.forcemap = ctfgame.elevel;
      EndDMLevel();
      break;
    default:
      break;
  }
  ctfgame.election = ElectT.ELECT_NONE;
}

export function CTFVoteYes(ent: EdictT): void {
  if (ent.client === null) return;
  if (ctfgame.election === ElectT.ELECT_NONE) {
    gi.cprintf(ent, PRINT_HIGH, "No election is in progress.\n");
    return;
  }
  if (ent.client.resp.voted) {
    gi.cprintf(ent, PRINT_HIGH, "You already voted.\n");
    return;
  }
  if (ctfgame.etarget === ent) {
    gi.cprintf(ent, PRINT_HIGH, "You can't vote for yourself.\n");
    return;
  }

  ent.client.resp.voted = true;

  ctfgame.evotes++;
  if (ctfgame.evotes === ctfgame.needvotes) {
    CTFWinElection();
    return;
  }
  gi.bprintf(PRINT_HIGH, `${ctfgame.emsg}\n`);
  gi.bprintf(PRINT_CHAT, `Votes: ${ctfgame.evotes}  Needed: ${ctfgame.needvotes}  Time left: ${Math.trunc(ctfgame.electtime - level.time)}s\n`);
}

export function CTFVoteNo(ent: EdictT): void {
  if (ent.client === null) return;
  if (ctfgame.election === ElectT.ELECT_NONE) {
    gi.cprintf(ent, PRINT_HIGH, "No election is in progress.\n");
    return;
  }
  if (ent.client.resp.voted) {
    gi.cprintf(ent, PRINT_HIGH, "You already voted.\n");
    return;
  }
  if (ctfgame.etarget === ent) {
    gi.cprintf(ent, PRINT_HIGH, "You can't vote for yourself.\n");
    return;
  }

  ent.client.resp.voted = true;

  gi.bprintf(PRINT_HIGH, `${ctfgame.emsg}\n`);
  gi.bprintf(PRINT_CHAT, `Votes: ${ctfgame.evotes}  Needed: ${ctfgame.needvotes}  Time left: ${Math.trunc(ctfgame.electtime - level.time)}s\n`);
}

export function CTFReady(ent: EdictT): void {
  if (ent.client === null) return;
  if (ent.client.resp.ctf_team === CtfTeamT.CTF_NOTEAM) {
    gi.cprintf(ent, PRINT_HIGH, "Pick a team first (hit <TAB> for menu)\n");
    return;
  }

  if (ctfgame.match !== MatchT.MATCH_SETUP) {
    gi.cprintf(ent, PRINT_HIGH, "A match is not being setup.\n");
    return;
  }

  if (ent.client.resp.ready) {
    gi.cprintf(ent, PRINT_HIGH, "You have already commited.\n");
    return;
  }

  ent.client.resp.ready = true;
  gi.bprintf(PRINT_HIGH, `${ent.client.pers.netname} is ready.\n`);

  let t1 = 0;
  let t2 = 0;
  let j = 0;
  const maxclients = cvarNum(gameCvars.maxclients);
  for (let i = 1; i <= maxclients; i++) {
    const e = g_edicts[i];
    if (!e.inuse || e.client === null) continue;
    if (e.client.resp.ctf_team !== CtfTeamT.CTF_NOTEAM && !e.client.resp.ready) j++;
    if (e.client.resp.ctf_team === CtfTeamT.CTF_TEAM1) t1++;
    else if (e.client.resp.ctf_team === CtfTeamT.CTF_TEAM2) t2++;
  }
  if (j === 0 && t1 !== 0 && t2 !== 0) {
    gi.bprintf(PRINT_CHAT, "All players have commited.  Match starting\n");
    ctfgame.match = MatchT.MATCH_PREGAME;
    ctfgame.matchtime = level.time + cvarNum(matchstarttime);
    ctfgame.countdown = false;
    gi.positioned_sound(world().s.origin, world(), CHAN_AUTO | CHAN_RELIABLE, gi.soundindex("misc/talk1.wav"), 1, ATTN_NONE, 0);
  }
}

export function CTFNotReady(ent: EdictT): void {
  if (ent.client === null) return;
  if (ent.client.resp.ctf_team === CtfTeamT.CTF_NOTEAM) {
    gi.cprintf(ent, PRINT_HIGH, "Pick a team first (hit <TAB> for menu)\n");
    return;
  }

  if (ctfgame.match !== MatchT.MATCH_SETUP && ctfgame.match !== MatchT.MATCH_PREGAME) {
    gi.cprintf(ent, PRINT_HIGH, "A match is not being setup.\n");
    return;
  }

  if (!ent.client.resp.ready) {
    gi.cprintf(ent, PRINT_HIGH, "You haven't commited.\n");
    return;
  }

  ent.client.resp.ready = false;
  gi.bprintf(PRINT_HIGH, `${ent.client.pers.netname} is no longer ready.\n`);

  if (ctfgame.match === MatchT.MATCH_PREGAME) {
    gi.bprintf(PRINT_CHAT, "Match halted.\n");
    ctfgame.match = MatchT.MATCH_SETUP;
    ctfgame.matchtime = level.time + cvarNum(matchsetuptime) * 60;
  }
}

export function CTFGhost(ent: EdictT): void {
  if (ent.client === null) return;
  if (gi.argc() < 2) {
    gi.cprintf(ent, PRINT_HIGH, "Usage:  ghost <code>\n");
    return;
  }

  if (ent.client.resp.ctf_team !== CtfTeamT.CTF_NOTEAM) {
    gi.cprintf(ent, PRINT_HIGH, "You are already in the game.\n");
    return;
  }
  if (ctfgame.match !== MatchT.MATCH_GAME) {
    gi.cprintf(ent, PRINT_HIGH, "No match is in progress.\n");
    return;
  }

  const n = Number.parseInt(gi.argv(1), 10);

  for (let i = 0; i < MAX_CLIENTS; i++) {
    const g = ctfgame.ghosts[i];
    if (g !== undefined && g.code !== 0 && g.code === n) {
      gi.cprintf(ent, PRINT_HIGH, "Ghost code accepted, your position has been reinstated.\n");
      if (g.ent !== null && g.ent.client !== null) g.ent.client.resp.ghost = null;
      ent.client.resp.ctf_team = g.team;
      ent.client.resp.ghost = g;
      ent.client.resp.score = g.score;
      ent.client.resp.ctf_state = 0;
      g.ent = ent;
      ent.svflags = 0;
      ent.flags &= ~FL_GODMODE;
      PutClientInServer(ent);
      gi.bprintf(PRINT_HIGH, `${ent.client.pers.netname} has been reinstated to ${CTFTeamName(ent.client.resp.ctf_team)} team.\n`);
      return;
    }
  }
  gi.cprintf(ent, PRINT_HIGH, "Invalid ghost code.\n");
}

export function CTFMatchSetup(): boolean {
  return ctfgame.match === MatchT.MATCH_SETUP || ctfgame.match === MatchT.MATCH_PREGAME;
}

export function CTFMatchOn(): boolean {
  return ctfgame.match === MatchT.MATCH_GAME;
}

/*-----------------------------------------------------------------------*/

const CTF_STRING_VER = `v${CTF_STRING_VERSION}`;

const jmenu_level = 2;
const jmenu_match = 3;
const jmenu_red = 5;
const jmenu_blue = 7;
const jmenu_chase = 9;
const jmenu_reqmatch = 11;

const creditsmenu: PmenuT[] = [
  new PmenuT("*Quake II", PMENU_ALIGN_CENTER, null),
  new PmenuT("*ThreeWave Capture the Flag", PMENU_ALIGN_CENTER, null),
  new PmenuT(null, PMENU_ALIGN_CENTER, null),
  new PmenuT("*Programming", PMENU_ALIGN_CENTER, null),
  new PmenuT("Dave 'Zoid' Kirsch", PMENU_ALIGN_CENTER, null),
  new PmenuT("*Level Design", PMENU_ALIGN_CENTER, null),
  new PmenuT("Christian Antkow", PMENU_ALIGN_CENTER, null),
  new PmenuT("Tim Willits", PMENU_ALIGN_CENTER, null),
  new PmenuT("Dave 'Zoid' Kirsch", PMENU_ALIGN_CENTER, null),
  new PmenuT("*Art", PMENU_ALIGN_CENTER, null),
  new PmenuT("Adrian Carmack Paul Steed", PMENU_ALIGN_CENTER, null),
  new PmenuT("Kevin Cloud", PMENU_ALIGN_CENTER, null),
  new PmenuT("*Sound", PMENU_ALIGN_CENTER, null),
  new PmenuT("Tom 'Bjorn' Klok", PMENU_ALIGN_CENTER, null),
  new PmenuT("*Original CTF Art Design", PMENU_ALIGN_CENTER, null),
  new PmenuT("Brian 'Whaleboy' Cozzens", PMENU_ALIGN_CENTER, null),
  new PmenuT(null, PMENU_ALIGN_CENTER, null),
  new PmenuT("Return to Main Menu", PMENU_ALIGN_LEFT, CTFReturnToMain),
];

const joinmenu: PmenuT[] = fixedLength("joinmenu", 18, [
  new PmenuT("*Quake II", PMENU_ALIGN_CENTER, null),
  new PmenuT("*ThreeWave Capture the Flag", PMENU_ALIGN_CENTER, null),
  new PmenuT(null, PMENU_ALIGN_CENTER, null),
  new PmenuT(null, PMENU_ALIGN_CENTER, null),
  new PmenuT(null, PMENU_ALIGN_CENTER, null),
  new PmenuT("Join Red Team", PMENU_ALIGN_LEFT, CTFJoinTeam1),
  new PmenuT(null, PMENU_ALIGN_LEFT, null),
  new PmenuT("Join Blue Team", PMENU_ALIGN_LEFT, CTFJoinTeam2),
  new PmenuT(null, PMENU_ALIGN_LEFT, null),
  new PmenuT("Chase Camera", PMENU_ALIGN_LEFT, CTFChaseCam),
  new PmenuT("Credits", PMENU_ALIGN_LEFT, CTFCredits),
  new PmenuT(null, PMENU_ALIGN_LEFT, null),
  new PmenuT(null, PMENU_ALIGN_LEFT, null),
  new PmenuT("Use [ and ] to move cursor", PMENU_ALIGN_LEFT, null),
  new PmenuT("ENTER to select", PMENU_ALIGN_LEFT, null),
  new PmenuT("ESC to Exit Menu", PMENU_ALIGN_LEFT, null),
  new PmenuT("(TAB to Return)", PMENU_ALIGN_LEFT, null),
  new PmenuT(CTF_STRING_VER, PMENU_ALIGN_RIGHT, null),
]);

const nochasemenu: PmenuT[] = [
  new PmenuT("*Quake II", PMENU_ALIGN_CENTER, null),
  new PmenuT("*ThreeWave Capture the Flag", PMENU_ALIGN_CENTER, null),
  new PmenuT(null, PMENU_ALIGN_CENTER, null),
  new PmenuT(null, PMENU_ALIGN_CENTER, null),
  new PmenuT("No one to chase", PMENU_ALIGN_LEFT, null),
  new PmenuT(null, PMENU_ALIGN_CENTER, null),
  new PmenuT("Return to Main Menu", PMENU_ALIGN_LEFT, CTFReturnToMain),
];

export function CTFJoinTeam(ent: EdictT, desired_team: number): void {
  if (ent.client === null) return;
  PMenu_Close(ent);

  ent.svflags &= ~SVF_NOCLIENT;
  ent.client.resp.ctf_team = desired_team;
  ent.client.resp.ctf_state = 0;
  const s = Info_ValueForKey(ent.client.pers.userinfo, "skin");
  CTFAssignSkin(ent, s);

  // assign a ghost if we are in match mode
  if (ctfgame.match === MatchT.MATCH_GAME) {
    if (ent.client.resp.ghost !== null) ent.client.resp.ghost.code = 0;
    ent.client.resp.ghost = null;
    CTFAssignGhost(ent);
  }

  PutClientInServer(ent);
  // add a teleportation effect
  ent.s.event = EntityEventT.EV_PLAYER_TELEPORT;
  // hold in place briefly
  ent.client.ps.pmove.pm_flags = PMF_TIME_TELEPORT;
  ent.client.ps.pmove.pm_time = 14;
  gi.bprintf(PRINT_HIGH, `${ent.client.pers.netname} joined the ${CTFTeamName(desired_team)} team.\n`);

  if (ctfgame.match === MatchT.MATCH_SETUP) {
    gi.centerprintf(ent, '***********************\nType "ready" in console\nto ready up.\n***********************');
  }
}

export function CTFJoinTeam1(ent: EdictT, _p: PmenuHndT): void {
  CTFJoinTeam(ent, CtfTeamT.CTF_TEAM1);
}

export function CTFJoinTeam2(ent: EdictT, _p: PmenuHndT): void {
  CTFJoinTeam(ent, CtfTeamT.CTF_TEAM2);
}

export function CTFChaseCam(ent: EdictT, _p: PmenuHndT): void {
  if (ent.client === null) return;
  if (ent.client.chase_target !== null) {
    ent.client.chase_target = null;
    ent.client.ps.pmove.pm_flags &= ~PMF_NO_PREDICTION;
    PMenu_Close(ent);
    return;
  }

  const maxclients = cvarNum(gameCvars.maxclients);
  for (let i = 1; i <= maxclients; i++) {
    const e = g_edicts[i];
    if (e.inuse && e.solid !== SolidT.SOLID_NOT) {
      ent.client.chase_target = e;
      PMenu_Close(ent);
      ent.client.update_chase = true;
      return;
    }
  }

  const row = nochasemenu[jmenu_level];
  if (row !== undefined) SetLevelName(row);

  PMenu_Close(ent);
  PMenu_Open(ent, nochasemenu, -1, nochasemenu.length, null);
}

export function CTFReturnToMain(ent: EdictT, _p: PmenuHndT): void {
  PMenu_Close(ent);
  CTFOpenJoinMenu(ent);
}

export function CTFRequestMatch(ent: EdictT, _p: PmenuHndT): void {
  if (ent.client === null) return;
  PMenu_Close(ent);
  const text = `${ent.client.pers.netname} has requested to switch to competition mode.`;
  CTFBeginElection(ent, ElectT.ELECT_MATCH, text);
}

export function CTFShowScores(ent: EdictT, _p: PmenuHndT): void {
  if (ent.client === null) return;
  PMenu_Close(ent);
  ent.client.showscores = true;
  ent.client.showinventory = false;
  DeathmatchScoreboard(ent);
}

export function CTFUpdateJoinMenu(ent: EdictT): number {
  const maxclients = cvarNum(gameCvars.maxclients);

  const redRow = joinmenu[jmenu_red];
  const blueRow = joinmenu[jmenu_blue];
  const redCountRow = joinmenu[jmenu_red + 1];
  const blueCountRow = joinmenu[jmenu_blue + 1];
  const chaseRow = joinmenu[jmenu_chase];
  const levelRow = joinmenu[jmenu_level];
  const matchRow = joinmenu[jmenu_match];
  const reqmatchRow = joinmenu[jmenu_reqmatch];

  if (
    redRow === undefined ||
    blueRow === undefined ||
    redCountRow === undefined ||
    blueCountRow === undefined ||
    chaseRow === undefined ||
    levelRow === undefined ||
    matchRow === undefined ||
    reqmatchRow === undefined
  ) {
    return CtfTeamT.CTF_TEAM1;
  }

  if (ctfgame.match >= MatchT.MATCH_PREGAME && cvarNum(matchlock) !== 0) {
    redRow.text = "MATCH IS LOCKED";
    redRow.SelectFunc = null;
    blueRow.text = "  (entry is not permitted)";
    blueRow.SelectFunc = null;
  } else {
    if (ctfgame.match >= MatchT.MATCH_PREGAME) {
      redRow.text = "Join Red MATCH Team";
      blueRow.text = "Join Blue MATCH Team";
    } else {
      redRow.text = "Join Red Team";
      blueRow.text = "Join Blue Team";
    }
    redRow.SelectFunc = CTFJoinTeam1;
    blueRow.SelectFunc = CTFJoinTeam2;
  }

  const forcejoin = cvarStr(ctf_forcejoin);
  if (forcejoin.length > 0) {
    if (Q_stricmp(forcejoin, "red") === 0) {
      blueRow.text = null;
      blueRow.SelectFunc = null;
    } else if (Q_stricmp(forcejoin, "blue") === 0) {
      redRow.text = null;
      redRow.SelectFunc = null;
    }
  }

  chaseRow.text = ent.client !== null && ent.client.chase_target !== null ? "Leave Chase Camera" : "Chase Camera";

  SetLevelName(levelRow);

  let num1 = 0;
  let num2 = 0;
  for (let i = 0; i < maxclients; i++) {
    if (!g_edicts[i + 1].inuse) continue;
    if (game.clients[i].resp.ctf_team === CtfTeamT.CTF_TEAM1) num1++;
    else if (game.clients[i].resp.ctf_team === CtfTeamT.CTF_TEAM2) num2++;
  }

  const team1players = `  (${num1} players)`;
  const team2players = `  (${num2} players)`;

  switch (ctfgame.match) {
    case MatchT.MATCH_NONE:
      matchRow.text = null;
      break;
    case MatchT.MATCH_SETUP:
      matchRow.text = "*MATCH SETUP IN PROGRESS";
      break;
    case MatchT.MATCH_PREGAME:
      matchRow.text = "*MATCH STARTING";
      break;
    case MatchT.MATCH_GAME:
      matchRow.text = "*MATCH IN PROGRESS";
      break;
    default:
      break;
  }

  redCountRow.text = redRow.text !== null ? team1players : null;
  blueCountRow.text = blueRow.text !== null ? team2players : null;

  reqmatchRow.text = null;
  reqmatchRow.SelectFunc = null;
  if (cvarNum(competition) !== 0 && ctfgame.match < MatchT.MATCH_SETUP) {
    reqmatchRow.text = "Request Match";
    reqmatchRow.SelectFunc = CTFRequestMatch;
  }

  if (num1 > num2) return CtfTeamT.CTF_TEAM1;
  if (num2 > num1) return CtfTeamT.CTF_TEAM2;
  return random() < 0.5 ? CtfTeamT.CTF_TEAM1 : CtfTeamT.CTF_TEAM2;
}

export function CTFOpenJoinMenu(ent: EdictT): void {
  let team = CTFUpdateJoinMenu(ent);
  if (ent.client !== null && ent.client.chase_target !== null) team = 8;
  else if (team === CtfTeamT.CTF_TEAM1) team = 4;
  else team = 6;
  PMenu_Open(ent, joinmenu, team, joinmenu.length, null);
}

export function CTFCredits(ent: EdictT, _p: PmenuHndT): void {
  PMenu_Close(ent);
  PMenu_Open(ent, creditsmenu, -1, creditsmenu.length, null);
}

export function CTFStartClient(ent: EdictT): boolean {
  if (ent.client === null) return false;
  if (ent.client.resp.ctf_team !== CtfTeamT.CTF_NOTEAM) return false;

  if ((cvarNum(gameCvars.dmflags) & DF_CTF_FORCEJOIN) === 0 || ctfgame.match >= MatchT.MATCH_SETUP) {
    // start as 'observer'
    ent.movetype = MovetypeT.MOVETYPE_NOCLIP;
    ent.solid = SolidT.SOLID_NOT;
    ent.svflags |= SVF_NOCLIENT;
    ent.client.resp.ctf_team = CtfTeamT.CTF_NOTEAM;
    ent.client.ps.gunindex = 0;
    gi.linkentity(ent);

    CTFOpenJoinMenu(ent);
    return true;
  }
  return false;
}

export function CTFObserver(ent: EdictT): void {
  if (ent.client === null) return;

  // start as 'observer'
  // C: `if (ent->movetype == MOVETYPE_NOCLIP)` with no body/braces --
  // 3.19's early "You are already an observer." return was dropped in 3.21
  // but the `if` was left dangling, so it now binds to only the very next
  // statement (CTFPlayerResetGrapple). An already-observing player skips
  // just that call and falls through to run the rest of this function
  // (including re-opening the join menu) unconditionally. Faithful
  // bug-for-bug port of that dangling-if restructuring.
  if (ent.movetype !== MovetypeT.MOVETYPE_NOCLIP) {
    CTFPlayerResetGrapple(ent);
  }
  CTFDeadDropFlag(ent);
  CTFDeadDropTech(ent);

  ent.deadflag = DEAD_NO;
  ent.movetype = MovetypeT.MOVETYPE_NOCLIP;
  ent.solid = SolidT.SOLID_NOT;
  ent.svflags |= SVF_NOCLIENT;
  ent.client.resp.ctf_team = CtfTeamT.CTF_NOTEAM;
  ent.client.ps.gunindex = 0;
  ent.client.resp.score = 0;
  const userinfo = ent.client.pers.userinfo;
  InitClientPersistant(ent.client);
  ClientUserinfoChanged(ent, userinfo);
  gi.linkentity(ent);
  CTFOpenJoinMenu(ent);
}

export function CTFInMatch(): boolean {
  return ctfgame.match > MatchT.MATCH_NONE;
}

export function CTFCheckRules(): boolean {
  if (ctfgame.election !== ElectT.ELECT_NONE && ctfgame.electtime <= level.time) {
    gi.bprintf(PRINT_CHAT, "Election timed out and has been cancelled.\n");
    ctfgame.election = ElectT.ELECT_NONE;
  }

  if (ctfgame.match !== MatchT.MATCH_NONE) {
    const t = Math.trunc(ctfgame.matchtime - level.time);

    // no team warnings in match mode
    ctfgame.warnactive = 0;

    if (t <= 0) {
      switch (ctfgame.match) {
        case MatchT.MATCH_SETUP:
          if (cvarNum(competition) < 3) {
            ctfgame.match = MatchT.MATCH_NONE;
            gi.cvar_set("competition", "1");
            CTFResetAllPlayers();
          } else {
            ctfgame.matchtime = level.time + cvarNum(matchsetuptime) * 60;
          }
          return false;

        case MatchT.MATCH_PREGAME:
          // match started!
          CTFStartMatch();
          gi.positioned_sound(world().s.origin, world(), CHAN_AUTO | CHAN_RELIABLE, gi.soundindex("misc/tele_up.wav"), 1, ATTN_NONE, 0);
          return false;

        case MatchT.MATCH_GAME:
          // match ended!
          CTFEndMatch();
          gi.positioned_sound(world().s.origin, world(), CHAN_AUTO | CHAN_RELIABLE, gi.soundindex("misc/bigtele.wav"), 1, ATTN_NONE, 0);
          return false;

        default:
          break;
      }
    }

    if (t === ctfgame.lasttime) return false;

    ctfgame.lasttime = t;

    switch (ctfgame.match) {
      case MatchT.MATCH_SETUP: {
        let j = 0;
        const maxclients = cvarNum(gameCvars.maxclients);
        for (let i = 1; i <= maxclients; i++) {
          const ent = g_edicts[i];
          if (!ent.inuse || ent.client === null) continue;
          if (ent.client.resp.ctf_team !== CtfTeamT.CTF_NOTEAM && !ent.client.resp.ready) j++;
        }

        const text =
          cvarNum(competition) < 3
            ? Com_sprintf("%02d:%02d SETUP: %d not ready", Math.trunc(t / 60), t % 60, j)
            : Com_sprintf("SETUP: %d not ready", j);

        gi.configstring(CONFIG_CTF_MATCH, text);
        break;
      }

      case MatchT.MATCH_PREGAME:
        gi.configstring(CONFIG_CTF_MATCH, Com_sprintf("%02d:%02d UNTIL START", Math.trunc(t / 60), t % 60));
        if (t <= 10 && !ctfgame.countdown) {
          ctfgame.countdown = true;
          gi.positioned_sound(world().s.origin, world(), CHAN_AUTO | CHAN_RELIABLE, gi.soundindex("world/10_0.wav"), 1, ATTN_NONE, 0);
        }
        break;

      case MatchT.MATCH_GAME:
        gi.configstring(CONFIG_CTF_MATCH, Com_sprintf("%02d:%02d MATCH", Math.trunc(t / 60), t % 60));
        if (t <= 10 && !ctfgame.countdown) {
          ctfgame.countdown = true;
          gi.positioned_sound(world().s.origin, world(), CHAN_AUTO | CHAN_RELIABLE, gi.soundindex("world/10_0.wav"), 1, ATTN_NONE, 0);
        }
        break;

      default:
        break;
    }
    return false;
  } else {
    // this is only done in non-match (public) mode
    if (level.time === ctfgame.lasttime) return false;
    ctfgame.lasttime = Math.trunc(level.time);

    if (cvarNum(warn_unbalanced) !== 0) {
      // count up the team totals
      let team1 = 0;
      let team2 = 0;
      const maxclients = cvarNum(gameCvars.maxclients);
      for (let i = 1; i <= maxclients; i++) {
        const ent = g_edicts[i];
        if (!ent.inuse || ent.client === null) continue;
        if (ent.client.resp.ctf_team === CtfTeamT.CTF_TEAM1) team1++;
        else if (ent.client.resp.ctf_team === CtfTeamT.CTF_TEAM2) team2++;
      }

      if (team1 - team2 >= 2 && team2 >= 2) {
        if (ctfgame.warnactive !== CtfTeamT.CTF_TEAM1) {
          ctfgame.warnactive = CtfTeamT.CTF_TEAM1;
          gi.configstring(CONFIG_CTF_TEAMINFO, "WARNING: Red has too many players");
        }
      } else if (team2 - team1 >= 2 && team1 >= 2) {
        if (ctfgame.warnactive !== CtfTeamT.CTF_TEAM2) {
          ctfgame.warnactive = CtfTeamT.CTF_TEAM2;
          gi.configstring(CONFIG_CTF_TEAMINFO, "WARNING: Blue has too many players");
        }
      } else {
        ctfgame.warnactive = 0;
      }
    } else {
      ctfgame.warnactive = 0;
    }
  }

  const capturelimitVal = cvarNum(gameCvars.capturelimit);
  if (capturelimitVal !== 0 && (ctfgame.team1 >= capturelimitVal || ctfgame.team2 >= capturelimitVal)) {
    gi.bprintf(PRINT_HIGH, "Capturelimit hit.\n");
    return true;
  }
  return false;
}

/*--------------------------------------------------------------------------
 * just here to help old map conversions
 *--------------------------------------------------------------------------*/

function old_teleporter_touch(self: EdictT, other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  if (other.client === null) return;
  const dest = G_Find(null, "targetname", self.target ?? "");
  if (dest === null) {
    gi.dprintf("Couldn't find destination\n");
    return;
  }

  CTFPlayerResetGrapple(other);

  // unlink to make sure it can't possibly interfere with KillBox
  gi.unlinkentity(other);

  VectorCopy(dest.s.origin, other.s.origin);
  VectorCopy(dest.s.origin, other.s.old_origin);

  // clear the velocity and hold them in place briefly
  VectorClear(other.velocity);
  other.client.ps.pmove.pm_time = 160 >> 3; // hold time
  other.client.ps.pmove.pm_flags |= PMF_TIME_TELEPORT;

  // draw the teleport splash at source and on the player
  if (self.enemy !== null) self.enemy.s.event = EntityEventT.EV_PLAYER_TELEPORT;
  other.s.event = EntityEventT.EV_PLAYER_TELEPORT;

  // set angles
  for (let i = 0; i < 3; i++) {
    other.client.ps.pmove.delta_angles[i] = ANGLE2SHORT(dest.s.angles[i] - other.client.resp.cmd_angles[i]);
  }

  other.s.angles[PITCH] = 0;
  other.s.angles[YAW] = dest.s.angles[YAW];
  other.s.angles[ROLL] = 0;
  VectorCopy(dest.s.angles, other.client.ps.viewangles);
  VectorCopy(dest.s.angles, other.client.v_angle);

  // give a little forward velocity
  const forward = vec3();
  AngleVectors(other.client.v_angle, forward, null, null);
  VectorScale(forward, 200, other.velocity);

  // kill anything at the destination
  KillBox(other);

  gi.linkentity(other);
}

/*QUAKED trigger_teleport (0.5 0.5 0.5) ?
Players touching this will be teleported
*/
export function SP_trigger_teleport(ent: EdictT): void {
  if (ent.target === null) {
    gi.dprintf("teleporter without a target.\n");
    G_FreeEdict(ent);
    return;
  }

  ent.svflags |= SVF_NOCLIENT;
  ent.solid = SolidT.SOLID_TRIGGER;
  ent.touch = old_teleporter_touch;
  if (ent.model !== null) gi.setmodel(ent, ent.model);
  gi.linkentity(ent);

  // noise maker and splash effect dude
  const s = G_Spawn();
  ent.enemy = s;
  for (let i = 0; i < 3; i++) {
    s.s.origin[i] = ent.mins[i] + (ent.maxs[i] - ent.mins[i]) / 2;
  }
  s.s.sound = gi.soundindex("world/hum1.wav");
  gi.linkentity(s);
}

/*QUAKED info_teleport_destination (0.5 0.5 0.5) (-16 -16 -24) (16 16 32)
Point trigger_teleports at these.
*/
export function SP_info_teleport_destination(ent: EdictT): void {
  ent.s.origin[2] += 16;
}

/*----------------------------------------------------------------------------------*/
/* ADMIN */

class AdminSettingsT {
  matchlen = 0;
  matchsetuplen = 0;
  matchstartlen = 0;
  weaponsstay = false;
  instantitems = false;
  quaddrop = false;
  instantweap = false;
  matchlock = false;
}

function settingsOf(p: PmenuHndT): AdminSettingsT {
  if (!(p.arg instanceof AdminSettingsT)) {
    throw new Error("CTFAdmin: menu handle is missing its AdminSettingsT arg");
  }
  return p.arg;
}

export function CTFAdmin_SettingsApply(ent: EdictT, p: PmenuHndT): void {
  if (ent.client === null) return;
  const settings = settingsOf(p);
  const dmflags = cvarNum(gameCvars.dmflags);

  if (settings.matchlen !== cvarNum(matchtime)) {
    gi.bprintf(PRINT_HIGH, `${ent.client.pers.netname} changed the match length to ${settings.matchlen} minutes.\n`);
    if (ctfgame.match === MatchT.MATCH_GAME) {
      ctfgame.matchtime = ctfgame.matchtime - cvarNum(matchtime) * 60 + settings.matchlen * 60;
    }
    gi.cvar_set("matchtime", String(settings.matchlen));
  }

  if (settings.matchsetuplen !== cvarNum(matchsetuptime)) {
    gi.bprintf(PRINT_HIGH, `${ent.client.pers.netname} changed the match setup time to ${settings.matchsetuplen} minutes.\n`);
    if (ctfgame.match === MatchT.MATCH_SETUP) {
      ctfgame.matchtime = ctfgame.matchtime - cvarNum(matchsetuptime) * 60 + settings.matchsetuplen * 60;
    }
    gi.cvar_set("matchsetuptime", String(settings.matchsetuplen));
  }

  if (settings.matchstartlen !== cvarNum(matchstarttime)) {
    gi.bprintf(PRINT_HIGH, `${ent.client.pers.netname} changed the match start time to ${settings.matchstartlen} seconds.\n`);
    if (ctfgame.match === MatchT.MATCH_PREGAME) {
      ctfgame.matchtime = ctfgame.matchtime - cvarNum(matchstarttime) + settings.matchstartlen;
    }
    gi.cvar_set("matchstarttime", String(settings.matchstartlen));
  }

  if (settings.weaponsstay !== ((dmflags & DF_WEAPONS_STAY) !== 0)) {
    gi.bprintf(PRINT_HIGH, `${ent.client.pers.netname} turned ${settings.weaponsstay ? "on" : "off"} weapons stay.\n`);
    let i = dmflags;
    if (settings.weaponsstay) i |= DF_WEAPONS_STAY;
    else i &= ~DF_WEAPONS_STAY;
    gi.cvar_set("dmflags", String(i));
  }

  if (settings.instantitems !== ((dmflags & DF_INSTANT_ITEMS) !== 0)) {
    gi.bprintf(PRINT_HIGH, `${ent.client.pers.netname} turned ${settings.instantitems ? "on" : "off"} instant items.\n`);
    let i = dmflags;
    if (settings.instantitems) i |= DF_INSTANT_ITEMS;
    else i &= ~DF_INSTANT_ITEMS;
    gi.cvar_set("dmflags", String(i));
  }

  if (settings.quaddrop !== ((dmflags & DF_QUAD_DROP) !== 0)) {
    gi.bprintf(PRINT_HIGH, `${ent.client.pers.netname} turned ${settings.quaddrop ? "on" : "off"} quad drop.\n`);
    let i = dmflags;
    if (settings.quaddrop) i |= DF_QUAD_DROP;
    else i &= ~DF_QUAD_DROP;
    gi.cvar_set("dmflags", String(i));
  }

  if (settings.instantweap !== (cvarNum(gameCvars.instantweap) !== 0)) {
    gi.bprintf(PRINT_HIGH, `${ent.client.pers.netname} turned ${settings.instantweap ? "on" : "off"} instant weapons.\n`);
    gi.cvar_set("instantweap", settings.instantweap ? "1" : "0");
  }

  if (settings.matchlock !== (cvarNum(matchlock) !== 0)) {
    gi.bprintf(PRINT_HIGH, `${ent.client.pers.netname} turned ${settings.matchlock ? "on" : "off"} match lock.\n`);
    gi.cvar_set("matchlock", settings.matchlock ? "1" : "0");
  }

  PMenu_Close(ent);
  CTFOpenAdminMenu(ent);
}

export function CTFAdmin_SettingsCancel(ent: EdictT, _p: PmenuHndT): void {
  PMenu_Close(ent);
  CTFOpenAdminMenu(ent);
}

export function CTFAdmin_ChangeMatchLen(ent: EdictT, p: PmenuHndT): void {
  const settings = settingsOf(p);
  settings.matchlen = (settings.matchlen % 60) + 5;
  if (settings.matchlen < 5) settings.matchlen = 5;
  CTFAdmin_UpdateSettings(ent, p);
}

export function CTFAdmin_ChangeMatchSetupLen(ent: EdictT, p: PmenuHndT): void {
  const settings = settingsOf(p);
  settings.matchsetuplen = (settings.matchsetuplen % 60) + 5;
  if (settings.matchsetuplen < 5) settings.matchsetuplen = 5;
  CTFAdmin_UpdateSettings(ent, p);
}

export function CTFAdmin_ChangeMatchStartLen(ent: EdictT, p: PmenuHndT): void {
  const settings = settingsOf(p);
  settings.matchstartlen = (settings.matchstartlen % 600) + 10;
  if (settings.matchstartlen < 20) settings.matchstartlen = 20;
  CTFAdmin_UpdateSettings(ent, p);
}

export function CTFAdmin_ChangeWeapStay(ent: EdictT, p: PmenuHndT): void {
  const settings = settingsOf(p);
  settings.weaponsstay = !settings.weaponsstay;
  CTFAdmin_UpdateSettings(ent, p);
}

export function CTFAdmin_ChangeInstantItems(ent: EdictT, p: PmenuHndT): void {
  const settings = settingsOf(p);
  settings.instantitems = !settings.instantitems;
  CTFAdmin_UpdateSettings(ent, p);
}

export function CTFAdmin_ChangeQuadDrop(ent: EdictT, p: PmenuHndT): void {
  const settings = settingsOf(p);
  settings.quaddrop = !settings.quaddrop;
  CTFAdmin_UpdateSettings(ent, p);
}

export function CTFAdmin_ChangeInstantWeap(ent: EdictT, p: PmenuHndT): void {
  const settings = settingsOf(p);
  settings.instantweap = !settings.instantweap;
  CTFAdmin_UpdateSettings(ent, p);
}

export function CTFAdmin_ChangeMatchLock(ent: EdictT, p: PmenuHndT): void {
  const settings = settingsOf(p);
  settings.matchlock = !settings.matchlock;
  CTFAdmin_UpdateSettings(ent, p);
}

export function CTFAdmin_UpdateSettings(ent: EdictT, setmenu: PmenuHndT): void {
  const settings = settingsOf(setmenu);

  const entryAt = (idx: number): PmenuT | null => setmenu.entries[idx] ?? null;

  let i = 2;
  const e1 = entryAt(i);
  if (e1 !== null) PMenu_UpdateEntry(e1, `Match Len:       ${Com_sprintf("%2d", settings.matchlen)} mins`, PMENU_ALIGN_LEFT, CTFAdmin_ChangeMatchLen);
  i++;
  const e2 = entryAt(i);
  if (e2 !== null) {
    PMenu_UpdateEntry(e2, `Match Setup Len: ${Com_sprintf("%2d", settings.matchsetuplen)} mins`, PMENU_ALIGN_LEFT, CTFAdmin_ChangeMatchSetupLen);
  }
  i++;
  const e3 = entryAt(i);
  if (e3 !== null) {
    PMenu_UpdateEntry(e3, `Match Start Len: ${Com_sprintf("%2d", settings.matchstartlen)} secs`, PMENU_ALIGN_LEFT, CTFAdmin_ChangeMatchStartLen);
  }
  i++;
  const e4 = entryAt(i);
  if (e4 !== null) PMenu_UpdateEntry(e4, `Weapons Stay:    ${settings.weaponsstay ? "Yes" : "No"}`, PMENU_ALIGN_LEFT, CTFAdmin_ChangeWeapStay);
  i++;
  const e5 = entryAt(i);
  if (e5 !== null) PMenu_UpdateEntry(e5, `Instant Items:   ${settings.instantitems ? "Yes" : "No"}`, PMENU_ALIGN_LEFT, CTFAdmin_ChangeInstantItems);
  i++;
  const e6 = entryAt(i);
  if (e6 !== null) PMenu_UpdateEntry(e6, `Quad Drop:       ${settings.quaddrop ? "Yes" : "No"}`, PMENU_ALIGN_LEFT, CTFAdmin_ChangeQuadDrop);
  i++;
  const e7 = entryAt(i);
  if (e7 !== null) PMenu_UpdateEntry(e7, `Instant Weapons: ${settings.instantweap ? "Yes" : "No"}`, PMENU_ALIGN_LEFT, CTFAdmin_ChangeInstantWeap);
  i++;
  const e8 = entryAt(i);
  if (e8 !== null) PMenu_UpdateEntry(e8, `Match Lock:      ${settings.matchlock ? "Yes" : "No"}`, PMENU_ALIGN_LEFT, CTFAdmin_ChangeMatchLock);

  PMenu_Update(ent);
}

const def_setmenu: PmenuT[] = [
  new PmenuT("*Settings Menu", PMENU_ALIGN_CENTER, null),
  new PmenuT(null, PMENU_ALIGN_CENTER, null),
  new PmenuT(null, PMENU_ALIGN_LEFT, null), // matchlen
  new PmenuT(null, PMENU_ALIGN_LEFT, null), // matchsetuplen
  new PmenuT(null, PMENU_ALIGN_LEFT, null), // matchstartlen
  new PmenuT(null, PMENU_ALIGN_LEFT, null), // weaponsstay
  new PmenuT(null, PMENU_ALIGN_LEFT, null), // instantitems
  new PmenuT(null, PMENU_ALIGN_LEFT, null), // quaddrop
  new PmenuT(null, PMENU_ALIGN_LEFT, null), // instantweap
  new PmenuT(null, PMENU_ALIGN_LEFT, null), // matchlock
  new PmenuT(null, PMENU_ALIGN_LEFT, null),
  new PmenuT("Apply", PMENU_ALIGN_LEFT, CTFAdmin_SettingsApply),
  new PmenuT("Cancel", PMENU_ALIGN_LEFT, CTFAdmin_SettingsCancel),
];

export function CTFAdmin_Settings(ent: EdictT, _p: PmenuHndT): void {
  PMenu_Close(ent);

  const settings = new AdminSettingsT();
  settings.matchlen = Math.trunc(cvarNum(matchtime));
  settings.matchsetuplen = Math.trunc(cvarNum(matchsetuptime));
  settings.matchstartlen = Math.trunc(cvarNum(matchstarttime));
  const dmflags = cvarNum(gameCvars.dmflags);
  settings.weaponsstay = (dmflags & DF_WEAPONS_STAY) !== 0;
  settings.instantitems = (dmflags & DF_INSTANT_ITEMS) !== 0;
  settings.quaddrop = (dmflags & DF_QUAD_DROP) !== 0;
  settings.instantweap = cvarNum(gameCvars.instantweap) !== 0;
  settings.matchlock = cvarNum(matchlock) !== 0;

  const menu = PMenu_Open(ent, def_setmenu, -1, def_setmenu.length, settings);
  if (menu !== null) CTFAdmin_UpdateSettings(ent, menu);
}

export function CTFAdmin_MatchSet(ent: EdictT, _p: PmenuHndT): void {
  PMenu_Close(ent);

  if (ctfgame.match === MatchT.MATCH_SETUP) {
    gi.bprintf(PRINT_CHAT, "Match has been forced to start.\n");
    ctfgame.match = MatchT.MATCH_PREGAME;
    ctfgame.matchtime = level.time + cvarNum(matchstarttime);
    gi.positioned_sound(world().s.origin, world(), CHAN_AUTO | CHAN_RELIABLE, gi.soundindex("misc/talk1.wav"), 1, ATTN_NONE, 0);
    ctfgame.countdown = false;
  } else if (ctfgame.match === MatchT.MATCH_GAME) {
    gi.bprintf(PRINT_CHAT, "Match has been forced to terminate.\n");
    ctfgame.match = MatchT.MATCH_SETUP;
    ctfgame.matchtime = level.time + cvarNum(matchsetuptime) * 60;
    CTFResetAllPlayers();
  }
}

export function CTFAdmin_MatchMode(ent: EdictT, _p: PmenuHndT): void {
  PMenu_Close(ent);

  if (ctfgame.match !== MatchT.MATCH_SETUP) {
    if (cvarNum(competition) < 3) gi.cvar_set("competition", "2");
    ctfgame.match = MatchT.MATCH_SETUP;
    CTFResetAllPlayers();
  }
}

export function CTFAdmin_Reset(ent: EdictT, _p: PmenuHndT): void {
  PMenu_Close(ent);

  // go back to normal mode
  gi.bprintf(PRINT_CHAT, "Match mode has been terminated, reseting to normal game.\n");
  ctfgame.match = MatchT.MATCH_NONE;
  gi.cvar_set("competition", "1");
  CTFResetAllPlayers();
}

export function CTFAdmin_Cancel(ent: EdictT, _p: PmenuHndT): void {
  PMenu_Close(ent);
}

const adminmenu: PmenuT[] = [
  new PmenuT("*Administration Menu", PMENU_ALIGN_CENTER, null),
  new PmenuT(null, PMENU_ALIGN_CENTER, null),
  new PmenuT("Settings", PMENU_ALIGN_LEFT, CTFAdmin_Settings),
  new PmenuT(null, PMENU_ALIGN_LEFT, null),
  new PmenuT(null, PMENU_ALIGN_LEFT, null),
  new PmenuT("Cancel", PMENU_ALIGN_LEFT, CTFAdmin_Cancel),
  new PmenuT(null, PMENU_ALIGN_CENTER, null),
];

export function CTFOpenAdminMenu(ent: EdictT): void {
  const row = adminmenu[3];
  const row4 = adminmenu[4];
  if (row !== undefined) {
    row.text = null;
    row.SelectFunc = null;
  }
  if (row4 !== undefined) {
    row4.text = null;
    row4.SelectFunc = null;
  }
  if (row !== undefined && row4 !== undefined) {
    if (ctfgame.match === MatchT.MATCH_SETUP) {
      row.text = "Force start match";
      row.SelectFunc = CTFAdmin_MatchSet;
      row4.text = "Reset to pickup mode";
      row4.SelectFunc = CTFAdmin_Reset;
    } else if (ctfgame.match === MatchT.MATCH_GAME || ctfgame.match === MatchT.MATCH_PREGAME) {
      row.text = "Cancel match";
      row.SelectFunc = CTFAdmin_MatchSet;
    } else if (ctfgame.match === MatchT.MATCH_NONE && cvarNum(competition) !== 0) {
      row.text = "Switch to match mode";
      row.SelectFunc = CTFAdmin_MatchMode;
    }
  }

  PMenu_Open(ent, adminmenu, -1, adminmenu.length, null);
}

export function CTFAdmin(ent: EdictT): void {
  if (ent.client === null) return;

  if (cvarNum(allow_admin) === 0) {
    gi.cprintf(ent, PRINT_HIGH, "Administration is disabled\n");
    return;
  }

  const pw = cvarStr(admin_password);
  if (gi.argc() > 1 && pw.length > 0 && !ent.client.resp.admin && pw === gi.argv(1)) {
    ent.client.resp.admin = true;
    gi.bprintf(PRINT_HIGH, `${ent.client.pers.netname} has become an admin.\n`);
    gi.cprintf(ent, PRINT_HIGH, "Type 'admin' to access the adminstration menu.\n");
  }

  if (!ent.client.resp.admin) {
    const text = `${ent.client.pers.netname} has requested admin rights.`;
    CTFBeginElection(ent, ElectT.ELECT_ADMIN, text);
    return;
  }

  if (ent.client.menu !== null) PMenu_Close(ent);

  CTFOpenAdminMenu(ent);
}

/*----------------------------------------------------------------*/

export function CTFStats(ent: EdictT): void {
  let text = "";
  if (ctfgame.match === MatchT.MATCH_SETUP) {
    const maxclients = cvarNum(gameCvars.maxclients);
    for (let i = 1; i <= maxclients; i++) {
      const e2 = g_edicts[i];
      if (!e2.inuse || e2.client === null) continue;
      if (!e2.client.resp.ready && e2.client.resp.ctf_team !== CtfTeamT.CTF_NOTEAM) {
        const st = `${e2.client.pers.netname} is not ready.\n`;
        if (text.length + st.length < 1024 - 50) text += st;
      }
    }
  }

  let ghostIndex = 0;
  for (; ghostIndex < MAX_CLIENTS; ghostIndex++) {
    if (ctfgame.ghosts[ghostIndex]?.ent !== null && ctfgame.ghosts[ghostIndex] !== undefined) break;
  }

  if (ghostIndex === MAX_CLIENTS) {
    if (text.length > 0) gi.cprintf(ent, PRINT_HIGH, text);
    gi.cprintf(ent, PRINT_HIGH, "No statistics available.\n");
    return;
  }

  text += "  #|Name            |Score|Kills|Death|BasDf|CarDf|Effcy|\n";

  for (let i = 0; i < MAX_CLIENTS; i++) {
    const g = ctfgame.ghosts[i];
    if (g === undefined || g.netname.length === 0) continue;

    const e = g.deaths + g.kills === 0 ? 50 : Math.trunc((g.kills * 100) / (g.kills + g.deaths));
    const st = Com_sprintf(
      "%3d|%-16.16s|%5d|%5d|%5d|%5d|%5d|%4d%%|\n",
      g.number,
      g.netname,
      g.score,
      g.kills,
      g.deaths,
      g.basedef,
      g.carrierdef,
      e,
    );
    if (text.length + st.length > 1024 - 50) {
      text += "And more...\n";
      gi.cprintf(ent, PRINT_HIGH, text);
      return;
    }
    text += st;
  }
  gi.cprintf(ent, PRINT_HIGH, text);
}

// The C source also builds (and then immediately discards, via `*text = 0`)
// a "not ready" listing here identical to CTFStats' -- provably dead code
// since its output is overwritten before use. Omitted rather than
// transcribed verbatim; see this unit's report for the full note.
export function CTFPlayerList(ent: EdictT): void {
  let text = "";

  const maxclients = cvarNum(gameCvars.maxclients);
  for (let i = 0; i < maxclients; i++) {
    const e2 = g_edicts[i + 1];
    if (!e2.inuse || e2.client === null) continue;

    const st = Com_sprintf(
      "%3d %-16.16s %02d:%02d %4d %3d%s%s\n",
      i + 1,
      e2.client.pers.netname,
      Math.trunc((level.framenum - e2.client.resp.enterframe) / 600),
      Math.trunc(((level.framenum - e2.client.resp.enterframe) % 600) / 10),
      e2.client.ping,
      e2.client.resp.score,
      ctfgame.match === MatchT.MATCH_SETUP || ctfgame.match === MatchT.MATCH_PREGAME
        ? e2.client.resp.ready
          ? " (ready)"
          : " (notready)"
        : "",
      e2.client.resp.admin ? " (admin)" : "",
    );
    if (text.length + st.length > 1400 - 50) {
      text += "And more...\n";
      gi.cprintf(ent, PRINT_HIGH, text);
      return;
    }
    text += st;
  }
  gi.cprintf(ent, PRINT_HIGH, text);
}

export function CTFWarp(ent: EdictT): void {
  if (ent.client === null) return;
  const list = cvarStr(warp_list);

  if (gi.argc() < 2) {
    gi.cprintf(ent, PRINT_HIGH, "Where do you want to warp to?\n");
    gi.cprintf(ent, PRINT_HIGH, `Available levels are: ${list}\n`);
    return;
  }

  const tokens = list.split(/[ \t\n\r]+/).filter((tok) => tok.length > 0);
  const target = gi.argv(1);
  const found = tokens.find((tok) => Q_stricmp(tok, target) === 0);

  if (found === undefined) {
    gi.cprintf(ent, PRINT_HIGH, "Unknown CTF level.\n");
    gi.cprintf(ent, PRINT_HIGH, `Available levels are: ${list}\n`);
    return;
  }

  if (ent.client.resp.admin) {
    gi.bprintf(PRINT_HIGH, `${ent.client.pers.netname} is warping to level ${target}.\n`);
    level.forcemap = target;
    EndDMLevel();
    return;
  }

  const text = `${ent.client.pers.netname} has requested warping to level ${target}.`;
  if (CTFBeginElection(ent, ElectT.ELECT_MAP, text)) ctfgame.elevel = target;
}

export function CTFBoot(ent: EdictT): void {
  if (ent.client === null) return;
  if (!ent.client.resp.admin) {
    gi.cprintf(ent, PRINT_HIGH, "You are not an admin.\n");
    return;
  }

  if (gi.argc() < 2) {
    gi.cprintf(ent, PRINT_HIGH, "Who do you want to kick?\n");
    return;
  }

  const arg1 = gi.argv(1);
  const firstChar = arg1.charAt(0);
  // faithful to the C source: this condition (`< '0' && > '9'`) can never
  // be true, so this check is a no-op in the original too.
  if (firstChar < "0" && firstChar > "9") {
    gi.cprintf(ent, PRINT_HIGH, "Specify the player number to kick.\n");
    return;
  }

  const i = Number.parseInt(arg1, 10);
  const maxclients = cvarNum(gameCvars.maxclients);
  if (i < 1 || i > maxclients) {
    gi.cprintf(ent, PRINT_HIGH, "Invalid player number.\n");
    return;
  }

  const targ = g_edicts[i];
  if (!targ.inuse) {
    gi.cprintf(ent, PRINT_HIGH, "That player number is not connected.\n");
    return;
  }

  gi.AddCommandString(`kick ${i - 1}\n`);
}

export function CTFSetPowerUpEffect(ent: EdictT, def: number): void {
  if (ent.client === null) return;
  if (ent.client.resp.ctf_team === CtfTeamT.CTF_TEAM1) ent.s.effects |= EF_PENT; // red
  else if (ent.client.resp.ctf_team === CtfTeamT.CTF_TEAM2) ent.s.effects |= EF_QUAD; // red
  else ent.s.effects |= def;
}
