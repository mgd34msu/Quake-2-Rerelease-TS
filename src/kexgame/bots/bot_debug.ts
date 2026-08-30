// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// bot_debug.cpp (177 lines, 2023 Quake II re-release / "KEX" engine),
// ported from ~/Projects/quake2-rerelease-dll/rerelease/bots/bot_debug.cpp:
// ShowMonsterPathToPlayer/UpdateFollowActorDebug/UpdateMoveToPointDebug/
// Bot_UpdateDebug -- dev-only path/goal visualization reached through
// `Bot_UpdateDebug()`'s own `sv_cheats`/`g_debug_monster_paths`/
// `bot_debug_follow_actor`/`bot_debug_move_to_point` cvar guards, all of
// which default off (see g_main.ts's own cvar registration for each).
//
// ============================================================================
// Bot_UpdateDebug's call site -- g_main.ts's G_RunFrame_ now calls the real
// thing
// ============================================================================
// g_main.cpp:829 calls `Bot_UpdateDebug()` unconditionally, once per frame,
// from `G_RunFrame_` -- squarely the call site g_main.ts's own header
// documented as "bots subsystem not ported (no src/kexgame/ home); genuine
// no-op" while this file didn't exist. Now that it does, g_main.ts's
// `G_RunFrame_` is updated to call the real `Bot_UpdateDebug` (see that
// file's own updated header for the exact diff). This is a real behavioral
// wire-up, but a safe one for this port's default-cvar boot path:
// `Bot_UpdateDebug`'s own first line (`if (!sv_cheats->integer) return;`,
// ported below) returns immediately whenever `cheats` is at its registered
// default of `"0"` -- the case for every fixture/boot scenario this port
// line exercises.
//
// ============================================================================
// `sv_cheats` reads the cvar named "cheats", NOT "sv_cheats"
// ============================================================================
// The real C++ variable is named `sv_cheats` but is registered under the
// STRING "cheats" (g_main.cpp:270: `sv_cheats = gi.cvar("cheats", ...)`,
// ported in g_main.ts's own InitGame as `gi.cvar("cheats", "0",
// CvarFlagsT.CVAR_SERVERINFO | CvarFlagsT.CVAR_LATCH)`). This file's own
// `cvarBool("cheats", ...)` read below uses that same real name so it
// observes the actual registered cvar. NOTE FOR THE COORDINATOR: g_cmds.ts
// has three existing `cvarInt("sv_cheats", "0")` call sites (its own
// `god_f`/`immortal_f`/`notarget_f` guards) that read a DIFFERENT,
// never-registered cvar named literally "sv_cheats" instead of "cheats" --
// an apparent pre-existing bug in that file, out of this unit's scope to
// fix, flagged here only because it's the same cvar this file also reads.
//
// ============================================================================
// gi.Bot_FollowActor / gi.Bot_MoveToPoint / gi.GetPathToGoal / gi.Draw_Point
// / gi.Draw_Bounds -- already typed, called as-is
// ============================================================================
// kexapi/game.ts's own header already documents `PathRequest`/`PathInfo`/
// `GoalReturnCode`/`ShadowLightDataT` as "the codebase['s]" real typed
// surface for this exact subsystem; every function this file calls off
// `gi` (`Bot_FollowActor`, `Bot_MoveToPoint`, `GetPathToGoal`, `Draw_Point`,
// `Draw_Bounds`, `frame_time_s`) is already a real, present member of
// `KexGameImports` -- nothing new needed there.
//
// ============================================================================
// DEVIATIONS
// ============================================================================
// - `std::array<vec3_t, 512> pathPoints` (ShowMonsterPathToPlayer's raw
//   path-point buffer): ported as a plain `Vec3[]` pre-filled with 512
//   fresh `vec3()` entries, matching `PathRequestPathArray.array`'s own
//   documented `Vec3[] | null` shape (kexapi/game.ts) -- `gi.GetPathToGoal`
//   writes into these entries in place exactly like the C++ array.

import { vec3, vec3_origin, type Vec3 } from "../../shared/math";
import {
  CvarFlagsT,
  ContentsT,
  MASK_PROJECTILE,
  ButtonT,
  GoalReturnCode,
  PathFlags,
  PathLinkType,
  PathReturnCode,
  type PathRequest,
  type PathInfo,
  rgba_yellow,
  rgba_cyan,
} from "../../kexapi/game";
import type { EdictT } from "../g_local";
import { gi } from "../g_main_globals";
import { AngleVectors, vec3_add, vec3_muls } from "../q_vec3";
import { FindLocalPlayer, FindFirstBot, FindFirstMonster, FindActorUnderCrosshair } from "./bot_utils";

// ---------------------------------------------------------------------------
// cvar-read helper (see p_view.ts's/g_combat.ts's own precedent for this
// exact idiom)
// ---------------------------------------------------------------------------

function cvarFloat(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): number {
  const c = gi.cvar(name, def, flags);
  return c === null ? Number(def) : c.value;
}

function cvarInt(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): number {
  return Math.trunc(cvarFloat(name, def, flags));
}

function cvarBool(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): boolean {
  return cvarInt(name, def, flags) !== 0;
}

// ---------------------------------------------------------------------------
// module-scope statics -- bot_debug.cpp:8-15 file-scope statics
// ---------------------------------------------------------------------------

let escortBot: EdictT | null = null;
let escortActor: EdictT | null = null;

let moveToPointBot: EdictT | null = null;
let moveToPointPos: Vec3 = vec3_origin;

/** bot_debug.cpp:15: `constexpr float moveToPointTolerance = 16.0f;`. */
const moveToPointTolerance = 16.0;

function giTraceline(start: Vec3, end: Vec3, passent: EdictT | null, mask: ContentsT) {
  return gi.trace(start, null, null, end, passent, mask);
}

// ---------------------------------------------------------------------------
// ShowMonsterPathToPlayer -- bot_debug.cpp:22-52
// ---------------------------------------------------------------------------

export function ShowMonsterPathToPlayer(player: EdictT): void {
  const monster = FindFirstMonster();
  if (monster === null) return;

  const moveDist = 8.0;

  const pathPoints: Vec3[] = Array.from({ length: 512 }, () => vec3());

  const request: PathRequest = {
    start: monster.s.origin,
    goal: player.s.origin,
    moveDist,
    pathFlags: PathFlags.All,
    debugging: { drawTime: 0.1 },
    nodeSearch: { ignoreNodeFlags: false, minHeight: 64.0, maxHeight: 64.0, radius: 512.0 },
    traversals: { dropHeight: 0, jumpHeight: 0 },
    pathPoints: { array: pathPoints, count: pathPoints.length },
  };

  const info: PathInfo = {
    numPathPoints: 0,
    pathDistSqr: 0,
    firstMovePoint: vec3(),
    secondMovePoint: vec3(),
    pathLinkType: PathLinkType.Walk,
    returnCode: PathReturnCode.StartPathErrors,
  };

  if (gi.GetPathToGoal(request, info)) {
    // Do movement stuff....
    for (let i = 0; i < info.numPathPoints; ++i) {
      const point = pathPoints[i];
      gi.Draw_Point(point, 8.0, rgba_yellow, 0.1, false);
    }
  }
}

// ---------------------------------------------------------------------------
// UpdateFollowActorDebug -- bot_debug.cpp:70-95
// ---------------------------------------------------------------------------

/**
 * Set cvar "bot_debug_follow_actor" to 1 and then run your cursor over any
 * player/monster to pick that "actor" for the bot to follow.
 *
 * When successful, you will see the player/monster highlighted with a
 * yellow box, and the bot will follow them around the map until the actor
 * they're following dies, or the bot is told to do something else by you.
 *
 * Check the console for debugging feedback...
 */
export function UpdateFollowActorDebug(localPlayer: EdictT): void {
  if (cvarInt("bot_debug_follow_actor", "0") !== 0) {
    if (cvarInt("bot_debug_follow_actor", "0") === 1) {
      escortBot = FindFirstBot();
      escortActor = FindActorUnderCrosshair(localPlayer);

      if (gi.Bot_FollowActor(escortBot, escortActor) !== GoalReturnCode.Error) {
        gi.cvar_set("bot_debug_follow_actor", "2");
        gi.Com_Print("Follow_Actor: Bot Found Actor To Follow!\n");
      } else {
        gi.Com_Print("Follow_Actor: Hover Over Monster/Player To Follow...\n");
      }
    } else {
      if (gi.Bot_FollowActor(escortBot, escortActor) !== GoalReturnCode.Error) {
        if (escortActor === null || escortBot === null) throw new Error("UpdateFollowActorDebug: escortActor/escortBot null on a non-Error FollowActor result (invariant violated)");
        gi.Draw_Bounds(escortActor.absmin, escortActor.absmax, rgba_yellow, gi.frame_time_s, false);
        gi.Draw_Bounds(escortBot.absmin, escortBot.absmax, rgba_cyan, gi.frame_time_s, false);
      } else {
        gi.Com_Print("Follow_Actor: Bot Or Actor Removed...\n");
        gi.cvar_set("bot_debug_follow_actor", "0");
      }
    }
  } else {
    escortBot = null;
    escortActor = null;
  }
}

// ---------------------------------------------------------------------------
// UpdateMoveToPointDebug -- bot_debug.cpp:115-154
// ---------------------------------------------------------------------------

/**
 * Set cvar "bot_debug_move_to_point" to 1, look anywhere in world you'd
 * like the bot to move to, and then fire your weapon. The point at the end
 * of your crosshair will be the point in the world the bot will move
 * toward.
 *
 * When successful, a point marker will be drawn where the bot will move
 * toward, and the bot itself will have a box drawn around it.
 *
 * Once bot reaches the point, it will clear the goal and go about it's
 * business until you give it something else to do.
 *
 * Check the console for debugging feedback...
 */
export function UpdateMoveToPointDebug(localPlayer: EdictT): void {
  if (cvarInt("bot_debug_move_to_point", "0") !== 0) {
    if (cvarInt("bot_debug_move_to_point", "0") === 1) {
      if (localPlayer.client === null) throw new Error("UpdateMoveToPointDebug: localPlayer.client is null (invariant violated)");

      if ((localPlayer.client.buttons & ButtonT.BUTTON_ATTACK) !== 0) {
        const localPlayerForward = vec3();
        AngleVectors(localPlayer.client.v_angle, localPlayerForward, null, null);

        const localPlayerViewPos = vec3_add(localPlayer.s.origin, vec3(0, 0, localPlayer.viewheight));
        const end = vec3_add(localPlayerViewPos, vec3_muls(localPlayerForward, 8192.0));
        const mask: ContentsT = MASK_PROJECTILE & ~ContentsT.CONTENTS_DEADMONSTER;

        const tr = giTraceline(localPlayerViewPos, end, localPlayer, mask);
        moveToPointPos = tr.endpos;

        moveToPointBot = FindFirstBot();
        if (gi.Bot_MoveToPoint(moveToPointBot, moveToPointPos, moveToPointTolerance) !== GoalReturnCode.Error) {
          gi.cvar_set("bot_debug_move_to_point", "2");
          gi.Com_Print("Move_To_Point: Bot Has Position To Move Toward!\n");
        }
      } else {
        gi.Com_Print("Move_To_Point: Fire Weapon To Select Move Point...\n");
      }
    } else {
      const result = gi.Bot_MoveToPoint(moveToPointBot, moveToPointPos, moveToPointTolerance);
      if (result === GoalReturnCode.Error) {
        gi.cvar_set("bot_debug_move_to_point", "0");
        gi.Com_Print("Move_To_Point: Bot Can't Reach Goal Position!\n");
      } else if (result === GoalReturnCode.Finished) {
        gi.cvar_set("bot_debug_move_to_point", "0");
        gi.Com_Print("Move_To_Point: Bot Reached Goal Position!\n");
      } else {
        if (moveToPointBot === null) throw new Error("UpdateMoveToPointDebug: moveToPointBot null on a non-terminal MoveToPoint result (invariant violated)");
        gi.Draw_Point(moveToPointPos, 8.0, rgba_yellow, gi.frame_time_s, false);
        gi.Draw_Bounds(moveToPointBot.absmin, moveToPointBot.absmax, rgba_cyan, gi.frame_time_s, false);
      }
    }
  } else {
    moveToPointBot = null;
    moveToPointPos = vec3_origin;
  }
}

// ---------------------------------------------------------------------------
// Bot_UpdateDebug -- bot_debug.cpp:161-178
// ---------------------------------------------------------------------------

export function Bot_UpdateDebug(): void {
  if (!cvarBool("cheats", "0", CvarFlagsT.CVAR_SERVERINFO | CvarFlagsT.CVAR_LATCH)) return;

  const localPlayer = FindLocalPlayer();
  if (localPlayer === null) return;

  if (cvarInt("g_debug_monster_paths", "0") === 2) {
    ShowMonsterPathToPlayer(localPlayer);
  }

  UpdateFollowActorDebug(localPlayer);

  UpdateMoveToPointDebug(localPlayer);
}
