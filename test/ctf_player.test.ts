/*
Unit tests for the ctf/p_client.c, ctf/p_view.c, ctf/p_hud.c deltas applied to
src/ctf/p_client.ts, src/ctf/p_view.ts, src/ctf/p_hud.ts.

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: this file calls
GetGameAPI(fakeImports) itself and never relies on another test file having
run first. Modeled after test/ctf_core.test.ts's fake-GameImports pattern,
with one difference: this file's fake `gi.cvar()` returns a live CvarT
carrying the requested default value (instead of null) because
p_client.ts/p_hud.ts's `ctfEnabled()` helper -- and g_ctf.ts's own `ctf`
module cvar -- both read the "ctf" cvar's `.value` through gi.cvar(), and the
CTF delta under test is only reachable when that cvar is truthy.
*/

import { describe, expect, test } from "bun:test";
import type { GameImports, GTraceT } from "../src/ctf/game";
import { SolidT } from "../src/ctf/game";
import { GetGameAPI } from "../src/ctf/g_main";
import {
  EdictT,
  g_edicts,
  GClientT,
  game,
  gameCvars,
  globals,
  level,
  MovetypeT,
  SetGEdicts,
} from "../src/ctf/g_local";
import { CTFInit, CTFJoinTeam, CTFSpawn, CtfTeamT } from "../src/ctf/g_ctf";
import { ClientBegin, ClientConnect, player_die } from "../src/ctf/p_client";
import { ipFilterList } from "../src/ctf/g_svcmds";
import { ITEM_INDEX, FindItemByClassname, InitItems } from "../src/ctf/g_items";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT, Info_ValueForKey } from "../src/shared/q_shared";

// ---------------------------------------------------------------------------
// fake GameImports -- records WriteByte/WriteString calls and serves queued
// trace results, same shape as test/ctf_core.test.ts's helper, except
// cvar() returns a live CvarT carrying the requested default instead of
// null (see file header comment for why this file needs that).
// ---------------------------------------------------------------------------

interface Recorder {
  writeByte: number[];
  writeString: string[];
  configstrings: Map<number, string>;
}

function makeRecorder(): Recorder {
  return { writeByte: [], writeString: [], configstrings: new Map() };
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

function makeFakeGameImports(rec: Recorder): GameImports {
  return {
    bprintf() {},
    dprintf() {},
    cprintf() {},
    centerprintf() {},
    sound() {},
    positioned_sound() {},
    configstring(index, value) {
      rec.configstrings.set(index, value);
    },
    error(fmt): never {
      throw new Error(`gi.error: ${fmt}`);
    },
    modelindex() {
      return 1;
    },
    soundindex() {
      return 1;
    },
    imageindex() {
      return 0;
    },
    setmodel() {},
    trace() {
      return defaultTrace();
    },
    pointcontents() {
      return 0;
    },
    inPVS() {
      return false;
    },
    inPHS() {
      return false;
    },
    SetAreaPortalState() {},
    AreasConnected() {
      return false;
    },
    linkentity() {},
    unlinkentity() {},
    BoxEdicts() {
      return 0;
    },
    Pmove() {},
    multicast() {},
    unicast() {},
    WriteChar() {},
    WriteByte(c) {
      rec.writeByte.push(c);
    },
    WriteShort() {},
    WriteLong() {},
    WriteFloat() {},
    WriteString(s) {
      rec.writeString.push(s);
    },
    WritePosition() {},
    WriteDir() {},
    WriteAngle() {},
    cvar(name, value) {
      const c = new CvarT();
      c.string = value ?? "";
      const n = Number.parseFloat(c.string);
      c.value = Number.isNaN(n) ? 0 : n;
      return c;
    },
    cvar_set() {
      return null;
    },
    cvar_forceset() {
      return null;
    },
    argc() {
      return 0;
    },
    argv() {
      return "";
    },
    args() {
      return "";
    },
    AddCommandString() {},
    DebugGraph() {},
  };
}

function fakeCvar(value: number): CvarT {
  const c = new CvarT();
  c.value = value;
  return c;
}

const MAXENTITIES = 32;
const MAXCLIENTS = 4;

function setupWorld(): Recorder {
  const rec = makeRecorder();
  GetGameAPI(makeFakeGameImports(rec));

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

  gameCvars.maxclients = fakeCvar(MAXCLIENTS);
  gameCvars.maxspectators = fakeCvar(4);
  gameCvars.dmflags = fakeCvar(0); // DF_CTF_FORCEJOIN unset: joins stay observer until picked via menu
  gameCvars.skill = fakeCvar(1);
  gameCvars.deathmatch = fakeCvar(1);
  gameCvars.coop = fakeCvar(0);
  gameCvars.password = fakeCvar(0);
  gameCvars.password!.string = "";
  gameCvars.spectator_password = fakeCvar(0);
  gameCvars.spectator_password!.string = "";
  // 3.21 restores ipfilter (see ctf/g_svcmds.c); ClientConnect now calls
  // SV_FilterPacket, which reads this cvar. Default "1" matches InitGame's
  // real `gi.cvar("filterban", "1", 0)` registration.
  gameCvars.filterban = fakeCvar(1);

  globals.num_edicts = MAXCLIENTS + 1;

  // fallback spawn point SelectSpawnPoint falls through to when no
  // deathmatch/ctf spot matches; required so PutClientInServer never hits
  // gi.error("Couldn't find spawn point").
  const fallback = g_edicts[MAXCLIENTS + 1];
  fallback.inuse = true;
  fallback.classname = "info_player_start";
  globals.num_edicts = MAXCLIENTS + 2;

  // g_items.c's InitItems() sets game.num_items, which FindItem/
  // FindItemByClassname/ITEM_INDEX all range over; without it every item
  // lookup (including InitClientPersistant's FindItem("Blaster")) comes back
  // null. See test/ctf_items.test.ts's identical setup call.
  InitItems();

  CTFInit();
  CTFSpawn();

  return rec;
}

// makes edict `i` a connected player with a fresh client
function makePlayer(i: number): EdictT {
  const ent = g_edicts[i];
  ent.inuse = true;
  ent.client = game.clients[i - 1] ?? new GClientT();
  ent.client.pers.netname = `player${i}`;
  ent.client.pers.userinfo = `\\name\\player${i}\\skin\\male/grunt`;
  return ent;
}

// ClientConnect/ClientBegin take the server-facing `Edict` (game.ts's
// short prefix type) and immediately recover the full EdictT via
// g_edicts[entIn.s.number] (EDICT_NUM), exactly like every other GameExports
// entry point; g_edicts[i] already satisfies that narrower `Edict` shape
// structurally, so it is passed directly.
function connectAndBegin(i: number): EdictT {
  const entStub = g_edicts[i];
  entStub.s.number = i;
  const result = ClientConnect(entStub, `\\name\\player${i}\\skin\\male/grunt`);
  expect(result.allowed).toBe(true);
  ClientBegin(entStub);
  return g_edicts[i];
}

// ---------------------------------------------------------------------------

describe("ClientConnect/ClientBegin ctf join flow", () => {
  test("a freshly connected+begun deathmatch client stays CTF_NOTEAM and becomes an observer", () => {
    setupWorld();

    const ent = connectAndBegin(1);

    expect(ent.client).not.toBeNull();
    const client = ent.client!;
    expect(client.resp.ctf_team).toBe(CtfTeamT.CTF_NOTEAM);
    // CTFStartClient() (called from PutClientInServer) parks an unassigned
    // client in observer mode -- noclip, unsolid, hidden from other clients
    // -- until a team is picked from the join menu, instead of spawning them
    // into the map.
    expect(ent.movetype).toBe(MovetypeT.MOVETYPE_NOCLIP);
    expect(ent.solid).toBe(SolidT.SOLID_NOT);
  });

  // ctf/p_client.c's 3.21 delta adds the ipfilter check ClientConnect had
  // never had in this fork (ctf/g_svcmds.c dropped the whole subsystem in
  // 3.19; 3.21 restores it -- see src/ctf/g_svcmds.ts).
  test("a banned IP is rejected with a 'Banned.' rejmsg and never reaches ClientBegin", () => {
    setupWorld();
    ipFilterList.filters.push({ mask: 0xffffffff, compare: (10 | (0 << 8) | (0 << 16) | (1 << 24)) >>> 0 });

    const entStub = g_edicts[1];
    entStub.s.number = 1;
    const result = ClientConnect(entStub, "\\name\\intruder\\skin\\male/grunt\\ip\\10.0.0.1");

    expect(result.allowed).toBe(false);
    expect(Info_ValueForKey(result.userinfo, "rejmsg")).toBe("Banned.");

    ipFilterList.clear();
  });
});

describe("CTFJoinTeam-driven spawn point selection", () => {
  test("joining a team places the player at that team's info_player_team* spot", () => {
    setupWorld();

    // fabricate a team1 and a team2 spawn spot at distinct origins so a
    // wrong-team pick would be caught by the origin assertion below.
    const team1Spot = g_edicts[MAXCLIENTS + 2];
    team1Spot.inuse = true;
    team1Spot.classname = "info_player_team1";
    team1Spot.s.origin[0] = 100;
    team1Spot.s.origin[1] = 200;
    team1Spot.s.origin[2] = 300;

    const team2Spot = g_edicts[MAXCLIENTS + 3];
    team2Spot.inuse = true;
    team2Spot.classname = "info_player_team2";
    team2Spot.s.origin[0] = -400;
    team2Spot.s.origin[1] = -500;
    team2Spot.s.origin[2] = -600;
    globals.num_edicts = MAXCLIENTS + 4;

    const ent = connectAndBegin(2);
    expect(ent.client!.resp.ctf_team).toBe(CtfTeamT.CTF_NOTEAM);

    // simulate the join-menu selection (CTFJoinTeam1/CTFJoinTeam2's shared
    // implementation) picking the red team.
    CTFJoinTeam(ent, CtfTeamT.CTF_TEAM1);

    expect(ent.client!.resp.ctf_team).toBe(CtfTeamT.CTF_TEAM1);
    // no longer an observer: CTFStartClient's early-return only fires for
    // CTF_NOTEAM clients, so PutClientInServer ran the normal spawn path.
    expect(ent.movetype).toBe(MovetypeT.MOVETYPE_WALK);
    expect(ent.solid).toBe(SolidT.SOLID_BBOX);
    // SelectSpawnPoint copies the spot's origin then adds 9 to z, and
    // PutClientInServer adds one more ("make sure off ground") on top.
    expect(ent.s.origin[0]).toBe(100);
    expect(ent.s.origin[1]).toBe(200);
    expect(ent.s.origin[2]).toBe(310);
  });
});

describe("player_die drops a carried flag", () => {
  test("CTFDeadDropFlag spawns a dropped flag and clears the carrier's inventory slot", () => {
    setupWorld();

    const flag2 = FindItemByClassname("item_flag_team2");
    // g_items.ts (a sibling ctf-delta unit) had not landed item_flag_team1/2
    // when this brief was written; CTFSpawn()'s FindItemByClassname lookups
    // resolve flag1_item/flag2_item to null until that unit lands, and
    // CTFDeadDropFlag/CTFPickup_Flag are documented no-ops in that case (see
    // test/ctf_core.test.ts's "CTFPickup_Flag" describe block). By the time
    // this unit ran, g_items.ts already carries the full ctf item table (its
    // g_items.ts imports CTFDrop_Flag/CTFPickup_Flag/CTFFlagSetup from
    // g_ctf.ts and defines item_flag_team1/item_flag_team2), so the flag
    // path is exercised for real below; the `if (flag2 === null)` branch is
    // kept as a graceful skip in case a future revert reintroduces the gap.
    expect(flag2).not.toBeNull();
    if (flag2 === null) return; // narrows for TS below; see comment above

    const victim = makePlayer(1);
    victim.client!.resp.ctf_team = CtfTeamT.CTF_TEAM1;
    victim.health = 100;
    victim.deadflag = 0;
    victim.client!.pers.inventory[ITEM_INDEX(flag2)] = 1; // carrying team2's flag as a team1 player

    const attacker = makePlayer(2);
    attacker.client!.resp.ctf_team = CtfTeamT.CTF_TEAM2;

    const beforeEdictCount = g_edicts.filter((e) => e.inuse && e.classname === "item_flag_team2").length;

    player_die(victim, attacker, attacker, 999, vec3());

    expect(victim.deadflag).not.toBe(0);
    expect(victim.client!.pers.inventory[ITEM_INDEX(flag2)]).toBe(0);
    // the whole inventory is memset to 0 on death in the ctf delta (no more
    // coop key-preserving loop), so every slot -- not just the flag's --
    // should be zero afterward.
    expect(victim.client!.pers.inventory.every((n) => n === 0)).toBe(true);

    const afterEdictCount = g_edicts.filter((e) => e.inuse && e.classname === "item_flag_team2").length;
    expect(afterEdictCount).toBe(beforeEdictCount + 1);
  });
});
