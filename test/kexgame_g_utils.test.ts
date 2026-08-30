/*
Unit tests for the kex g_utils.cpp / g_statusbar.h port (src/kexgame/g_utils.ts,
src/kexgame/g_statusbar.ts, src/kexgame/g_main_globals.ts).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: this file wires
up its own fake KexGameImports/KexGameExports and never relies on another
test file having run first. Modeled after test/rogue_systems.test.ts's own
"fake-imports fixture, modeled after test/g_utils.test.ts" style, adapted to
the kex API surface (KexGameImports/KexGameExports/KexEdictT, from
src/kexapi/game.ts).

Scope:
  - G_Spawn: lowest free slot past the reserved (maxclients) region, the
    500ms freed-edict reuse-delay guard, the "first 2 seconds of server
    time" bypass of that guard, and the "no free edicts" throw.
  - G_FreeEdict: marks free, sets freetime/classname, the "special edict"
    (<= maxclients + BODY_QUEUE_SIZE) no-op guard, and the already-free
    no-op guard.
  - G_Find / G_FindByString: predicate search skips !inuse, resumes after
    `from` (not from the start), case-insensitive exact-length string match.
  - G_PickTarget: single match, multiple matches (membership, not identity,
    since q_std.ts's `irandom` is Math.random()-backed and not seedable),
    no match, null targetname.
  - G_UseTargets: fires matching targets' use() callbacks; a nonzero
    `delay` spawns a DelayedUse entity instead of firing immediately.
  - G_SetMovedir: the VEC_UP/VEC_DOWN special cases and the general
    AngleVectors path, plus the "angles zeroed after" postcondition.
  - KillBox: the MOVETYPE_NOCLIP early-out (the only KillBox path this unit
    can exercise without the not-yet-ported T_Damage/G_ShouldPlayersCollide
    dependencies -- see g_utils.ts's own file header).
  - StatusbarT: exact-string chains hand-derived from
    ~/Projects/quake2-rerelease-dll/rerelease/g_statusbar.h's method bodies
    and g_spawn.cpp's real G_InitStatusbar() call sites, including the
    string()/string2()/loc_rstring() quoting rule's edge cases.
*/

import { describe, test, expect } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexTraceT } from "../src/kexapi/game";
import { GAME_API_VERSION } from "../src/kexapi/game";
import { type EdictT, MovetypeT } from "../src/kexgame/g_local";
import { defaultEdict, gi, globals, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { Gtime_from_ms } from "../src/kexgame/gtime";
import { G_Spawn, G_FreeEdict, G_Find, G_FindByString, G_PickTarget, G_UseTargets, G_SetMovedir, KillBox } from "../src/kexgame/g_utils";
import { StatusbarT } from "../src/kexgame/g_statusbar";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture
// ---------------------------------------------------------------------------

interface Recorder {
  comPrints: string[];
  broadcastPrints: { level: number; message: string }[];
  centerPrints: { message: string }[];
  soundCalls: number;
  unlinked: (KexEdictT | null)[];
  botUnregistered: number;
}

function makeRecorder(): Recorder {
  return { comPrints: [], broadcastPrints: [], centerPrints: [], soundCalls: 0, unlinked: [], botUnregistered: 0 };
}

const noHitTrace: KexTraceT = {
  allsolid: false,
  startsolid: false,
  fraction: 1,
  endpos: vec3(),
  plane: new CplaneT(),
  surface: null,
  contents: 0,
  ent: null,
  plane2: new CplaneT(),
  surface2: null,
};

function makeFakeGameImports(rec: Recorder): KexGameImports {
  const cvars = new Map<string, CvarT>();
  function getCvar(name: string, value: string): CvarT {
    let c = cvars.get(name);
    if (c === undefined) {
      c = new CvarT();
      c.name = name;
      c.string = value;
      c.value = Number(value);
      cvars.set(name, c);
    }
    return c;
  }

  return {
    tick_rate: 10,
    frame_time_s: 0.1,
    frame_time_ms: 100,
    Broadcast_Print(printlevel, message) {
      rec.broadcastPrints.push({ level: printlevel, message });
    },
    Com_Print(msg) {
      rec.comPrints.push(msg);
    },
    Client_Print() {},
    Center_Print(_ent, message) {
      rec.centerPrints.push({ message });
    },
    sound() {
      rec.soundCalls++;
    },
    positioned_sound() {},
    local_sound() {},
    configstring() {},
    get_configstring() {
      return "";
    },
    Com_Error(message): never {
      throw new Error(`gi.Com_Error: ${message}`);
    },
    modelindex() {
      return 0;
    },
    soundindex() {
      return 1;
    },
    imageindex() {
      return 0;
    },
    setmodel() {},
    trace() {
      return noHitTrace;
    },
    clip() {
      return noHitTrace;
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
    unlinkentity(ent) {
      rec.unlinked.push(ent);
    },
    BoxEdicts() {
      return 0;
    },
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
    WriteEntity() {},
    TagMalloc() {
      return null;
    },
    TagFree() {},
    FreeTags() {},
    cvar(var_name, value) {
      return getCvar(var_name, value ?? "0");
    },
    cvar_set(var_name, value) {
      return getCvar(var_name, value);
    },
    cvar_forceset(var_name, value) {
      return getCvar(var_name, value);
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
    GetExtension() {
      return null;
    },
    Bot_RegisterEdict() {},
    Bot_UnRegisterEdict() {
      rec.botUnregistered++;
    },
    Bot_MoveToPoint() {
      return 0;
    },
    Bot_FollowActor() {
      return 0;
    },
    GetPathToGoal() {
      return false;
    },
    Loc_Print() {},
    Draw_Line() {},
    Draw_Point() {},
    Draw_Circle() {},
    Draw_Bounds() {},
    Draw_Sphere() {},
    Draw_OrientedWorldText() {},
    Draw_StaticWorldText() {},
    Draw_Cylinder() {},
    Draw_Ray() {},
    Draw_Arrow() {},
    ReportMatchDetails_Multicast() {},
    ServerFrame() {
      return 0;
    },
    SendToClipBoard() {},
    Info_ValueForKey() {
      return 0;
    },
    Info_RemoveKey() {
      return false;
    },
    Info_SetValueForKey() {
      return false;
    },
  };
}

function makeFakeGameExports(edicts: EdictT[], numEdicts: number): KexGameExports {
  return {
    apiversion: GAME_API_VERSION,
    PreInit() {},
    Init() {},
    Shutdown() {},
    SpawnEntities() {},
    WriteGameJson() {
      return null;
    },
    ReadGameJson() {},
    WriteLevelJson() {
      return null;
    },
    ReadLevelJson() {},
    CanSave() {
      return true;
    },
    ClientChooseSlot() {
      return null;
    },
    ClientConnect() {
      return false;
    },
    ClientBegin() {},
    ClientUserinfoChanged() {},
    ClientDisconnect() {},
    ClientCommand() {},
    ClientThink() {},
    RunFrame() {},
    PrepFrame() {},
    ServerCommand() {},
    edicts,
    num_edicts: numEdicts,
    max_edicts: edicts.length,
    server_flags: 0,
    Pmove() {},
    GetExtension() {
      return null;
    },
    Bot_SetWeapon() {},
    Bot_TriggerEdict() {},
    Bot_UseItem() {},
    Bot_GetItemID() {
      return 0;
    },
    Edict_ForceLookAtPoint() {},
    Bot_PickedUpItem() {
      return false;
    },
    Entity_IsVisibleToPlayer() {
      return false;
    },
    GetShadowLightData() {
      return null;
    },
  };
}

/** Preallocates `count` blank edicts (mirroring the not-yet-ported InitGame
 *  path's own responsibility -- see g_main_globals.ts's file header) and
 *  wires up gi/globals/g_edicts/game/level for one test. */
function setupWorld(maxclients: number, maxentities: number, numEdicts: number): { edicts: EdictT[]; rec: Recorder } {
  const edicts: EdictT[] = [];
  for (let i = 0; i < maxentities; i++) {
    const e = defaultEdict();
    e.s.number = i;
    edicts.push(e);
  }
  SetGEdicts(edicts);
  game.maxclients = maxclients;
  game.maxentities = maxentities;
  level.time = Gtime_from_ms(0);

  const rec = makeRecorder();
  SetGameImports(makeFakeGameImports(rec));
  SetGameExports(makeFakeGameExports(edicts, numEdicts));

  return { edicts, rec };
}

// ---------------------------------------------------------------------------
// G_Spawn
// ---------------------------------------------------------------------------

describe("G_Spawn", () => {
  test("allocates the lowest free slot past the reserved (maxclients) region", () => {
    const { edicts } = setupWorld(4, 64, 5); // slots 0..4 reserved for the world+clients
    const e = G_Spawn();
    expect(e).toBe(edicts[5]);
    expect(e.inuse).toBe(true);
    expect(e.classname).toBe("noclass");
    expect(globals.num_edicts).toBe(6);
  });

  test("skips inuse edicts and returns the next free one within range", () => {
    const { edicts } = setupWorld(4, 64, 8);
    edicts[5]!.inuse = true;
    edicts[6]!.inuse = true;
    // edicts[7] left free (default: inuse=false, freetime=0)
    const e = G_Spawn();
    expect(e).toBe(edicts[7]);
  });

  test("grows num_edicts when no free slot exists in the current range", () => {
    const { edicts } = setupWorld(0, 64, 2);
    edicts[1]!.inuse = true; // the only in-range candidate is occupied
    const e = G_Spawn();
    expect(e).toBe(edicts[2]); // freshly initialized, past the old num_edicts
    expect(globals.num_edicts).toBe(3);
  });

  test("throws (via gi.Com_Error) when the array is exhausted at maxentities", () => {
    setupWorld(0, 2, 2);
    g_edicts[1]!.inuse = true; // fully occupied, i will reach maxentities
    expect(() => G_Spawn()).toThrow();
  });

  test("reuse-delay: a freed edict inside the 500ms window is NOT reused", () => {
    const { edicts } = setupWorld(4, 64, 6);
    level.time = Gtime_from_ms(10_000); // well past the first-2-seconds grace period
    edicts[5]!.inuse = false;
    edicts[5]!.freetime = Gtime_from_ms(9_800); // freed 200ms ago -- inside the guard window
    const e = G_Spawn();
    expect(e).not.toBe(edicts[5]);
    expect(e).toBe(edicts[6]); // falls through to growing the array instead
  });

  test("reuse-delay: a freed edict past the 500ms window IS reused", () => {
    const { edicts } = setupWorld(4, 64, 6);
    level.time = Gtime_from_ms(10_000);
    edicts[5]!.inuse = false;
    edicts[5]!.freetime = Gtime_from_ms(9_000); // freed 1000ms ago -- past the guard window
    const e = G_Spawn();
    expect(e).toBe(edicts[5]);
  });

  test("reuse-delay: bypassed during the first 2 seconds of server time", () => {
    const { edicts } = setupWorld(4, 64, 6);
    level.time = Gtime_from_ms(1_000); // under the 2-second grace period
    edicts[5]!.inuse = false;
    edicts[5]!.freetime = Gtime_from_ms(900); // only 100ms ago -- would fail the 500ms check alone
    const e = G_Spawn();
    expect(e).toBe(edicts[5]); // grace period bypasses the delay regardless
  });
});

// ---------------------------------------------------------------------------
// G_FreeEdict
// ---------------------------------------------------------------------------

describe("G_FreeEdict", () => {
  test("marks the edict free and stamps freetime/classname", () => {
    // index must be past maxclients + BODY_QUEUE_SIZE (4 + 8 = 12) or the
    // "special edict" guard below applies instead -- see that test.
    const { edicts } = setupWorld(4, 64, 20);
    const e = edicts[15]!;
    e.inuse = true;
    e.spawn_count = 3;
    level.time = Gtime_from_ms(12_345);

    G_FreeEdict(e);

    expect(e.inuse).toBe(false);
    expect(e.classname).toBe("freed");
    expect(e.freetime).toBe(Gtime_from_ms(12_345));
    expect(e.spawn_count).toBe(4);
  });

  test("special edicts (index <= maxclients + BODY_QUEUE_SIZE) are left inuse", () => {
    // maxclients=4, BODY_QUEUE_SIZE=8 (g_local.ts) -> indices 0..12 are "special"
    const { edicts, rec } = setupWorld(4, 64, 20);
    const e = edicts[10]!;
    e.inuse = true;
    e.classname = "player";

    G_FreeEdict(e);

    expect(e.inuse).toBe(true); // untouched past the special-edict guard
    expect(e.classname).toBe("player");
    expect(rec.unlinked).toContain(e); // gi.unlinkentity still runs before the guard
  });

  test("already-free edicts are a no-op (gi.unlinkentity is never called)", () => {
    const { edicts, rec } = setupWorld(4, 64, 20);
    const e = edicts[15]!;
    e.inuse = false;

    G_FreeEdict(e);

    expect(rec.unlinked).not.toContain(e);
  });
});

// ---------------------------------------------------------------------------
// G_Find / G_FindByString
// ---------------------------------------------------------------------------

describe("G_Find", () => {
  test("skips !inuse candidates even when they match the predicate", () => {
    const { edicts } = setupWorld(0, 20, 20);
    edicts[5]!.classname = "foo";
    edicts[5]!.inuse = false; // matches by content, but must be skipped
    edicts[7]!.classname = "foo";
    edicts[7]!.inuse = true;

    const found = G_Find(null, (e) => e.classname === "foo");
    expect(found).toBe(edicts[7]);
  });

  test("resumes scanning strictly after `from`, not from the start", () => {
    const { edicts } = setupWorld(0, 20, 20);
    edicts[7]!.classname = "foo";
    edicts[7]!.inuse = true;

    const foundAfter = G_Find(edicts[7]!, (e) => e.classname === "foo");
    expect(foundAfter).toBeNull();
  });

  test("returns null once every candidate has been scanned", () => {
    const { edicts } = setupWorld(0, 20, 20);
    expect(G_Find(null, (e) => e.classname === "nope")).toBeNull();
    void edicts;
  });
});

describe("G_FindByString", () => {
  test("matches case-insensitively on exact length", () => {
    const { edicts } = setupWorld(0, 20, 20);
    edicts[10]!.targetname = "Door1";
    edicts[10]!.inuse = true;

    expect(G_FindByString(null, "targetname", "door1")).toBe(edicts[10]);
    expect(G_FindByString(null, "targetname", "door1x")).toBeNull();
    expect(G_FindByString(null, "targetname", "door")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// G_PickTarget
// ---------------------------------------------------------------------------

describe("G_PickTarget", () => {
  test("returns null immediately for a null targetname", () => {
    setupWorld(0, 20, 20);
    expect(G_PickTarget(null)).toBeNull();
  });

  test("returns null and logs when nothing matches", () => {
    const { rec } = setupWorld(0, 20, 20);
    expect(G_PickTarget("nope")).toBeNull();
    expect(rec.comPrints.some((m) => m.includes("nope"))).toBe(true);
  });

  test("returns the single match", () => {
    const { edicts } = setupWorld(0, 20, 20);
    edicts[5]!.targetname = "goal";
    edicts[5]!.inuse = true;

    expect(G_PickTarget("goal")).toBe(edicts[5]);
  });

  test("returns one of several matches (membership, not identity -- irandom is not seedable)", () => {
    const { edicts } = setupWorld(0, 20, 20);
    const candidates = [edicts[5]!, edicts[6]!, edicts[7]!];
    for (const c of candidates) {
      c.targetname = "multi";
      c.inuse = true;
    }

    for (let i = 0; i < 20; i++) {
      const picked = G_PickTarget("multi");
      expect(picked).not.toBeNull();
      expect(candidates).toContain(picked!);
    }
  });
});

// ---------------------------------------------------------------------------
// G_UseTargets
// ---------------------------------------------------------------------------

describe("G_UseTargets", () => {
  test("fires every matching target's use() callback with the given activator", () => {
    const { edicts } = setupWorld(0, 20, 20);
    const ent = edicts[5]!;
    ent.target = "door";
    ent.inuse = true;

    const target = edicts[6]!;
    target.targetname = "door";
    target.inuse = true;
    const usedByCalls: (EdictT | null)[] = [];
    target.use = (_self, _other, activator) => {
      usedByCalls.push(activator);
    };

    const activator = edicts[7]!;
    activator.inuse = true;

    G_UseTargets(ent, activator);

    expect(usedByCalls).toEqual([activator]);
  });

  test("a nonzero delay spawns a DelayedUse entity instead of firing immediately", () => {
    const { edicts } = setupWorld(0, 20, 20);
    const ent = edicts[5]!;
    ent.target = "door";
    ent.delay = 2; // seconds
    ent.inuse = true;

    const target = edicts[6]!;
    target.targetname = "door";
    target.inuse = true;
    let fired = false;
    target.use = () => {
      fired = true;
    };

    level.time = Gtime_from_ms(1_000);
    const activator = edicts[7]!;
    activator.inuse = true;

    G_UseTargets(ent, activator);

    expect(fired).toBe(false); // not fired immediately
    // G_Spawn's own reuse policy (tested separately above) decides which
    // slot the DelayedUse edict lands in; find it by content instead of
    // assuming a specific index or that the array had to grow.
    const spawned = g_edicts.find((e) => e.classname === "DelayedUse");
    expect(spawned).toBeDefined();
    expect(spawned!.nextthink).toBe(Gtime_from_ms(3_000)); // level.time(1000) + delay(2s)
    expect(spawned!.activator).toBe(activator);
  });
});

// ---------------------------------------------------------------------------
// G_SetMovedir
// ---------------------------------------------------------------------------

describe("G_SetMovedir", () => {
  test("VEC_UP (0,-1,0) maps to straight-up movedir and zeroes angles", () => {
    setupWorld(0, 4, 4);
    const angles = vec3(0, -1, 0);
    const movedir = vec3();
    G_SetMovedir(angles, movedir);
    expect(Array.from(movedir)).toEqual([0, 0, 1]);
    expect(Array.from(angles)).toEqual([0, 0, 0]);
  });

  test("VEC_DOWN (0,-2,0) maps to straight-down movedir and zeroes angles", () => {
    setupWorld(0, 4, 4);
    const angles = vec3(0, -2, 0);
    const movedir = vec3();
    G_SetMovedir(angles, movedir);
    expect(Array.from(movedir)).toEqual([0, 0, -1]);
    expect(Array.from(angles)).toEqual([0, 0, 0]);
  });

  test("any other angle uses AngleVectors' forward vector and zeroes angles", () => {
    setupWorld(0, 4, 4);
    const angles = vec3(0, 0, 0); // facing +X
    const movedir = vec3();
    G_SetMovedir(angles, movedir);
    expect(movedir[0]).toBeCloseTo(1, 5);
    expect(movedir[1]).toBeCloseTo(0, 5);
    expect(movedir[2]).toBeCloseTo(0, 5);
    expect(Array.from(angles)).toEqual([0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// KillBox (only the path reachable without the not-yet-ported
// T_Damage/G_ShouldPlayersCollide dependencies -- see g_utils.ts's header)
// ---------------------------------------------------------------------------

describe("KillBox", () => {
  test("returns true immediately for a MOVETYPE_NOCLIP entity", () => {
    const { edicts } = setupWorld(0, 4, 4);
    const ent = edicts[1]!;
    ent.movetype = MovetypeT.MOVETYPE_NOCLIP;
    expect(KillBox(ent, false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// StatusbarT -- exact-string evidence
// ---------------------------------------------------------------------------
// Every expected string below is hand-derived from g_statusbar.h's method
// bodies (each appends "<token> [args] " with a trailing space) and, where
// noted, from real call sites in g_spawn.cpp's G_InitStatusbar().

describe("StatusbarT", () => {
  test("g_spawn.cpp:1287-1289 -- health readout chain", () => {
    // sb.yb(-24); sb.xv(0).hnum().xv(50).pic(STAT_HEALTH_ICON=2);
    const sb = new StatusbarT();
    sb.yb(-24);
    sb.xv(0).hnum().xv(50).pic(2);
    expect(sb.str()).toBe("yb -24 xv 0 hnum xv 50 pic 2 ");
  });

  test("g_spawn.cpp:1291-1292 -- ammo ifstat/endifstat chain", () => {
    // sb.ifstat(STAT_AMMO_ICON=3).xv(100).anum().xv(150).pic(3).endifstat();
    const sb = new StatusbarT();
    sb.ifstat(3).xv(100).anum().xv(150).pic(3).endifstat();
    expect(sb.str()).toBe("if 3 xv 100 anum xv 150 pic 3 endif ");
  });

  test("armor chain uses rnum()", () => {
    const sb = new StatusbarT();
    sb.ifstat(4).xv(200).rnum().xv(250).pic(4).endifstat();
    expect(sb.str()).toBe("if 4 xv 200 rnum xv 250 pic 4 endif ");
  });

  test("num(width, stat) -- timer readout shape", () => {
    const sb = new StatusbarT();
    sb.xv(262).num(2, 21).xv(296);
    expect(sb.str()).toBe("xv 262 num 2 21 xv 296 ");
  });

  test("yt/xl/xr/yv all emit their own token name", () => {
    const sb = new StatusbarT();
    sb.yt(0).xl(1).xr(2).yv(3);
    expect(sb.str()).toBe("yt 0 xl 1 xr 2 yv 3 ");
  });

  test("loc_stat_string / loc_stat_rstring / stat_string / loc_stat_cstring2", () => {
    const sb = new StatusbarT();
    sb.loc_stat_string(30).loc_stat_rstring(31).stat_string(32).loc_stat_cstring2(33);
    expect(sb.str()).toBe("loc_stat_string 30 loc_stat_rstring 31 stat_string 32 loc_stat_cstring2 33 ");
  });

  test("lives_num / stat_pname / health_bars / story", () => {
    const sb = new StatusbarT();
    sb.lives_num(9).stat_pname(9).health_bars().story();
    expect(sb.str()).toBe("lives_num 9 stat_pname 9 health_bars story ");
  });

  test("picn() emits the raw icon name token", () => {
    const sb = new StatusbarT();
    sb.picn("sbfm/health");
    expect(sb.str()).toBe("picn sbfm/health ");
  });

  test("string() with no space/newline is NOT quoted", () => {
    const sb = new StatusbarT();
    sb.string("hello");
    expect(sb.str()).toBe("string hello ");
  });

  test("string() containing a space IS quoted", () => {
    const sb = new StatusbarT();
    sb.string("hello world");
    expect(sb.str()).toBe('string "hello world" ');
  });

  test("string2() containing a newline IS quoted", () => {
    const sb = new StatusbarT();
    sb.string2("line1\nline2");
    expect(sb.str()).toBe('string2 "line1\nline2" ');
  });

  test("string() already starting with a quote is NEVER re-quoted, even with spaces", () => {
    const sb = new StatusbarT();
    sb.string('"already quoted x');
    // str[0] === '"' short-circuits the whole quoting condition to false in
    // the C++ source -- the value is emitted completely as-is.
    expect(sb.str()).toBe('string "already quoted x ');
  });

  test("loc_rstring() inserts the fixed arg-count 0 and quotes on spaces", () => {
    const sb = new StatusbarT();
    sb.loc_rstring("Multi Word");
    expect(sb.str()).toBe('loc_rstring 0 "Multi Word" ');
  });

  test("loc_rstring() without spaces is not quoted", () => {
    const sb = new StatusbarT();
    sb.loc_rstring("SingleWord");
    expect(sb.str()).toBe("loc_rstring 0 SingleWord ");
  });

  test("a full representative multi-line chain matches token-for-token", () => {
    // Hand-derived from g_spawn.cpp:1300-1303 (picked-up-item readout).
    const sb = new StatusbarT();
    sb
      .ifstat(6)
      .xv(0)
      .pic(6)
      .xv(26)
      .yb(-42)
      .loc_stat_string(7)
      .yb(-50)
      .endifstat();
    expect(sb.str()).toBe("if 6 xv 0 pic 6 xv 26 yb -42 loc_stat_string 7 yb -50 endif ");
  });
});
