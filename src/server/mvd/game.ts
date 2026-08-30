// server/mvd/game.c -- the "MVD dummy client" observation layer: turns a
// parsed MvdChannelT's raw state into an observer-facing view.
//
// SCOPE (unit-tested, not network-served): the real mvd_game.c is a full
// GAME-API-shaped module (game_export_t mvd_ge) that lets locally/GTV-
// connected spectator clients join a channel, chase a player, request
// scoreboards/layouts, and issue admin commands (MVD_SwitchChannel,
// MVD_BroadcastPrintf, the LAYOUT_* menu system in client.h). None of that
// networking/UI plumbing is ported here -- this module is the one load-
// bearing piece the task brief calls out as testable "at unit scope": taking
// a channel's raw per-slot player/entity arrays and producing the same
// observable summary a real spectator's scoreboard would be built from
// (which player slots are active, their origin/health/frags, which entities
// are visible). MVD_UpdateClients/MVD_SetPlayerNames/MVD_LinkEdict (the
// per-observer network fan-out) are not ported; there is no observer
// networking path in this scope, only the data-shaping step that would feed
// one.

import type { MvdChannelT } from "./client";
import { STAT_HEALTH, STAT_FRAGS } from "../../shared/q_shared";

export interface MvdPlayerSnapshotT {
  clientNum: number;
  origin: readonly [number, number, number];
  viewangles: readonly [number, number, number];
  health: number;
  frags: number;
}

export interface MvdEntitySnapshotT {
  number: number;
  origin: readonly [number, number, number];
  modelindex: number;
}

export interface MvdSnapshotT {
  gamedir: string;
  mapname: string;
  framenum: number;
  players: MvdPlayerSnapshotT[];
  entities: MvdEntitySnapshotT[];
}

/*
==============
MVD_Snapshot

Builds the observer-facing summary of a channel's current state -- every
active player slot's origin/viewangles/health/frags, and every active
entity's origin/modelindex. `mapname` is read from the channel's own
configstrings (CS_NAME, matching how a real client derives the level name
from configstring 0) rather than tracked separately.
==============
*/
export function MVD_Snapshot(channel: MvdChannelT): MvdSnapshotT {
  const players: MvdPlayerSnapshotT[] = [];
  for (let i = 0; i < channel.players.length; i++) {
    const ps = channel.players[i];
    if (!ps) continue;
    players.push({
      clientNum: i,
      origin: [ps.pmove.origin[0], ps.pmove.origin[1], ps.pmove.origin[2]],
      viewangles: [ps.viewangles[0], ps.viewangles[1], ps.viewangles[2]],
      health: ps.stats[STAT_HEALTH] ?? 0,
      frags: ps.stats[STAT_FRAGS] ?? 0,
    });
  }

  const entities: MvdEntitySnapshotT[] = [];
  for (let i = 1; i < channel.entities.length; i++) {
    const es = channel.entities[i];
    if (!es) continue;
    entities.push({
      number: es.number,
      origin: [es.origin[0], es.origin[1], es.origin[2]],
      modelindex: es.modelindex,
    });
  }

  return {
    gamedir: channel.gamedir,
    mapname: channel.configstrings[0] ?? "",
    framenum: channel.framenum,
    players,
    entities,
  };
}
