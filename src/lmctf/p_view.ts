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
import { GamePaused } from "./g_tourney";
import { Weapon_Hook_Fire } from "./p_weapon";

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
