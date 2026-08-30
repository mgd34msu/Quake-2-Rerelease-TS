// Ports lmctf60/gslog.c + gslog.h -- the higher-level "GibStats Logging"
// API game code actually calls (sl_GameStart/sl_GameEnd/
// sl_WriteStdLogDeath/sl_WriteStdLogPlayerEntered/sl_LogPlayerDisconnect),
// built on stdlog.ts's low-level line writer.
//
// STATUS: complete. Every function in gslog.c is ported: sl_Logging,
// sl_GameStart, sl_GameEnd, sl_WriteStdLogDeath, sl_WriteStdLogPlayerEntered,
// sl_LogPlayerDisconnect.
//
// DEVIATION (interface-only, not logic): gslog.h/stdlog.h's C signatures
// take `game_import_t *gi` and `level_locals_t level` as explicit
// parameters -- unusual for this mod's own code, where `gi`/`level` are
// always the ambient globals declared in g_local.h, but consistent with
// GibStats/StdLog being third-party logging code dropped into the mod
// unchanged (its own header comments call it a "Public header file").
// Every other file in this entire port accesses `gi`/`level` as the
// g_local.ts singleton, never as parameters; since there is exactly one
// `gi`/`level` instance in this port (same as in the real engine, where
// every call site passed the identical live pointers anyway), passing them
// as parameters vs. importing the shared singleton is byte-identical
// observable behavior -- the FIDELITY RAZOR (rule 17) calls this an
// interface simplification, not a logic change, and it matches this
// codebase's own consistent convention everywhere else. stdlog.ts made the
// same call for the same reason; see its header comment too.

import { type EdictT, gameCvars, gi, level, meansOfDeathHolder, MOD_FRIENDLY_FIRE } from "./g_local";
import {
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
  MOD_GRENADE,
  MOD_G_SPLASH,
  MOD_HANDGRENADE,
  MOD_HELD_GRENADE,
  MOD_HG_SPLASH,
  MOD_HYPERBLASTER,
  MOD_LAVA,
  MOD_MACHINEGUN,
  MOD_RAILGUN,
  MOD_ROCKET,
  MOD_R_SPLASH,
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
} from "./g_local";
import { sl_CloseLogFile, sl_LogDate, sl_LogDeathFlags, sl_LogGameEnd, sl_LogGameStart, sl_LogMapName, sl_LogPatch, sl_LogPlayerConnect, sl_LogPlayerLeft, sl_LogScore, sl_LogTime, sl_LogVers, sl_OpenLogFile } from "./stdlog";

// gslog.c:24-25
let fWasAlreadyOpen = false;
let pPatch: string | null = null; // PatchName - Should never change

/*
=================
sl_Logging (lmctf60/gslog.c:27)
=================
*/
export function sl_Logging(pPatchName: string | null): boolean {
  const fFileOpen = sl_OpenLogFile();

  if (fFileOpen && !fWasAlreadyOpen) {
    const deathflags = gi.cvar("dmflags", "0", 4 /* CVAR_SERVERINFO */);

    sl_LogVers();

    pPatch = pPatchName;
    sl_LogPatch(pPatchName);

    sl_LogDate();
    sl_LogTime();
    sl_LogDeathFlags(deathflags !== null ? deathflags.value >>> 0 : 0);

    fWasAlreadyOpen = fFileOpen;
  }

  return fFileOpen;
}

/*
=================
sl_GameStart (lmctf60/gslog.c:51)
=================
*/
export function sl_GameStart(): void {
  if (sl_Logging(pPatch)) {
    // log name of map
    sl_LogMapName(level.level_name);

    // start counting frags
    sl_LogGameStart(level.time);
  }
}

/*
=================
sl_GameEnd (lmctf60/gslog.c:64)
=================
*/
export function sl_GameEnd(): void {
  if (sl_Logging(pPatch)) {
    sl_LogGameEnd(level.time);
    sl_CloseLogFile();

    fWasAlreadyOpen = false;
  }
}

/*
=================
sl_WriteStdLogDeath (lmctf60/gslog.c:77)

StdLogging for Deathmatch only. Classifies the death as a weapon suicide
(attacker == self), a no-weapon suicide (falling/crushing/drowning/
lava/slime/explosion/laser/blaster-target/generic MOD_SPLASH-family), or a
kill by another player, then logs one score line. Falls through to an
"ERROR" score line outside deathmatch (the C source's own "default - not
multplayer" comment and typo, preserved verbatim as a string literal, not
a code comment).
=================
*/
export function sl_WriteStdLogDeath(self: EdictT, _inflictor: EdictT, attacker: EdictT | null): void {
  // StdLogging for Deathmatch only
  if (gameCvars.deathmatch !== null && gameCvars.deathmatch.value !== 0) {
    if (sl_Logging(pPatch)) {
      const mod = meansOfDeathHolder.meansOfDeath & ~MOD_FRIENDLY_FIRE;
      let pKillerName: string | null = null;
      let pTargetName: string | null = null;
      let pScoreType: string | null = null; // Kill, Suicide
      let pWeaponName: string | null = null;
      let iScore = 0; // 1, -1

      if (attacker === self) {
        // Suicide - weapon
        if (self.client === null) {
          throw new Error("sl_WriteStdLogDeath: self.client is null (lmctf60/gslog.c:99 dereferences self->client unconditionally)");
        }
        pKillerName = self.client.pers.netname;
        pScoreType = "Suicide";
        iScore = -1;

        // Get weapon name, being very careful - mdavies
        // This weapon may not have been the weapon used if the weapon was changed before the death
        pWeaponName = attacker.client !== null && attacker.client.pers.weapon !== null ? attacker.client.pers.weapon.pickup_name : null;
      } else {
        let fSuicide = false;

        // Suicide - no weapon
        switch (mod) {
          case MOD_FALLING:
            pWeaponName = "Fell";
            fSuicide = true;
            break;
          case MOD_CRUSH:
            pWeaponName = "Crushed";
            fSuicide = true;
            break;
          case MOD_WATER:
            pWeaponName = "Drowned";
            fSuicide = true;
            break;
          case MOD_SLIME:
            pWeaponName = "Melted";
            fSuicide = true;
            break;
          case MOD_LAVA:
            pWeaponName = "Lava";
            fSuicide = true;
            break;
          case MOD_BOMB:
          case MOD_EXPLOSIVE:
          case MOD_BARREL:
            pWeaponName = "Explosion";
            fSuicide = true;
            break;
          case MOD_TARGET_LASER:
            pWeaponName = "Lasered";
            fSuicide = true;
            break;
          case MOD_TARGET_BLASTER:
            pWeaponName = "Blasted";
            fSuicide = true;
            break;
          case MOD_SPLASH:
          case MOD_TRIGGER_HURT:
          case MOD_EXIT:
          case MOD_SUICIDE:
            fSuicide = true;
            break;
          default:
            break;
        }

        if (fSuicide) {
          if (self.client === null) {
            throw new Error("sl_WriteStdLogDeath: self.client is null (lmctf60/gslog.c:177 dereferences self->client unconditionally)");
          }
          pKillerName = self.client.pers.netname;
          pScoreType = "Suicide";
          iScore = -1;
        }
      }

      if (pKillerName === null || pScoreType === null) {
        // Kills
        if (attacker !== null && attacker.client !== null) {
          switch (mod) {
            case MOD_TELEFRAG: {
              // Kill - weapon
              if (self.client === null) {
                throw new Error("sl_WriteStdLogDeath: self.client is null (lmctf60/gslog.c:227 dereferences self->client unconditionally)");
              }
              pTargetName = self.client.pers.netname;
              pKillerName = attacker.client.pers.netname;
              pScoreType = "Kill";
              iScore = 1;

              // Set weapon name - mdavies
              pWeaponName = "Telefrag";
              break;
            }
            case MOD_BLASTER:
            case MOD_SHOTGUN:
            case MOD_SSHOTGUN:
            case MOD_MACHINEGUN:
            case MOD_CHAINGUN:
            case MOD_GRENADE:
            case MOD_G_SPLASH:
            case MOD_ROCKET:
            case MOD_R_SPLASH:
            case MOD_HYPERBLASTER:
            case MOD_RAILGUN:
            case MOD_BFG_LASER:
            case MOD_BFG_BLAST:
            case MOD_BFG_EFFECT:
            case MOD_HANDGRENADE:
            case MOD_HG_SPLASH:
            case MOD_HELD_GRENADE:
            default: {
              // Kill - weapon
              if (self.client === null) {
                throw new Error("sl_WriteStdLogDeath: self.client is null (lmctf60/gslog.c:213 dereferences self->client unconditionally)");
              }
              pTargetName = self.client.pers.netname;
              pKillerName = attacker.client.pers.netname;
              pScoreType = "Kill";
              iScore = 1;

              // Get weapon name, being very careful - mdavies
              // This weapon may not have been the weapon used if the weapon was changed before the death
              pWeaponName = attacker.client.pers.weapon !== null ? attacker.client.pers.weapon.pickup_name : null;
              break;
            }
          }
        }
      }

      // Log a score
      sl_LogScore(pKillerName, pTargetName, pScoreType, pWeaponName, iScore, level.time);

      return;
    }
  }

  // default - not multplayer
  // Death - Not Logged
  sl_LogScore("", "", "ERROR", "", 0, level.time);
}

/*
=================
sl_WriteStdLogPlayerEntered (lmctf60/gslog.c:265)
=================
*/
export function sl_WriteStdLogPlayerEntered(ent: EdictT): void {
  if (sl_Logging(pPatch) && ent.client !== null) {
    sl_LogPlayerConnect(ent.client.pers.netname, null, level.time);
  }
}

/*
=================
sl_LogPlayerDisconnect (lmctf60/gslog.c:278)
=================
*/
export function sl_LogPlayerDisconnect(ent: EdictT): void {
  // GSLogMod Start: Player disconnected
  if (sl_Logging(pPatch) && ent.client !== null) {
    sl_LogPlayerLeft(ent.client.pers.netname, level.time);
  }
}
