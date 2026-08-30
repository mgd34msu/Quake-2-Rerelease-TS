import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CS_PLAYERSKINS, CvarT, type PmoveT, UsercmdT } from "../src/shared/q_shared";
import type { Edict, GameImports, GTraceT } from "../src/game/game";
import { GetGameAPI } from "../src/game/g_main";
import {
  DEAD_NO,
  EdictT,
  GClientT,
  MovetypeT,
  g_edicts,
  game,
  gameCvars,
  globals,
  level,
  SetGEdicts,
} from "../src/game/g_local";
import { InitItems } from "../src/game/g_items";
import {
  ClientConnect,
  ClientThink,
  ClientUserinfoChanged,
  CopyToBodyQue,
  InitClientPersistant,
  SelectRandomDeathmatchSpawnPoint,
} from "../src/game/p_client";

// ---------------------------------------------------------------------------
// fake GameImports: modeled after test/g_spawn.test.ts's buildFakeImports/
// setupWorld and test/g_monster.test.ts's per-test trace override, extended
// with the recorders p_client.ts's functions actually touch (configstring,
// WriteByte/WriteShort/WriteString/unicast, Pmove).
// ---------------------------------------------------------------------------

const MAXENTITIES = 16;

interface Recorder {
  configstring: Array<{ num: number; str: string }>;
  writeBytes: number[];
  writeShorts: number[];
  writeStrings: string[];
  pmoveCalls: PmoveT[];
}

function makeRecorder(): Recorder {
  return { configstring: [], writeBytes: [], writeShorts: [], writeStrings: [], pmoveCalls: [] };
}

function fakeCvar(value: number, str = ""): CvarT {
  const c = new CvarT();
  c.value = value;
  c.string = str;
  return c;
}

function defaultTrace(end: import("../src/shared/math").Vec3): GTraceT {
  return {
    allsolid: false,
    startsolid: false,
    fraction: 1,
    endpos: vec3(end[0], end[1], end[2]),
    plane: new CplaneT(),
    surface: null,
    contents: 0,
    ent: null,
  };
}

function buildFakeImports(rec: Recorder, pmoveImpl?: (pmove: PmoveT) => void): GameImports {
  return {
    bprintf: () => {},
    dprintf: () => {},
    cprintf: () => {},
    centerprintf: () => {},
    sound: () => {},
    positioned_sound: () => {},
    configstring: (num: number, str: string) => {
      rec.configstring.push({ num, str });
    },
    error: (fmt: string): never => {
      throw new Error(fmt);
    },
    modelindex: () => 0,
    soundindex: () => 0,
    imageindex: () => 0,
    setmodel: () => {},
    trace: (_start, _mins, _maxs, end) => defaultTrace(end),
    pointcontents: () => 0,
    inPVS: () => true,
    inPHS: () => true,
    SetAreaPortalState: () => {},
    AreasConnected: () => true,
    linkentity: () => {},
    unlinkentity: () => {},
    BoxEdicts: () => 0,
    Pmove: (pmove: PmoveT) => {
      rec.pmoveCalls.push(pmove);
      if (pmoveImpl) pmoveImpl(pmove);
    },
    multicast: () => {},
    unicast: () => {},
    WriteChar: () => {},
    WriteByte: (c: number) => {
      rec.writeBytes.push(c);
    },
    WriteShort: (c: number) => {
      rec.writeShorts.push(c);
    },
    WriteLong: () => {},
    WriteFloat: () => {},
    WriteString: (s: string) => {
      rec.writeStrings.push(s);
    },
    WritePosition: () => {},
    WriteDir: () => {},
    WriteAngle: () => {},
    cvar: () => null,
    cvar_set: () => null,
    cvar_forceset: () => null,
    argc: () => 0,
    argv: () => "",
    args: () => "",
    AddCommandString: () => {},
    DebugGraph: () => {},
  };
}

function resetGameCvars(): void {
  for (const key of Object.keys(gameCvars) as Array<keyof typeof gameCvars>) {
    gameCvars[key] = null;
  }
}

function setupWorld(rec: Recorder, pmoveImpl?: (pmove: PmoveT) => void): void {
  GetGameAPI(buildFakeImports(rec, pmoveImpl));

  const edicts: EdictT[] = Array.from({ length: MAXENTITIES }, () => new EdictT());
  edicts.forEach((e, i) => {
    e.s.number = i;
  });
  SetGEdicts(edicts);

  game.clear();
  game.maxclients = 1;
  game.maxentities = MAXENTITIES;
  game.clients = [new GClientT()];

  level.clear();

  resetGameCvars();
  gameCvars.maxclients = fakeCvar(1);
  gameCvars.maxspectators = fakeCvar(0);
  gameCvars.deathmatch = fakeCvar(0);
  gameCvars.coop = fakeCvar(0);
  gameCvars.dmflags = fakeCvar(0);
  gameCvars.filterban = fakeCvar(1); // C default: no ban list -> not banned
  gameCvars.password = fakeCvar(0, "");
  gameCvars.spectator_password = fakeCvar(0, "");
  gameCvars.sv_gravity = fakeCvar(800);

  globals.num_edicts = MAXENTITIES;

  // FindItem/FindItemByClassname bound their search by game.num_items
  // (see g_items.ts), which is only populated by InitItems().
  InitItems();
}

// ---------------------------------------------------------------------------

describe("InitClientPersistant", () => {
  test("grants the Blaster and the C-mandated starting health/ammo caps", () => {
    setupWorld(makeRecorder());
    const client = new GClientT();

    InitClientPersistant(client);

    expect(client.pers.weapon).not.toBeNull();
    expect(client.pers.weapon?.pickup_name).toBe("Blaster");
    expect(client.pers.inventory[client.pers.selected_item]).toBe(1);

    expect(client.pers.health).toBe(100);
    expect(client.pers.max_health).toBe(100);
    expect(client.pers.max_bullets).toBe(200);
    expect(client.pers.max_shells).toBe(100);
    expect(client.pers.max_rockets).toBe(50);
    expect(client.pers.max_grenades).toBe(50);
    expect(client.pers.max_cells).toBe(200);
    expect(client.pers.max_slugs).toBe(50);
    expect(client.pers.connected).toBe(true);
  });
});

describe("ClientUserinfoChanged", () => {
  test("extracts name/skin into a CS_PLAYERSKINS configstring and parses handedness", () => {
    setupWorld(makeRecorder());
    const rec = makeRecorder();
    GetGameAPI(buildFakeImports(rec));

    const ent = g_edicts[1];
    ent.s.number = 1;
    ent.client = new GClientT();

    ClientUserinfoChanged(ent, "\\name\\Player1\\skin\\male/grunt\\hand\\1");

    expect(ent.client.pers.netname).toBe("Player1");
    expect(ent.client.pers.hand).toBe(1);

    const playernum = ent.s.number - 1;
    const cs = rec.configstring.find((c) => c.num === CS_PLAYERSKINS + playernum);
    expect(cs).toBeDefined();
    expect(cs?.str).toBe("Player1\\male/grunt");
  });
});

describe("SelectRandomDeathmatchSpawnPoint", () => {
  test("returns one of the fabricated info_player_deathmatch spots", () => {
    setupWorld(makeRecorder());
    // maxclients=0 for this call so PlayersRangeFromSpot never finds a
    // player closer than its 9999999 sentinel, which keeps spot1/spot2 both
    // null and makes SelectRandomDeathmatchSpawnPoint deterministic
    // regardless of Math.random() (count collapses to 1, selection is
    // always floor(random()*1) === 0).
    gameCvars.maxclients = fakeCvar(0);

    const spots: EdictT[] = [];
    for (let i = 1; i <= 3; i++) {
      const spot = g_edicts[i];
      spot.inuse = true;
      spot.classname = "info_player_deathmatch";
      spot.s.origin.set([i * 10, 0, 0]);
      spots.push(spot);
    }

    const selected = SelectRandomDeathmatchSpawnPoint();

    expect(selected).not.toBeNull();
    expect(selected?.classname).toBe("info_player_deathmatch");
    expect(spots).toContain(selected as EdictT);
  });
});

describe("CopyToBodyQue", () => {
  test("round-robins through the body queue slots", () => {
    setupWorld(makeRecorder());
    // body slot index = maxclients + level.body_que + 1 (maxclients=1 here)
    const ent = g_edicts[1];
    ent.s.number = 1;

    ent.s.origin.set([1, 2, 3]);
    CopyToBodyQue(ent);
    expect(level.body_que).toBe(1);
    expect(g_edicts[2].s.origin[0]).toBe(1);
    expect(g_edicts[2].s.number).toBe(2);
    expect(g_edicts[2].takedamage).toBe(1); // DamageT.DAMAGE_YES

    ent.s.origin.set([4, 5, 6]);
    CopyToBodyQue(ent);
    expect(level.body_que).toBe(2);
    expect(g_edicts[3].s.origin[0]).toBe(4);

    ent.s.origin.set([7, 8, 9]);
    CopyToBodyQue(ent);
    expect(level.body_que).toBe(3);
    expect(g_edicts[4].s.origin[0]).toBe(7);
  });
});

describe("ClientConnect", () => {
  test("allows an IP-unbanned connection and returns the (unmutated) userinfo", () => {
    setupWorld(makeRecorder());
    const ent = g_edicts[1];
    ent.s.number = 1;
    ent.inuse = false;

    const userinfo = "\\name\\Newbie\\skin\\male/grunt\\ip\\127.0.0.1";
    const result = ClientConnect(ent, userinfo);

    expect(result.allowed).toBe(true);
    expect(ent.client).not.toBeNull();
    expect(ent.client?.pers.connected).toBe(true);
  });

  test("rejects a mismatched server password and sets rejmsg in the returned userinfo", () => {
    setupWorld(makeRecorder());
    gameCvars.password = fakeCvar(0, "secret");

    const ent = g_edicts[1];
    ent.s.number = 1;
    ent.inuse = false;

    const userinfo = "\\name\\Newbie\\skin\\male/grunt\\ip\\127.0.0.1";
    const result = ClientConnect(ent, userinfo);

    expect(result.allowed).toBe(false);
    expect(result.userinfo).toContain("rejmsg");
    expect(result.userinfo).toContain("Password required or incorrect.");
  });
});

describe("ClientThink", () => {
  test("drives gi.Pmove and copies the resulting origin back onto the entity (0.125 scale)", () => {
    const rec = makeRecorder();
    setupWorld(rec, (pmove) => {
      // pmove_state_t.origin is 12.3 fixed point (units * 8); 800 -> 100.0
      pmove.s.origin[0] = 800;
      pmove.s.origin[1] = 400;
      pmove.s.origin[2] = 0;
      pmove.viewangles.set([0, 0, 0]);
      pmove.mins.set([-16, -16, -24]);
      pmove.maxs.set([16, 16, 32]);
    });

    const ent = g_edicts[1];
    ent.s.number = 1;
    ent.client = new GClientT();
    ent.movetype = MovetypeT.MOVETYPE_WALK;
    ent.s.modelindex = 255;
    ent.deadflag = DEAD_NO;

    const ucmd = new UsercmdT();
    ucmd.angles.set([0, 0, 0]);

    ClientThink(ent, ucmd);

    expect(rec.pmoveCalls.length).toBe(1);
    expect(ent.s.origin[0]).toBeCloseTo(100, 5);
    expect(ent.s.origin[1]).toBeCloseTo(50, 5);
  });
});
