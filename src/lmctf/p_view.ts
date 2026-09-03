// Ports a SUBSET of lmctf60/p_view.c (diff vs quake-2/ctf/p_view.c is 839
// lines of 1412 total).
//
// STATUS: only the offhand-hook priority feature's per-frame dispatch is
// ported: the first few lines of ClientEndServerFrame, which is where
// lmctf60 (a KEX re-release-era source, per the "// Paril" comment in the
// C source) drives the hook's pull physics every server frame independent
// of the equipped weapon's own think dispatch. Everything else
// ClientEndServerFrame normally does in the C source (bob-cycle
// calculation, pmove-vs-edict resync after being pushed/kicked, stair-step
// smoothing, G_SetClientEffects/G_SetClientSound/G_SetClientFrame,
// linkentity) is NOT ported -- this file's ClientEndServerFrame returns
// after the hook dispatch instead of falling through to that code, which
// does not exist here yet. Every other p_view.c function (fog, damage
// blends, view kicks, G_SetStats, DeathmatchScoreboardMessage, etc.) is
// also NOT ported.

import type { EdictT } from "./g_local";
import { ANIM_BASIC, ANIM_DEATH, ANIM_JUMP, ANIM_REVERSE, ANIM_WAVE } from "./g_local";
import { PMF_DUCKED } from "../shared/q_shared";
import {
  FRAME_crstnd01,
  FRAME_crstnd19,
  FRAME_crwalk1,
  FRAME_crwalk6,
  FRAME_jump1,
  FRAME_jump2,
  FRAME_jump3,
  FRAME_jump6,
  FRAME_run1,
  FRAME_run6,
  FRAME_stand01,
  FRAME_stand40,
} from "./m_player_frames";
import { GamePaused } from "./g_tourney";
import { Weapon_Hook_Fire } from "./p_weapon";

// `static float xyspeed;` (p_view.c). The bob-cycle code that assigns it
// lives in the unported remainder of ClientEndServerFrame (see the file
// header), so in this module it stays 0: G_SetClientFrame below therefore
// always picks standing/crouching frames rather than running ones. The only
// caller is g_kextarg.ts's target_camera dummy, a cutscene-only entity, and
// src/game/p_view.ts's own version is equally at the mercy of whatever the
// last real frame left here -- see the DEVIATION note at that call site.
const xyspeed = 0;

/*
=================
ClientEndServerFrame (lmctf60/p_view.c) -- PARTIAL, see file header.

Called for each player at the end of the server frame and right after
spawning. The C source's own "// Paril" comment marks this GamePaused()
guard as a KEX re-release addition on top of the original id/LM_CTF split:
when the game is paused, NOTHING in ClientEndServerFrame runs at all --
including the hook, which simply stops pulling for the duration of the
pause and resumes exactly where it left off (hookstate/hook entity are
untouched by a pause).

`ent.client.hookstate` is checked as a C truthy int (any non-zero state --
1 "bolt in flight" or 2 "pulling" -- re-invokes Weapon_Hook_Fire; only
state 0 "idle" skips it).
=================
*/
export function ClientEndServerFrame(ent: EdictT): void {
  if (ent.client === null) return;

  if (!GamePaused()) {
    if (ent.client.hookstate !== 0) {
      Weapon_Hook_Fire(ent);
    }
    // The rest of ClientEndServerFrame (bob-cycle, pmove resync, stair-step
    // smoothing, G_SetClientEffects/Sound/Frame, linkentity) is not ported
    // -- see file header.
  }
}

/*
===============
G_SetClientFrame
===============
*/
export function G_SetClientFrame(ent: EdictT): void {
  if (ent.s.modelindex !== 255) return; // not in the player model

  const client = ent.client;
  if (client === null) return;

  const duck = (client.ps.pmove.pm_flags & PMF_DUCKED) !== 0;
  const run = xyspeed !== 0;

  // check for stand/duck and stop/go transitions -- `goto newanim` in the C
  // fires from any of these three conditions, or by falling through the
  // block below; both paths converge on the same code, ported as one
  // straight-line function since nothing after this point depends on which
  // path was taken.
  const gotoNewanim =
    (duck !== client.anim_duck && client.anim_priority < ANIM_DEATH) ||
    (run !== client.anim_run && client.anim_priority === ANIM_BASIC) ||
    (ent.groundentity === null && client.anim_priority <= ANIM_WAVE);

  if (!gotoNewanim) {
    if (client.anim_priority === ANIM_REVERSE) {
      if (ent.s.frame > client.anim_end) {
        ent.s.frame--;
        return;
      }
    } else if (ent.s.frame < client.anim_end) {
      // continue an animation
      ent.s.frame++;
      return;
    }

    if (client.anim_priority === ANIM_DEATH) return; // stay there
    if (client.anim_priority === ANIM_JUMP) {
      if (ent.groundentity === null) return; // stay there
      client.anim_priority = ANIM_WAVE;
      ent.s.frame = FRAME_jump3;
      client.anim_end = FRAME_jump6;
      return;
    }
  }

  // newanim:
  // return to either a running or standing frame
  client.anim_priority = ANIM_BASIC;
  client.anim_duck = duck;
  client.anim_run = run;

  if (ent.groundentity === null) {
    client.anim_priority = ANIM_JUMP;
    if (ent.s.frame !== FRAME_jump2) ent.s.frame = FRAME_jump1;
    client.anim_end = FRAME_jump2;
  } else if (run) {
    // running
    if (duck) {
      ent.s.frame = FRAME_crwalk1;
      client.anim_end = FRAME_crwalk6;
    } else {
      ent.s.frame = FRAME_run1;
      client.anim_end = FRAME_run6;
    }
  } else {
    // standing
    if (duck) {
      ent.s.frame = FRAME_crstnd01;
      client.anim_end = FRAME_crstnd19;
    } else {
      ent.s.frame = FRAME_stand01;
      client.anim_end = FRAME_stand40;
    }
  }
}
