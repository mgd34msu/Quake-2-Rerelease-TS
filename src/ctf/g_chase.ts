// g_chase.c
//
// Deviation: ctf/g_chase.c drops GetChaseTarget entirely (its caller in
// ctf/p_client.c's spectator-command handling was rewritten to not need it --
// see ctf/g_cmds.c's ChaseNext/ChasePrev call sites instead). src/ctf/p_client.ts
// (owned by a concurrent p_client-delta worker, out of this unit's SCOPE)
// still imports GetChaseTarget from this module; removing it here matches
// the C delta exactly but leaves that import dangling until the p_client
// sibling lands its own delta -- flagged as a follow-up for the
// coordinator/p_client worker rather than silently patched here.

import { AngleVectors, vec3, vec3_origin, VectorCopy, VectorMA, VectorNormalize } from "../shared/math";
import { ANGLE2SHORT, MASK_SOLID, PITCH, PmTypeT, PMF_NO_PREDICTION } from "../shared/q_shared";
import { type EdictT, g_edicts, gameCvars, gi, level, svc_layout } from "./g_local";
import { SolidT } from "./game";

function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

export function UpdateChaseCam(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const o = vec3();
  const ownerv = vec3();
  const goal = vec3();
  const forward = vec3();
  const right = vec3();
  const oldgoal = vec3();
  const angles = vec3();

  // is our chase target gone?
  let targ = client.chase_target;
  if (targ === null) return;

  if (!targ.inuse) {
    client.chase_target = null;
    return;
  }

  targ = client.chase_target;
  if (targ === null || targ.client === null) return;

  VectorCopy(targ.s.origin, ownerv);
  VectorCopy(ent.s.origin, oldgoal);

  ownerv[2] += targ.viewheight;

  VectorCopy(targ.client.v_angle, angles);
  if (angles[PITCH] > 56) angles[PITCH] = 56;
  AngleVectors(angles, forward, right, null);
  VectorNormalize(forward);
  VectorMA(ownerv, -30, forward, o);

  if (o[2] < targ.s.origin[2] + 20) o[2] = targ.s.origin[2] + 20;

  // jump animation lifts
  if (targ.groundentity === null) o[2] += 16;

  let trace = gi.trace(ownerv, vec3_origin, vec3_origin, o, targ, MASK_SOLID);

  VectorCopy(trace.endpos, goal);

  VectorMA(goal, 2, forward, goal);

  // pad for floors and ceilings
  VectorCopy(goal, o);
  o[2] += 6;
  trace = gi.trace(goal, vec3_origin, vec3_origin, o, targ, MASK_SOLID);
  if (trace.fraction < 1) {
    VectorCopy(trace.endpos, goal);
    goal[2] -= 6;
  }

  VectorCopy(goal, o);
  o[2] -= 6;
  trace = gi.trace(goal, vec3_origin, vec3_origin, o, targ, MASK_SOLID);
  if (trace.fraction < 1) {
    VectorCopy(trace.endpos, goal);
    goal[2] += 6;
  }

  client.ps.pmove.pm_type = PmTypeT.PM_FREEZE;

  VectorCopy(goal, ent.s.origin);
  for (let i = 0; i < 3; i++) {
    client.ps.pmove.delta_angles[i] = ANGLE2SHORT(targ.client.v_angle[i] - client.resp.cmd_angles[i]);
  }

  VectorCopy(targ.client.v_angle, client.ps.viewangles);
  VectorCopy(targ.client.v_angle, client.v_angle);

  ent.viewheight = 0;
  client.ps.pmove.pm_flags |= PMF_NO_PREDICTION;
  gi.linkentity(ent);

  if (
    (!client.showscores && client.menu === null && !client.showinventory && !client.showhelp && (level.framenum & 31) === 0) ||
    client.update_chase
  ) {
    client.update_chase = false;
    const s = `xv 0 yb -68 string2 "Chasing ${targ.client.pers.netname}"`;
    gi.WriteByte(svc_layout);
    gi.WriteString(s);
    gi.unicast(ent, false);
  }
}

export function ChaseNext(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;
  if (client.chase_target === null) return;

  let i = client.chase_target.s.number;
  const maxclients = cvarNum(gameCvars.maxclients);
  let e: EdictT;
  do {
    i++;
    if (i > maxclients) i = 1;
    e = g_edicts[i];
    if (!e.inuse) continue;
    if (e.solid !== SolidT.SOLID_NOT) break;
  } while (e !== client.chase_target);

  client.chase_target = e;
  client.update_chase = true;
}

export function ChasePrev(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;
  if (client.chase_target === null) return;

  let i = client.chase_target.s.number;
  const maxclients = cvarNum(gameCvars.maxclients);
  let e: EdictT;
  do {
    i--;
    if (i < 1) i = maxclients;
    e = g_edicts[i];
    if (!e.inuse) continue;
    if (e.solid !== SolidT.SOLID_NOT) break;
  } while (e !== client.chase_target);

  client.chase_target = e;
  client.update_chase = true;
}
