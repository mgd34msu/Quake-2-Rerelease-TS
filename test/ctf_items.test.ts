/*
Unit tests for this unit's ctf/g_items.c, ctf/g_cmds.c, ctf/g_combat.c, and
ctf/g_spawn.c deltas (the itemlist wiring for the flags/techs/grapple, the
CheckFlood move from g_ctf.ts's placeholder into g_cmds.ts, and the
ClientCommand "team" dispatch into g_ctf.ts).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: this file calls
GetGameAPI(fakeImports) itself and never relies on another test file having
run first. Modeled after test/ctf_core.test.ts's fake-GameImports pattern and
test/g_cmds.test.ts's FakeArgs (argv/args) pattern for ClientCommand.
*/

import { describe, expect, test } from "bun:test";
import type { Edict, GameImports, GTraceT } from "../src/ctf/game";
import { SolidT } from "../src/ctf/game";
import { GetGameAPI } from "../src/ctf/g_main";
import {
  EdictT,
  g_edicts,
  GClientT,
  game,
  gameCvars,
  globals,
  IT_TECH,
  IT_WEAPON,
  level,
  SetGEdicts,
  WEAP_GRAPPLE,
} from "../src/ctf/g_local";
import { FindItemByClassname, InitItems, ITEM_INDEX, itemlist, SetItemNames } from "../src/ctf/g_items";
import {
  CTF_CAPTURE_BONUS,
  CTFDrop_Flag,
  CTFDrop_Tech,
  CTFPickup_Flag,
  CTFPickup_Tech,
  CTFSpawn,
  CTFWeapon_Grapple,
  CtfTeamT,
} from "../src/ctf/g_ctf";
import { Use_Weapon } from "../src/ctf/p_weapon";
import { CheckFlood, ClientCommand } from "../src/ctf/g_cmds";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT, EF_FLAG1, EF_FLAG2 } from "../src/shared/q_shared";

// ---------------------------------------------------------------------------
// fake GameImports -- records cprintf/bprintf calls, serves scripted
// argc/argv/args, same shape as test/g_cmds.test.ts's helper.
// ---------------------------------------------------------------------------

interface FakeArgs {
  argv: string[]; // argv[0] is the command name
}

interface RecordedPrints {
  bprintf: Array<[number, string]>;
  cprintf: Array<[Edict | null, number, string]>;
}

function defaultTrace(): GTraceT {
  return {
    allsolid: false,
    startsolid: false,
    fraction: 1,
    endpos: vec3(),
    plane: new CplaneT(),
    surface: null,
    contents: 0,
    ent: null,
  };
}

function buildFakeImports(args: FakeArgs, recorded: RecordedPrints): GameImports {
  return {
    bprintf: (printlevel, fmt) => {
      recorded.bprintf.push([printlevel, fmt]);
    },
    dprintf: () => {},
    cprintf: (ent, printlevel, fmt) => {
      recorded.cprintf.push([ent, printlevel, fmt]);
    },
    centerprintf: () => {},
    sound: () => {},
    positioned_sound: () => {},
    configstring: () => {},
    error: (fmt: string): never => {
      throw new Error(`gi.error: ${fmt}`);
    },
    modelindex: () => 1,
    soundindex: () => 1,
    imageindex: () => 0,
    setmodel: () => {},
    trace: () => defaultTrace(),
    pointcontents: () => 0,
    inPVS: () => false,
    inPHS: () => false,
    SetAreaPortalState: () => {},
    AreasConnected: () => false,
    linkentity: () => {},
    unlinkentity: () => {},
    BoxEdicts: () => 0,
    Pmove: () => {},
    multicast: () => {},
    unicast: () => {},
    WriteChar: () => {},
    WriteByte: () => {},
    WriteShort: () => {},
    WriteLong: () => {},
    WriteFloat: () => {},
    WriteString: () => {},
    WritePosition: () => {},
    WriteDir: () => {},
    WriteAngle: () => {},
    cvar: () => null,
    cvar_set: () => null,
    cvar_forceset: () => null,
    argc: () => args.argv.length,
    argv: (n) => args.argv[n] ?? "",
    args: () => args.argv.slice(1).join(" "),
    AddCommandString: () => {},
    DebugGraph: () => {},
  };
}

function fakeCvar(value: number): CvarT {
  const c = new CvarT();
  c.value = value;
  return c;
}

const MAXENTITIES = 32;
const MAXCLIENTS = 4;

function setupWorld(args: FakeArgs, recorded: RecordedPrints): void {
  GetGameAPI(buildFakeImports(args, recorded));

  const edicts: EdictT[] = Array.from({ length: MAXENTITIES }, () => new EdictT());
  edicts.forEach((e, i) => {
    e.s.number = i;
  });
  SetGEdicts(edicts);

  game.clear();
  game.maxclients = MAXCLIENTS;
  game.maxentities = MAXENTITIES;
  game.clients = Array.from({ length: MAXCLIENTS }, () => new GClientT());

  level.clear();

  for (const key of Object.keys(gameCvars) as Array<keyof typeof gameCvars>) {
    gameCvars[key] = null;
  }
  gameCvars.maxclients = fakeCvar(MAXCLIENTS);
  gameCvars.dmflags = fakeCvar(0);
  gameCvars.skill = fakeCvar(1);
  gameCvars.deathmatch = fakeCvar(1);
  gameCvars.coop = fakeCvar(0);

  globals.num_edicts = MAXENTITIES;

  // g_items.c's InitItems()/SetItemNames() are called from InitGame/
  // SP_worldspawn in the real boot sequence; this unit's items (flags,
  // techs, grapple) only exist in ITEMLIST once InitItems() has set
  // game.num_items, exactly as the C loop's `i < game.num_items` guard
  // requires.
  InitItems();
  SetItemNames();
}

function makePlayer(index: number, netname: string): EdictT {
  const ent = g_edicts[index];
  ent.inuse = true;
  const client = new GClientT();
  client.pers.netname = netname;
  ent.client = client;
  return ent;
}

// ---------------------------------------------------------------------------

describe("itemlist ctf delta -- weapon_grapple/item_flag_team1/2/item_tech1-4", () => {
  test("weapon_grapple is wired to Use_Weapon/CTFWeapon_Grapple", () => {
    setupWorld({ argv: [] }, { bprintf: [], cprintf: [] });

    const grapple = FindItemByClassname("weapon_grapple");
    expect(grapple).not.toBeNull();
    expect(grapple!.pickup).toBeNull();
    expect(grapple!.use).toBe(Use_Weapon);
    expect(grapple!.drop).toBeNull();
    expect(grapple!.weaponthink).toBe(CTFWeapon_Grapple);
    expect(grapple!.flags & IT_WEAPON).toBe(IT_WEAPON);
    expect(grapple!.weapmodel).toBe(WEAP_GRAPPLE);
  });

  test("item_flag_team1/item_flag_team2 are wired to CTFPickup_Flag/CTFDrop_Flag", () => {
    setupWorld({ argv: [] }, { bprintf: [], cprintf: [] });

    const flag1 = FindItemByClassname("item_flag_team1");
    const flag2 = FindItemByClassname("item_flag_team2");
    expect(flag1).not.toBeNull();
    expect(flag2).not.toBeNull();

    expect(flag1!.pickup).toBe(CTFPickup_Flag);
    expect(flag1!.drop).toBe(CTFDrop_Flag);
    expect(flag1!.use).toBeNull();
    expect(flag1!.world_model_flags).toBe(EF_FLAG1);

    expect(flag2!.pickup).toBe(CTFPickup_Flag);
    expect(flag2!.drop).toBe(CTFDrop_Flag);
    expect(flag2!.world_model_flags).toBe(EF_FLAG2);
  });

  test("item_tech1-4 are wired to CTFPickup_Tech/CTFDrop_Tech and carry IT_TECH", () => {
    setupWorld({ argv: [] }, { bprintf: [], cprintf: [] });

    for (const classname of ["item_tech1", "item_tech2", "item_tech3", "item_tech4"]) {
      const tech = FindItemByClassname(classname);
      expect(tech).not.toBeNull();
      expect(tech!.pickup).toBe(CTFPickup_Tech);
      expect(tech!.drop).toBe(CTFDrop_Tech);
      expect(tech!.flags & IT_TECH).toBe(IT_TECH);
    }
  });

  test("InitItems accounts for the 7 new ctf entries (42 base + grapple + 2 flags + 4 techs) plus the 17 rerelease pickups", () => {
    setupWorld({ argv: [] }, { bprintf: [], cprintf: [] });

    // itemlist() includes index 0 ("leave index 0 alone") and the trailing
    // end-of-list marker; game.num_items excludes the end-of-list marker,
    // exactly as InitItems()'s `ITEMLIST.length - 1` does.
    expect(itemlist().length).toBe(game.num_items + 1);

    // 49 = ctf/g_items.c's own count. The extra 17 are NOT in the C
    // itemlist: they are the Ground Zero and Reckoning pickups that the
    // rerelease's own CTF maps place (q2kctf1 and q2kctf2) -- the seven
    // ammo_* rows, item_doppleganger / item_double / item_sphere_hunter,
    // and the seven weapon_* rows. Added so the CTF module satisfies the
    // "any content plays under any ruleset" rule the way src/game did in
    // commit 288484f. Before they were added, q2kctf1 alone dropped 14
    // entities. See test/g_spawn_module_coverage.test.ts for the
    // shipped-map gate that requires them.
    expect(game.num_items).toBe(66);
  });
});

describe("CTFPickup_Flag -- capture/carry state machine", () => {
  test("a teamed player picking up the enemy flag becomes its carrier", () => {
    const recorded: RecordedPrints = { bprintf: [], cprintf: [] };
    setupWorld({ argv: [] }, recorded);
    CTFSpawn(); // resolves g_ctf.ts's module-private flag1_item/flag2_item

    const flag2 = FindItemByClassname("item_flag_team2");
    expect(flag2).not.toBeNull();

    const enemyFlagEnt = g_edicts[10];
    enemyFlagEnt.inuse = true;
    enemyFlagEnt.classname = "item_flag_team2";
    enemyFlagEnt.spawnflags = 0; // at home base, not a dropped flag

    const carrier = makePlayer(1, "red1");
    carrier.client!.resp.ctf_team = CtfTeamT.CTF_TEAM1;

    const taken = CTFPickup_Flag(enemyFlagEnt, carrier);

    expect(taken).toBe(true);
    expect(carrier.client!.pers.inventory[ITEM_INDEX(flag2!)]).toBe(1);
  });

  test("returning to a not-dropped home flag while carrying the enemy flag captures it", () => {
    const recorded: RecordedPrints = { bprintf: [], cprintf: [] };
    setupWorld({ argv: [] }, recorded);
    CTFSpawn();

    const flag2 = FindItemByClassname("item_flag_team2");
    expect(flag2).not.toBeNull();

    level.time = 1000;
    const carrier = makePlayer(1, "red1");
    carrier.client!.resp.ctf_team = CtfTeamT.CTF_TEAM1;
    carrier.client!.pers.inventory[ITEM_INDEX(flag2!)] = 1; // already carrying team2's flag
    // stale-out the assist-bonus windows so only CTF_CAPTURE_BONUS applies
    carrier.client!.resp.ctf_lastreturnedflag = -1000;
    carrier.client!.resp.ctf_lastfraggedcarrier = -1000;

    const homeFlagEnt = g_edicts[11];
    homeFlagEnt.inuse = true;
    homeFlagEnt.classname = "item_flag_team1";
    homeFlagEnt.spawnflags = 0; // at home base, not dropped

    const taken = CTFPickup_Flag(homeFlagEnt, carrier);

    // CTFResetFlags() removes the flag entities itself; the caller's
    // Touch_Item never consumes this "pickup" (see g_ctf.c's comment on this
    // call site), so CTFPickup_Flag returns false even on a capture.
    expect(taken).toBe(false);
    expect(carrier.client!.pers.inventory[ITEM_INDEX(flag2!)]).toBe(0);
    expect(carrier.client!.resp.score).toBe(CTF_CAPTURE_BONUS);
    expect(recorded.bprintf.some(([, fmt]) => fmt.includes("captured"))).toBe(true);
  });
});

describe("ClientCommand \"team\" dispatches into g_ctf.ts's CTFTeam_f", () => {
  test("with no arguments, reports the caller's current ctf team via CTFTeam_f", () => {
    const recorded: RecordedPrints = { bprintf: [], cprintf: [] };
    setupWorld({ argv: ["team"] }, recorded);

    const ent = makePlayer(1, "player");
    expect(ent.client!.resp.ctf_team).toBe(CtfTeamT.CTF_NOTEAM);

    ClientCommand(ent);

    expect(recorded.cprintf.length).toBe(1);
    expect(recorded.cprintf[0][2]).toContain("UNKNOWN team");
  });
});

describe("CheckFlood -- rate limits chat per flood_msgs/flood_persecond/flood_waitdelay", () => {
  test("allows flood_msgs messages, then locks out and reports the wait", () => {
    const recorded: RecordedPrints = { bprintf: [], cprintf: [] };
    setupWorld({ argv: [] }, recorded);
    gameCvars.flood_msgs = fakeCvar(2);
    gameCvars.flood_persecond = fakeCvar(10);
    gameCvars.flood_waitdelay = fakeCvar(5);

    const ent = makePlayer(1, "chatty");

    level.time = 100;
    expect(CheckFlood(ent)).toBe(false); // message 1

    level.time = 101;
    expect(CheckFlood(ent)).toBe(false); // message 2

    level.time = 102;
    expect(CheckFlood(ent)).toBe(true); // message 3: within flood_persecond of message 1
    expect(ent.client!.flood_locktill).toBe(107); // level.time(102) + flood_waitdelay(5)

    level.time = 103;
    expect(CheckFlood(ent)).toBe(true); // still locked out

    expect(recorded.cprintf.some(([, , fmt]) => fmt.includes("Flood protection"))).toBe(true);
  });

  test("is a no-op when flood_msgs is 0", () => {
    setupWorld({ argv: [] }, { bprintf: [], cprintf: [] });
    gameCvars.flood_msgs = fakeCvar(0);

    const ent = makePlayer(1, "chatty");

    for (let i = 0; i < 10; i++) {
      level.time = i;
      expect(CheckFlood(ent)).toBe(false);
    }
  });
});
