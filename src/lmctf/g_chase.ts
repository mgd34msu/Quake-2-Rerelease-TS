// g_chase.c
//
// lmctf60/g_chase.c is a substantial rewrite of the ctf ancestor's
// chase-cam code: UpdateChaseCam's goal-finding trace is redone entirely
// (single trace + fractional-avoidance instead of the ctf version's
// three-trace floor/ceiling padding), and a death-cam view mode is added
// (PM_DEAD with a fixed roll/pitch and killer_yaw when the chase target
// is dead). ChaseNext/ChasePrev/GetChaseTarget gain LM_CTF's team-based
// observer restriction ("bat"-tagged in the C source): an observer whose
// own ctf.teamnum is CTF_TEAM_OBSERVER_RED or CTF_TEAM_OBSERVER_BLUE may
// only chase players on the matching CTF_TEAM_RED/CTF_TEAM_BLUE team.
// Team_Observer_OK is new in this file (no ctf/rogue ancestor).

import { AngleVectors, vec3, vec3_origin, VectorCopy, VectorMA, VectorSubtract } from "../shared/math";
import { ANGLE2SHORT, MASK_SOLID, PITCH as _PITCH, PmTypeT, PMF_NO_PREDICTION, ROLL, YAW } from "../shared/q_shared";
import { CTF_TEAM_BLUE, CTF_TEAM_OBSERVER_BLUE, CTF_TEAM_OBSERVER_RED, CTF_TEAM_RED } from "./g_ctffunc";
import { type EdictT, g_edicts, gameCvars, gi } from "./g_local";

function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

// The "bat" team-restriction filter shared verbatim (three times, per the
// C source) by ChaseNext/ChasePrev/GetChaseTarget: an observer locked to
// CTF_TEAM_OBSERVER_RED/BLUE may only see players on the matching team.
// `e.client === null` cannot happen for the C source's dereference
// (g_edicts[1..maxclients] always have an allocated client in the
// original engine), but this port's EdictT models it as nullable
// (matching src/lmctf/g_ctffunc.ts's ctf_findplayer/ctf_validateplayer
// convention) -- treated as "does not match the wanted team" so such an
// edict is skipped rather than dereferenced.
function chaseTeamBlocks(chaseTeam: number, e: EdictT): boolean {
  const teamnum = e.client === null ? null : e.client.ctf.teamnum;
  if (chaseTeam === CTF_TEAM_OBSERVER_RED && teamnum !== CTF_TEAM_RED) return true;
  if (chaseTeam === CTF_TEAM_OBSERVER_BLUE && teamnum !== CTF_TEAM_BLUE) return true;
  return false;
}

export function UpdateChaseCam(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const goal = vec3();
  const forward = vec3();
  const right = vec3();
  const angles = vec3();

  // is our chase target gone?
  // (C dereferences ent->client->chase_target->inuse unconditionally here,
  // i.e. the caller guarantees chase_target is non-null; this port mirrors
  // that guarantee with an explicit early return rather than a crash, per
  // src/ctf/g_chase.ts and src/rogue/g_chase.ts's identical precedent.)
  let targ = client.chase_target;
  if (targ === null) return;

  if (!targ.inuse || (targ.client !== null && targ.client.resp.spectator)) {
    const old = client.chase_target;
    ChaseNext(ent);
    if (client.chase_target === old) {
      client.chase_target = null;
      client.ps.pmove.pm_flags &= ~PMF_NO_PREDICTION;
      return;
    }
  }

  targ = client.chase_target;
  if (targ === null || targ.client === null) return;

  VectorCopy(targ.client.v_angle, angles);
  VectorCopy(targ.s.origin, goal);
  goal[2] += targ.viewheight;

  const targorigin = vec3();
  VectorCopy(goal, targorigin);

  AngleVectors(angles, forward, right, null);
  VectorMA(goal, 30, forward, goal);

  // trace from targorigin to final chase origin goal
  let trace = gi.trace(targorigin, vec3_origin, vec3_origin, goal, targ, MASK_SOLID);

  // test for hit so we don't go out of the map!
  if (trace.fraction < 1) {
    // we hit something, need to do a bit of avoidance

    // take real end point
    VectorCopy(trace.endpos, goal);

    // real dir vector
    const temp = vec3();
    VectorSubtract(goal, targorigin, temp);

    // scale it back bit more
    VectorMA(targorigin, 0.9, temp, goal);
  }

  VectorCopy(goal, ent.s.origin);
  for (let i = 0; i < 3; i++) {
    client.ps.pmove.delta_angles[i] = ANGLE2SHORT(targ.client.v_angle[i] - client.resp.cmd_angles[i]);
  }

  if (targ.deadflag) {
    client.ps.viewangles[ROLL] = 40;
    client.ps.viewangles[_PITCH] = -15;
    client.ps.viewangles[YAW] = targ.client.killer_yaw;
    client.ps.pmove.pm_type = PmTypeT.PM_DEAD;
  } else {
    VectorCopy(targ.client.v_angle, client.ps.viewangles);
    VectorCopy(targ.client.v_angle, client.v_angle);
    client.ps.pmove.pm_type = PmTypeT.PM_FREEZE;
  }

  ent.viewheight = 0;
  client.ps.pmove.pm_flags |= PMF_NO_PREDICTION;
  gi.linkentity(ent);
}

export function ChaseNext(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;
  if (client.chase_target === null) return;

  const chaseTeam = client.ctf.teamnum;

  let i = client.chase_target.s.number;
  const maxclients = cvarNum(gameCvars.maxclients);
  let e: EdictT;
  do {
    i++;
    if (i > maxclients) i = 1;
    e = g_edicts[i];
    if (!e.inuse) continue;

    // bat
    if (chaseTeamBlocks(chaseTeam, e)) continue;

    if (e.client !== null && !e.client.resp.spectator) break;
  } while (e !== client.chase_target);

  client.chase_target = e;
  client.update_chase = true;
}

export function ChasePrev(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;
  if (client.chase_target === null) return;

  const chaseTeam = client.ctf.teamnum;

  let teamObserveOk = !(chaseTeam === CTF_TEAM_OBSERVER_RED || chaseTeam === CTF_TEAM_OBSERVER_BLUE);

  let i = client.chase_target.s.number;
  const maxclients = cvarNum(gameCvars.maxclients);
  let e: EdictT;
  do {
    i--;
    if (i < 1) i = maxclients;
    e = g_edicts[i];
    if (!e.inuse) continue;

    // bat
    if (chaseTeamBlocks(chaseTeam, e)) continue;

    if (e.client !== null && !e.client.resp.spectator) {
      teamObserveOk = true;
      break;
    }
  } while (e !== client.chase_target);

  if (teamObserveOk) {
    client.chase_target = e;
    client.update_chase = true;
  }
}

// bat
//
// Team_Observer_OK gates whether an observer locked to CTF_TEAM_OBSERVER_RED
// or CTF_TEAM_OBSERVER_BLUE is allowed to enter chase-cam at all (called
// before GetChaseTarget/ChaseNext by this file's callers in g_cmds.c,
// which is outside this unit's SCOPE). It depends on Num_Of_Players, which
// lmctf60/g_chase.c only forward-declares
// (`int Num_Of_Players(edict_t *ent, int Ctf_Team);`) -- the real
// definition is lmctf60/p_client.c:3310, counting connected CTF_TEAM_RED/
// CTF_TEAM_BLUE players via ctf_findplayer. p_client.c's TS counterpart,
// src/lmctf/p_client.ts, now exists and exports Num_Of_Players for real
// (that file's own doc comment on Num_Of_Players cites this exact gap and
// resolves it) -- resolved via a lazy require, not a static import:
// p_client.ts statically imports UpdateChaseCam from this file, so a
// static import back here would close a value cycle.
function clientModule(): typeof import("./p_client") {
  return require("./p_client") as typeof import("./p_client");
}

export function Team_Observer_OK(Team_To_View: number, ent: EdictT): boolean {
  if (clientModule().Num_Of_Players(ent, Team_To_View) > 0) return true;

  if (Team_To_View === CTF_TEAM_RED) {
    gi.centerprintf(ent, "No red players to chase.");
  } else {
    gi.centerprintf(ent, "No blue players to chase.");
  }

  return false;
}

export function GetChaseTarget(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const chaseTeam = client.ctf.teamnum;
  const maxclients = cvarNum(gameCvars.maxclients);

  for (let i = 1; i <= maxclients; i++) {
    // other is the guy we are chasing
    const other = g_edicts[i];

    // bat
    if (chaseTeamBlocks(chaseTeam, other)) continue;

    if (other.inuse && other.client !== null && !other.client.resp.spectator) {
      client.chase_target = other;
      client.update_chase = true;
      UpdateChaseCam(ent);
      return;
    }
  }

  gi.centerprintf(ent, "No other players to chase.");
}
