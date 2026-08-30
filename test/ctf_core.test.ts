/*
Unit tests for src/ctf/g_ctf.ts and src/ctf/p_menu.ts (the CTF core unit).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: this file calls
GetGameAPI(fakeImports) itself and never relies on another test file having
run first. Modeled after test/g_weapon.test.ts's fake-GameImports pattern.
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
  level,
  MovetypeT,
  SetGEdicts,
  svc_layout,
} from "../src/ctf/g_local";
import {
  CTFFireGrapple,
  CTFGrappleTouch,
  CTFOtherTeam,
  CTFOtherTeamName,
  CTFPickup_Flag,
  CTFSetupTechSpawn,
  CTFSpawn,
  CTFTeamName,
  CtfTeamT,
} from "../src/ctf/g_ctf";
import { PMenu_Open, PmenuT, PMENU_ALIGN_LEFT } from "../src/ctf/p_menu";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";

// ---------------------------------------------------------------------------
// fake GameImports -- records WriteByte/WriteString calls and serves queued
// trace results, same shape as test/g_weapon.test.ts's helper.
// ---------------------------------------------------------------------------

interface Recorder {
  writeByte: number[];
  writeString: string[];
  sound: number;
  linkentity: Edict[];
  unicast: number;
}

function makeRecorder(): Recorder {
  return { writeByte: [], writeString: [], sound: 0, linkentity: [], unicast: 0 };
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

let traceQueue: GTraceT[] = [];

function nextTrace(): GTraceT {
  const queued = traceQueue.shift();
  if (queued !== undefined) return queued;
  return defaultTrace();
}

function makeFakeGameImports(rec: Recorder): GameImports {
  return {
    bprintf() {},
    dprintf() {},
    cprintf() {},
    centerprintf() {},
    sound() {
      rec.sound++;
    },
    positioned_sound() {},
    configstring() {},
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
      return nextTrace();
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
    linkentity(ent) {
      rec.linkentity.push(ent);
    },
    unlinkentity() {},
    BoxEdicts() {
      return 0;
    },
    Pmove() {},
    multicast() {},
    unicast() {
      rec.unicast++;
    },
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
    cvar() {
      return null;
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

const MAXENTITIES = 16;
const MAXCLIENTS = 2;

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
  gameCvars.dmflags = fakeCvar(0);
  gameCvars.skill = fakeCvar(1);
  gameCvars.deathmatch = fakeCvar(1);
  gameCvars.coop = fakeCvar(0);

  globals.num_edicts = MAXENTITIES;

  traceQueue = [];

  return rec;
}

// makes edict `i` a connected player with a fresh client
function makePlayer(i: number): EdictT {
  const ent = g_edicts[i];
  ent.inuse = true;
  ent.client = new GClientT();
  ent.client.pers.netname = `player${i}`;
  return ent;
}

// ---------------------------------------------------------------------------

describe("GClientT CTF field defaults", () => {
  test("ctf_team/resp fields default to CTF_NOTEAM / not-ready / not-admin", () => {
    const client = new GClientT();
    expect(client.resp.ctf_team).toBe(CtfTeamT.CTF_NOTEAM);
    expect(client.resp.ctf_state).toBe(0);
    expect(client.resp.ready).toBe(false);
    expect(client.resp.admin).toBe(false);
    expect(client.resp.voted).toBe(false);
    expect(client.resp.id_state).toBe(false);
    expect(client.resp.ghost).toBeNull();
  });

  test("grapple and menu fields default to inactive/closed", () => {
    const client = new GClientT();
    expect(client.ctf_grapple).toBeNull();
    expect(client.ctf_grapplestate).toBe(0);
    expect(client.menu).toBeNull();
    expect(client.inmenu).toBe(false);
  });
});

describe("CTFTeamName / CTFOtherTeamName / CTFOtherTeam -- pure helpers", () => {
  test("CTFTeamName maps team constants to display names", () => {
    expect(CTFTeamName(CtfTeamT.CTF_TEAM1)).toBe("RED");
    expect(CTFTeamName(CtfTeamT.CTF_TEAM2)).toBe("BLUE");
    expect(CTFTeamName(CtfTeamT.CTF_NOTEAM)).toBe("UNKNOWN");
  });

  test("CTFOtherTeamName is the inverse mapping", () => {
    expect(CTFOtherTeamName(CtfTeamT.CTF_TEAM1)).toBe("BLUE");
    expect(CTFOtherTeamName(CtfTeamT.CTF_TEAM2)).toBe("RED");
    expect(CTFOtherTeamName(CtfTeamT.CTF_NOTEAM)).toBe("UNKNOWN");
  });

  test("CTFOtherTeam swaps team constants and rejects CTF_NOTEAM", () => {
    expect(CTFOtherTeam(CtfTeamT.CTF_TEAM1)).toBe(CtfTeamT.CTF_TEAM2);
    expect(CTFOtherTeam(CtfTeamT.CTF_TEAM2)).toBe(CtfTeamT.CTF_TEAM1);
    expect(CTFOtherTeam(CtfTeamT.CTF_NOTEAM)).toBe(-1);
  });
});

describe("CTFPickup_Flag -- limited by the not-yet-ported g_items.c ctf delta", () => {
  test("touching a fabricated item_flag_team1 edict is a safe no-op until flag items are registered", () => {
    setupWorld();
    // CTFSpawn() looks up "item_flag_team1"/"item_flag_team2" via
    // FindItemByClassname; the base (non-ctf) itemlist this test's g_items.ts
    // sibling ships does not define those items yet (that's the g_items.c
    // ctf delta, a different unit), so CTFSpawn leaves both module-private
    // flag item pointers null.
    CTFSpawn();

    const flag = g_edicts[1];
    flag.inuse = true;
    flag.classname = "item_flag_team1";
    flag.spawnflags = 0;

    const other = makePlayer(2 % MAXENTITIES);
    other.client!.resp.ctf_team = CtfTeamT.CTF_TEAM1;

    // as far as this unit's siblings allow: no flag item is registered, so
    // pickup must decline (not throw, not silently assign carry state).
    expect(CTFPickup_Flag(flag, other)).toBe(false);
    expect(other.client!.pers.inventory.every((n) => n === 0)).toBe(true);
  });
});

describe("tech spawn timing", () => {
  test("CTFSetupTechSpawn schedules a think 2 seconds out", () => {
    setupWorld();
    level.time = 100;

    CTFSetupTechSpawn();

    // G_Spawn() hands out the first free edict past the player range
    // (index maxclients + 1); that's the timer entity CTFSetupTechSpawn just
    // configured.
    const timer = g_edicts[MAXCLIENTS + 1];
    expect(timer.inuse).toBe(true);
    expect(timer.nextthink).toBe(level.time + 2);
    expect(typeof timer.think).toBe("function");
  });

  test("CTFSetupTechSpawn is a no-op when DF_CTF_NO_TECH is set", () => {
    setupWorld();
    gameCvars.dmflags = fakeCvar(524288); // DF_CTF_NO_TECH
    const before = globals.num_edicts;

    CTFSetupTechSpawn();

    expect(globals.num_edicts).toBe(before);
  });
});

describe("grapple fire", () => {
  test("CTFFireGrapple spawns a MOVETYPE_FLYMISSILE hook owned by the firer", () => {
    setupWorld();
    const self = makePlayer(1);

    // no immediate impact: let the hook fly
    traceQueue.push({ ...defaultTrace(), fraction: 1 });

    CTFFireGrapple(self, vec3(0, 0, 0), vec3(1, 0, 0), 10, 650, 0);

    const hook = self.client!.ctf_grapple;
    expect(hook).not.toBeNull();
    expect(hook!.movetype).toBe(MovetypeT.MOVETYPE_FLYMISSILE);
    expect(hook!.solid).toBe(SolidT.SOLID_BBOX);
    expect(hook!.owner).toBe(self);
    expect(hook!.touch).toBe(CTFGrappleTouch);
  });
});

describe("PMenu_Open", () => {
  test("opens a menu and writes an svc_layout string via WriteByte/WriteString", () => {
    const rec = setupWorld();
    const ent = makePlayer(1);

    const entries = [new PmenuT("Join Red Team", PMENU_ALIGN_LEFT, () => {}), new PmenuT("Join Blue Team", PMENU_ALIGN_LEFT, () => {})];

    const hnd = PMenu_Open(ent, entries, 0, entries.length, null);

    expect(hnd).not.toBeNull();
    expect(ent.client!.menu).toBe(hnd);
    expect(ent.client!.showscores).toBe(true);
    expect(rec.writeByte).toContain(svc_layout);
    expect(rec.writeString.length).toBeGreaterThan(0);
    const layout = rec.writeString[0]!;
    expect(layout).toContain("Join Red Team");
    expect(layout).toContain("Join Blue Team");
  });
});
