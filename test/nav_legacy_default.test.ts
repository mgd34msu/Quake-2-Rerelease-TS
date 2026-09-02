/*
The `sv_nav_legacy` DEFAULT, pinned on its own.

test/nav_family_gating_boot.test.ts covers what the cvar DOES at each
setting, forcing it explicitly in both directions. What it deliberately does
not cover is which way it points when nobody touches it -- and that is the
part the owner ruled on twice:

  2026-08-31, default "0": "add it to the legacy one but default it to off.
  that way we don't disrupt having bots and things like that." Correct on the
  facts of the day, when nothing under the classic module read nav data.

  2026-09-02, default "1": the classic module now has a nav consumer --
  src/game/game.ts's `get_path_to_goal` import, backed by legacy.ts's
  PF_GetPathToGoal, driving g_kextarg.ts's compass trail and its NEAREST
  target_poi ranking. Off would mean the classic compass silently degrades
  unless the player finds an undocumented cvar, which the charter ("every
  re-release feature works under the classic ruleset") does not allow. The
  cvar stays, as the opt-out.

src/server/nav.ts's "THE DEFAULT, AND WHY IT CHANGED" section carries the
full write-up. This file is the executable half of it, so a future edit to
that default has to come here and say so out loud.

Cvar_Get is first-registration-wins, so reading the default honestly means
removing any registration another test file in this process already made,
re-running Nav_Init, and putting the original back afterward.
*/

import { describe, test, expect, afterAll } from "bun:test";
import { cvar_vars, Cvar_ForceSet } from "../src/qcommon/cvar";
import type { CvarT } from "../src/shared/q_shared";
import { Nav_Init, Nav_LegacyLoadEnabled } from "../src/server/nav";

const NAME = "sv_nav_legacy";
const preexisting: CvarT | undefined = cvar_vars.get(NAME);

/** Drop any prior registration and let Nav_Init register the cvar the way a
 *  cold boot does, so what comes back is the real default string. */
function registerFresh(): CvarT {
  cvar_vars.delete(NAME);
  Nav_Init();
  const cvar = cvar_vars.get(NAME);
  expect(cvar).toBeDefined();
  return cvar!;
}

afterAll(() => {
  // Put the process back the way it was found, and re-run Nav_Init so the
  // module's own cached handle points at whatever object is now in the map
  // (rule 13: no cross-file leakage either way).
  cvar_vars.delete(NAME);
  if (preexisting !== undefined) cvar_vars.set(NAME, preexisting);
  Nav_Init();
});

describe("sv_nav_legacy default", () => {
  test("Nav_Init registers it at 1, so the classic ruleset loads nav data with no cvar set", () => {
    const cvar = registerFresh();
    expect(cvar.string).toBe("1");
    expect(cvar.value).toBe(1);
    expect(Nav_LegacyLoadEnabled()).toBe(true);
  });

  test("the cvar is still a working opt-out at 0", () => {
    registerFresh();
    Cvar_ForceSet(NAME, "0");
    expect(Nav_LegacyLoadEnabled()).toBe(false);

    Cvar_ForceSet(NAME, "1");
    expect(Nav_LegacyLoadEnabled()).toBe(true);
  });
});
