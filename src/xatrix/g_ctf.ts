// g_ctf.c (ThreeWave Capture the Flag) -- ONLY the flag world-logic slice
// this port needs: info_player_team1/2, misc_ctf_banner,
// misc_ctf_small_banner, and the flag pickup/drop/reset/return think
// functions the item_flag_team1/item_flag_team2 itemlist rows (owned by
// another unit, added to g_items.ts) reference by name.
//
// Deliberately NOT ported (out of this unit's SCOPE -- see the port
// report): the match/election/admin system (CtfGameT's match/countdown/
// election fields, CTFBeginElection, CTFStartMatch, CTFAdmin_*, the
// pmenu-driven join/admin menus), the grapple hook, tech powerups,
// CTFAssignTeam/SelectCTFSpawnPoint (deathmatch spawn-point selection),
// CTFFragBonuses/CTFCheckHurtCarrier (combat scoring hooks that live in
// g_combat.ts, owned by another unit), CTFEffects (per-frame carried-flag
// player effects, wired from p_client.ts's per-frame code, owned by
// another unit), and CTFScoreboardMessage/CTFCalcScores (HUD, p_hud.ts).
// None of those are needed to spawn or resolve this unit's 25 classnames.
// A minimal replacement for the parts of `ctfgame_t` that CTFPickup_Flag
// actually touches (the capture counters/timestamps) is kept as a small
// local holder, `ctfFlagState`, instead of pulling in the full match
// scaffold that reads the rest of that struct.

import { AngleVectors, random, vec3, VectorAdd, VectorCopy, VectorScale, VectorSet } from "../shared/math";
import {
  ATTN_NONE,
  ATTN_NORM,
  CHAN_NO_PHS_ADD,
  CHAN_RELIABLE,
  CHAN_VOICE,
  type CplaneT,
  type CsurfaceT,
  EntityEventT,
  MASK_SOLID,
  PRINT_HIGH,
  RF_GLOW,
} from "../shared/q_shared";
import { SolidT, SVF_NOCLIENT } from "./game";
import {
  DROPPED_ITEM,
  type EdictT,
  FL_RESPAWN,
  FRAMETIME,
  g_edicts,
  gameCvars,
  gi,
  type GItemT,
  globals,
  IT_TECH,
  level,
  MovetypeT,
} from "./g_local";
import { ArmorIndex, Drop_Item, FindItemByClassname, ITEM_INDEX, Touch_Item } from "./g_items";
import { G_Find, G_FreeEdict, G_Spawn, tv, vtos } from "./g_utils";
import { registerSaveFunction } from "./g_save";

function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

export enum CtfTeamT {
  CTF_NOTEAM,
  CTF_TEAM1,
  CTF_TEAM2,
}

export const CTF_CAPTURE_BONUS = 15;
export const CTF_TEAM_BONUS = 10;
export const CTF_RECOVERY_BONUS = 1;
export const CTF_FLAG_BONUS = 0;
export const CTF_RETURN_FLAG_ASSIST_BONUS = 1;
export const CTF_FRAG_CARRIER_ASSIST_BONUS = 2;
export const CTF_RETURN_FLAG_ASSIST_TIMEOUT = 10;
export const CTF_FRAG_CARRIER_ASSIST_TIMEOUT = 10;
export const CTF_AUTO_FLAG_RETURN_TIMEOUT = 30;

let flag1_item: GItemT | null = null;
let flag2_item: GItemT | null = null;

// Minimal stand-in for the capture-count/timestamp fields of the C
// `ctfgame_t` (g_ctf.c file-scope global) that CTFPickup_Flag touches. The
// full struct also carries match/election/warmup state this unit does not
// port (see the file header) -- resolving all of `ctfgame_t` is left to
// whichever unit ports the rest of g_ctf.c's match system.
const ctfFlagState = { team1: 0, team2: 0, last_flag_capture: 0, last_capture_team: CtfTeamT.CTF_NOTEAM as number };

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

  if (flag1_item === null) flag1_item = FindItemByClassname("item_flag_team1");
  if (flag2_item === null) flag2_item = FindItemByClassname("item_flag_team2");
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

        ctfFlagState.last_flag_capture = level.time;
        ctfFlagState.last_capture_team = ctf_team;
        if (ctf_team === CtfTeamT.CTF_TEAM1) ctfFlagState.team1++;
        else ctfFlagState.team2++;

        gi.sound(ent, CHAN_RELIABLE + CHAN_NO_PHS_ADD + CHAN_VOICE, gi.soundindex("ctf/flagcap.wav"), 1, ATTN_NONE, 0);

        other.client.resp.score += CTF_CAPTURE_BONUS;
        if (other.client.resp.ghost !== null) other.client.resp.ghost.caps++;

        for (let i = 1; i <= maxclients; i++) {
          const player = g_edicts[i];
          if (player === undefined || !player.inuse || player.client === null) continue;

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

// Called from PlayerDie, to drop the flag from a dying player. PlayerDie
// lives in p_client.ts, owned by another unit -- exported here for them to
// call, matching src/ctf/p_client.ts's own call site.
export function CTFDeadDropFlag(self: EdictT): void {
  if (self.client === null) return;
  if (flag1_item === null) flag1_item = FindItemByClassname("item_flag_team1");
  if (flag2_item === null) flag2_item = FindItemByClassname("item_flag_team2");
  if (flag1_item === null || flag2_item === null) return;

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

// Called by SpawnItem (g_items.ts, owned by another unit) for
// item_flag_team1/item_flag_team2, matching src/ctf/g_items.ts's own
// `ent.think = CTFFlagSetup;` special case -- see the port report for the
// exact hook that unit needs to add.
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

//==========================================================
// info_player_team1 / info_player_team2 -- CTF team spawn points.
//==========================================================

/*QUAKED info_player_team1 (1 0 0) (-16 -16 -24) (16 16 32)
potential team1 spawning position for ctf games
*/
export function SP_info_player_team1(_self: EdictT): void {}

/*QUAKED info_player_team2 (0 0 1) (-16 -16 -24) (16 16 32)
potential team2 spawning position for ctf games
*/
export function SP_info_player_team2(_self: EdictT): void {}

//==========================================================
// misc_ctf_banner / misc_ctf_small_banner
//==========================================================

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

// -------------------------------------------------------------------------
// Savegame function registry -- see g_save.ts's registerSaveFunction.
// -------------------------------------------------------------------------
registerSaveFunction("g_ctf:CTFDropFlagTouch", CTFDropFlagTouch);
registerSaveFunction("g_ctf:CTFDropFlagThink", CTFDropFlagThink);
registerSaveFunction("g_ctf:CTFFlagThink", CTFFlagThink);
registerSaveFunction("g_ctf:CTFFlagSetup", CTFFlagSetup);
registerSaveFunction("g_ctf:misc_ctf_banner_think", misc_ctf_banner_think);

/*--------------------------------------------------------------------------*/
/* TECH                                                                     */
/*--------------------------------------------------------------------------*/
//
// RERELEASE CONTENT PORT -- ctf/g_ctf.c's tech-powerup subsystem, ported
// here on an explicit ownership handoff from the agent that originally
// created this file (its header comment above still says techs are out of
// scope; that is now stale and is corrected by this block). The four
// item_tech1..item_tech4 itemlist rows live in g_items.ts.
//
// Transcribed from src/ctf/g_ctf.ts, which is itself a faithful port of
// ctf/g_ctf.c. The one structural note carried over from there: the C uses
// an independent function-local `static gitem_t *tech` cache per function
// (six separate caches for two tech types); those are consolidated into one
// module cache per tech classname below, since FindItemByClassname is
// idempotent and the extra per-function caches had no observable effect.

// ctf/g_ctf.h: `#define DF_CTF_NO_TECH 524288` (a CTF-only dmflags bit).
export const DF_CTF_NO_TECH = 524288;
export const CTF_TECH_TIMEOUT = 60; // seconds before techs move around

const tnames = ["item_tech1", "item_tech2", "item_tech3", "item_tech4"];

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
    if (ent !== undefined && ent.inuse && ent.item !== null && (ent.item.flags & IT_TECH) !== 0) G_FreeEdict(ent);
  }
  SpawnTechs(null);
}

let techItem1: GItemT | null = null; // item_tech1 (resistance)
let techItem2: GItemT | null = null; // item_tech2 (strength)
let techItem3: GItemT | null = null; // item_tech3 (haste)
let techItem4: GItemT | null = null; // item_tech4 (regeneration)

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
      if (ent.client.quad_framenum > level.framenum) {
        gi.sound(ent, CHAN_VOICE, gi.soundindex("ctf/tech2x.wav"), volume, ATTN_NORM, 0);
      } else {
        gi.sound(ent, CHAN_VOICE, gi.soundindex("ctf/tech2.wav"), volume, ATTN_NORM, 0);
      }
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
      if (index !== 0 && client.pers.inventory[index] < 150) {
        client.pers.inventory[index] += 5;
        if (client.pers.inventory[index] > 150) client.pers.inventory[index] = 150;
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

registerSaveFunction("g_ctf:TechThink", TechThink);
registerSaveFunction("g_ctf:SpawnTechs", SpawnTechs);
