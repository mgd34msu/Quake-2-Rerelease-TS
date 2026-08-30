import { describe, expect, test, beforeEach } from "bun:test";
import type { Edict, GameImports, GTraceT } from "../src/game/game";
import { GetGameAPI } from "../src/game/g_main";
import { EdictT, g_edicts, game, gameCvars, globals, level, SetGEdicts } from "../src/game/g_local";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import { vec3 } from "../src/shared/math";
import {
  ipFilterList,
  ServerCommand,
  StringToFilter,
  SV_FilterPacket,
  SVCmd_AddIP_f,
  SVCmd_RemoveIP_f,
} from "../src/game/g_svcmds";
import { AnglesNormalize, SnapToEights, turret_breach_fire } from "../src/game/g_turret";

// ---------------------------------------------------------------------------
// fake GameImports: scriptable argc/argv (for ServerCommand/SVCmd_* dispatch),
// a cprintf recorder, and recorders for sound/linkentity so turret_breach_fire
// can be verified without a real server. Modeled after test/g_weapon.test.ts's
// makeFakeGameImports/setupWorld pattern.
// ---------------------------------------------------------------------------

interface Recorder {
  cprintf: string[];
  positionedSound: Array<{ origin: [number, number, number]; channel: number; soundindex: number; volume: number; attenuation: number }>;
  linkentity: Edict[];
}

function makeRecorder(): Recorder {
  return { cprintf: [], positionedSound: [], linkentity: [] };
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

let currentArgs: string[] = [];

function setArgs(args: string[]): void {
  currentArgs = args;
}

function makeFakeGameImports(rec: Recorder): GameImports {
  return {
    bprintf() {},
    dprintf() {},
    cprintf(_ent, _level, fmt) {
      rec.cprintf.push(fmt);
    },
    centerprintf() {},
    sound() {},
    positioned_sound(origin, _ent, channel, soundindex, volume, attenuation) {
      rec.positionedSound.push({
        origin: [origin[0], origin[1], origin[2]],
        channel,
        soundindex,
        volume,
        attenuation,
      });
    },
    configstring() {},
    error(fmt): never {
      throw new Error(`gi.error: ${fmt}`);
    },
    modelindex() {
      return 0;
    },
    soundindex() {
      return 7;
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
    linkentity(ent) {
      rec.linkentity.push(ent);
    },
    unlinkentity() {},
    BoxEdicts() {
      return 0;
    },
    Pmove() {},
    multicast() {},
    unicast() {},
    WriteChar() {},
    WriteByte() {},
    WriteShort() {},
    WriteLong() {},
    WriteFloat() {},
    WriteString() {},
    WritePosition() {},
    WriteDir() {},
    WriteAngle() {},
    cvar(name) {
      if (name === "game") {
        const c = new CvarT();
        c.string = "";
        return c;
      }
      return null;
    },
    cvar_set() {
      return null;
    },
    cvar_forceset() {
      return null;
    },
    argc() {
      return currentArgs.length;
    },
    argv(n) {
      return currentArgs[n] ?? "";
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

function setupWorld(): Recorder {
  const rec = makeRecorder();
  GetGameAPI(makeFakeGameImports(rec));

  const edicts: EdictT[] = Array.from({ length: MAXENTITIES }, () => new EdictT());
  edicts.forEach((e, i) => {
    e.s.number = i;
  });
  SetGEdicts(edicts);

  game.clear();
  game.maxclients = 1;
  game.maxentities = MAXENTITIES;

  level.clear();

  gameCvars.maxclients = fakeCvar(1);
  gameCvars.skill = fakeCvar(1);
  gameCvars.deathmatch = fakeCvar(0);
  gameCvars.filterban = fakeCvar(1);

  globals.num_edicts = MAXENTITIES;

  currentArgs = [];
  ipFilterList.clear();

  return rec;
}

beforeEach(() => {
  setupWorld();
});

// ---------------------------------------------------------------------------

describe("StringToFilter", () => {
  test("parses a fully-specified dotted quad into packed mask/compare", () => {
    const result = StringToFilter("192.246.40.0");

    expect(result.ok).toBe(true);
    // mask: every fully-specified octet contributes 0xff, little-endian packed
    expect(result.mask).toBe(0x00ffffff);
    // compare: 192 | 246<<8 | 40<<16 | 0<<24
    expect(result.compare).toBe(192 | (246 << 8) | (40 << 16));
  });

  test("an unspecified trailing octet leaves that byte's mask at 0 (class C wildcard)", () => {
    const result = StringToFilter("192.246.40");

    expect(result.ok).toBe(true);
    expect(result.mask).toBe(0x00ffffff); // only the first 3 octets got mask bytes set
    expect(result.compare).toBe(192 | (246 << 8) | (40 << 16));
  });

  test("rejects a non-numeric address", () => {
    const result = StringToFilter("abc.def");
    expect(result.ok).toBe(false);
  });
});

describe("SV_FilterPacket", () => {
  test("filterban=1 (default): a listed address is rejected", () => {
    const parsed = StringToFilter("192.246.40.0");
    ipFilterList.filters.push({ mask: parsed.mask, compare: parsed.compare });

    expect(SV_FilterPacket("192.246.40.5")).toBe(true); // matches the /24, filterban=1 -> blocked
    expect(SV_FilterPacket("10.0.0.1")).toBe(false); // not listed -> allowed
  });

  test("filterban=0: only a listed address is allowed", () => {
    gameCvars.filterban = fakeCvar(0);
    const parsed = StringToFilter("192.246.40.0");
    ipFilterList.filters.push({ mask: parsed.mask, compare: parsed.compare });

    expect(SV_FilterPacket("192.246.40.5")).toBe(false); // listed -> allowed
    expect(SV_FilterPacket("10.0.0.1")).toBe(true); // not listed -> blocked
  });
});

describe("addip / removeip round-trip", () => {
  test("addip inserts a filter that SV_FilterPacket then matches, removeip clears it", () => {
    setArgs(["sv", "addip", "192.246.40.0"]);
    SVCmd_AddIP_f();

    expect(ipFilterList.filters.length).toBe(1);
    expect(SV_FilterPacket("192.246.40.7")).toBe(true);

    setArgs(["sv", "removeip", "192.246.40.0"]);
    SVCmd_RemoveIP_f();

    expect(ipFilterList.filters.length).toBe(0);
    expect(SV_FilterPacket("192.246.40.7")).toBe(false);
  });

  test("ServerCommand dispatches addip/listip/removeip by argv(1), case-insensitively", () => {
    const rec = setupWorld();

    setArgs(["sv", "ADDIP", "10.1.2.0"]);
    ServerCommand();
    expect(ipFilterList.filters.length).toBe(1);

    setArgs(["sv", "listip"]);
    ServerCommand();
    expect(rec.cprintf.some((m) => m.includes("Filter list"))).toBe(true);

    setArgs(["sv", "removeip", "10.1.2.0"]);
    ServerCommand();
    expect(ipFilterList.filters.length).toBe(0);
  });

  test("addip with a bad address is rejected and does not register a filter", () => {
    setArgs(["sv", "addip", "not-an-ip"]);
    SVCmd_AddIP_f();

    // the slot is consumed but marked permanently invalid (compare = 0xffffffff),
    // matching g_svcmds.c's StringToFilter-failure handling
    expect(ipFilterList.filters.length).toBe(1);
    expect(ipFilterList.filters[0].compare >>> 0).toBe(0xffffffff);
  });
});

describe("turret AnglesNormalize / SnapToEights", () => {
  test("AnglesNormalize wraps pitch and yaw into [0, 360)", () => {
    const v = vec3(400, -30, 999); // roll (index 2) is untouched by AnglesNormalize
    AnglesNormalize(v);
    expect(v[0]).toBeCloseTo(40, 5);
    expect(v[1]).toBeCloseTo(330, 5);
    expect(v[2]).toBe(999);
  });

  test("AnglesNormalize handles multiple wraps", () => {
    const v = vec3(725, -725, 0);
    AnglesNormalize(v);
    expect(v[0]).toBeCloseTo(5, 5);
    expect(v[1]).toBeCloseTo(355, 5);
  });

  test("SnapToEights quantizes to the nearest eighth", () => {
    // 1/8 = 0.125; SnapToEights(x) rounds x*8 to the nearest int, then /8
    expect(SnapToEights(1.0)).toBeCloseTo(1.0, 5);
    expect(SnapToEights(1.05)).toBeCloseTo(1.0, 5); // 1.05*8=8.4 -> rounds to 8 -> 1.0
    expect(SnapToEights(1.1)).toBeCloseTo(1.125, 5); // 1.1*8=8.8 -> rounds to 9 -> 1.125
    expect(SnapToEights(-1.1)).toBeCloseTo(-1.125, 5); // negative branch subtracts 0.5 before truncation
  });
});

describe("turret_breach_fire", () => {
  test("fires a rocket from the muzzle offset (move_origin along self.s.angles) with the driver as owner", () => {
    const rec = setupWorld();

    const breach = new EdictT();
    breach.s.number = 2; // must not collide with G_Spawn's first free slot below
    breach.s.origin.set([0, 0, 0]);
    breach.s.angles.set([0, 0, 0]); // forward=(1,0,0), right=(0,-1,0), up=(0,0,1)
    breach.move_origin.set([10, 5, 3]); // forward/right/up muzzle offsets, per g_turret.c

    const driver = new EdictT();
    breach.teammaster = breach; // self-teamed, matching g_spawn.c's solo-team convention
    breach.owner = driver; // teammaster === breach, so teammaster.owner === breach.owner

    turret_breach_fire(breach);

    // G_Spawn hands out g_edicts[maxclients+1] == g_edicts[2] first
    const rocket = g_edicts[2];
    expect(rocket.classname).toBe("rocket");
    expect(rocket.owner).toBe(driver);

    // start = origin + move_origin[0]*forward + move_origin[1]*right + move_origin[2]*up
    //       = (0,0,0) + 10*(1,0,0) + 5*(0,-1,0) + 3*(0,0,1) = (10,-5,3)
    expect(rocket.s.origin[0]).toBeCloseTo(10, 5);
    expect(rocket.s.origin[1]).toBeCloseTo(-5, 5);
    expect(rocket.s.origin[2]).toBeCloseTo(3, 5);

    // speed = 550 + 50*skill(1) = 600, direction is forward = (1,0,0)
    expect(rocket.velocity[0]).toBeCloseTo(600, 5);
    expect(rocket.velocity[1]).toBeCloseTo(0, 5);
    expect(rocket.velocity[2]).toBeCloseTo(0, 5);

    // damage = 100 + random()*50, truncated to int -> [100, 150)
    expect(rocket.dmg).toBeGreaterThanOrEqual(100);
    expect(rocket.dmg).toBeLessThan(150);
    expect(rocket.radius_dmg).toBe(rocket.dmg);

    expect(rec.positionedSound.length).toBe(1);
    const snd = rec.positionedSound[0];
    expect(snd.origin[0]).toBeCloseTo(10, 5);
    expect(snd.origin[1]).toBeCloseTo(-5, 5);
    expect(snd.origin[2]).toBeCloseTo(3, 5);
    expect(snd.channel).toBe(1); // CHAN_WEAPON
    expect(snd.soundindex).toBe(7); // fake soundindex() always returns 7
    expect(snd.attenuation).toBe(1); // ATTN_NORM
  });
});
