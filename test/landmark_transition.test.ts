/*
Landmark-relative level transitions in the CLASSIC game module.

THE RERELEASE RULE, in two halves.

  OUT (g_target.cpp:403-464 / src/kexgame/g_target.ts:637-659). A
  target_changelevel whose `target` names an info_landmark records, on the
  activator's client:

      landmark_name  = <the landmark's targetname>
      landmark_rel_pos = unrotate(activator.origin - landmark.origin,
                                  landmark.angles)
      oldvelocity      = unrotate(oldvelocity, landmark.angles)
      oldviewangles    = ps.viewangles - landmark.angles

  where unrotate() turns the vector about x by -angles[0], then about y by
  -angles[2], then about z by -angles[1] -- that axis order, those two
  swapped indices, is the C's.

  IN (p_client.cpp:1374-1426 / src/kexgame/p_client.ts:1887-1941,
  TryLandmarkSpawn). The destination map's identically-named info_landmark
  rotates landmark_rel_pos back the same way with POSITIVE angles, adds the
  landmark's origin, takes SPAWNFLAG_LANDMARK_KEEP_Z's z from the spawn
  point when set, runs G_FixStuckObject_Generic over the result, and on
  success replaces both the origin and the angles the spawn point gave, and
  rotates the carried velocity into the new frame too.

THE GATE. Everything above hangs off two pieces of content a 1997 map does
not have: a `target` on a target_changelevel, and an info_landmark to match
it. Section 2 below pins the vanilla path byte for byte with both missing.

WHAT EACH SIDE OF THE RETAIL SECTION DRIVES

  * The CLASSIC side is the real thing: real SpawnEntities() over the real
    entity bytes of the real destination map, then the real SelectSpawnPoint()
    with the landmark fields the real use_target_changelevel just wrote on
    the source map.
  * The reference is a transcription of the rerelease rule stated above,
    computed from the raw entity key/values with an independent parser and
    an independent rotation. Same idiom as test/spawn_start_rerelease.test.ts.

No retail content is copied into the repository: the .bsp bytes are read out
of the local install at test-run time, nothing is written to disk, and the
retail-gated block skips itself when the install is absent.
*/

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { RotatePointAroundVector, vec3, type Vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { GameImports, GTraceT } from "../src/game/game";
import { GetGameAPI } from "../src/game/g_main";
import { EdictT, GClientT, g_edicts, game, gameCvars, globals, level, SetGEdicts, st } from "../src/game/g_local";
import { SpawnEntities } from "../src/game/g_spawn";
import { InitItems } from "../src/game/g_items";
import { SelectSpawnPoint, SPAWNFLAG_LANDMARK_KEEP_Z, TryLandmarkSpawn } from "../src/game/p_client";
import { use_target_changelevel } from "../src/game/g_target";
import { deserializeGame, type GameJSON, serializeGame } from "../src/game/g_save";
import { G_FixStuckObject_Generic, G_Find, StuckResultT } from "../src/game/g_utils";

const RETAIL_PAK = "/home/buzzkill/q2rets/rerelease/baseq2/pak0.pak";
const haveRetail = existsSync(RETAIL_PAK);

const MAXENTITIES = 4096;
const MAXCLIENTS = 4;

function fakeCvar(value: number, str = ""): CvarT {
  const c = new CvarT();
  c.value = value;
  c.string = str;
  return c;
}

// ---------------------------------------------------------------------------
// Fixture. Same shape as test/spawn_start_rerelease.test.ts's, plus a trace
// the test can steer -- G_FixStuckObject_Generic is trace-driven and the
// stuck-fix cases below have to be able to say "this box is in solid".
// ---------------------------------------------------------------------------

/** A trace that reports clear space unless a test replaces it. */
let traceFn: (start: Vec3, mins: Vec3 | null, maxs: Vec3 | null, end: Vec3) => GTraceT = (_s, _mi, _ma, end) => openTrace(end);

function openTrace(end: Vec3): GTraceT {
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

function solidTrace(): GTraceT {
  const t = openTrace(vec3());
  t.startsolid = true;
  t.allsolid = true;
  t.fraction = 0;
  return t;
}

function buildFakeImports(): GameImports {
  let indexCounter = 0;
  const bump = (): number => ++indexCounter;

  return {
    bprintf: () => {},
    dprintf: () => {},
    cprintf: () => {},
    centerprintf: () => {},
    sound: () => {},
    positioned_sound: () => {},
    configstring: () => {},
    error: (fmt: string): never => {
      throw new Error(fmt);
    },
    modelindex: bump,
    soundindex: bump,
    imageindex: bump,
    setmodel: () => {},
    trace: (start, mins, maxs, end) => traceFn(start, mins, maxs, end),
    pointcontents: () => 0,
    inPVS: () => true,
    inPHS: () => true,
    SetAreaPortalState: () => {},
    AreasConnected: () => true,
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
    cvar: () => fakeCvar(0),
    cvar_set: (_n: string, value: string) => fakeCvar(0, value),
    cvar_forceset: (_n: string, value: string) => fakeCvar(0, value),
    argc: () => 0,
    argv: () => "",
    args: () => "",
    AddCommandString: () => {},
    DebugGraph: () => {},
  };
}

interface Ruleset {
  skill: number;
  deathmatch: number;
  coop: number;
}
const SINGLE_PLAYER: Ruleset = { skill: 1, deathmatch: 0, coop: 0 };
const COOP: Ruleset = { skill: 1, deathmatch: 0, coop: 1 };

function setupWorld(rules: Ruleset): void {
  traceFn = (_s, _mi, _ma, end) => openTrace(end);
  GetGameAPI(buildFakeImports());
  SetGEdicts(Array.from({ length: MAXENTITIES }, () => new EdictT()));

  game.clear();
  game.maxclients = MAXCLIENTS;
  game.maxentities = MAXENTITIES;
  // InitGame() is what allocates these in a real session; the fixture skips
  // InitGame, and the landmark carry-over lives on GClientT, so the array has
  // to exist here.
  game.clients = Array.from({ length: MAXCLIENTS }, () => new GClientT());

  level.clear();
  st.clear();

  for (const key of Object.keys(gameCvars) as Array<keyof typeof gameCvars>) gameCvars[key] = null;
  gameCvars.maxclients = fakeCvar(MAXCLIENTS);
  gameCvars.skill = fakeCvar(rules.skill);
  gameCvars.deathmatch = fakeCvar(rules.deathmatch);
  gameCvars.coop = fakeCvar(rules.coop);
  gameCvars.dmflags = fakeCvar(0);

  globals.num_edicts = MAXCLIENTS + 1;
  InitItems();
}

/** Load a map's entity string the way the server does. */
function loadMap(mapname: string, entities: string, spawnpoint: string, rules: Ruleset = SINGLE_PLAYER): void {
  setupWorld(rules);
  SpawnEntities(mapname, entities, spawnpoint);
}

/** `SpawnEntities` clears every edict but never `game.clients[]` -- the same
 *  property the landmark carry-over relies on in a real session. Re-parsing a
 *  second map through it therefore models the map change exactly. */
function loadNextMap(mapname: string, entities: string, spawnpoint: string): void {
  SpawnEntities(mapname, entities, spawnpoint);
}

function player(n = 1): EdictT {
  const ent = g_edicts[n]!;
  ent.client = game.clients[n - 1]!;
  ent.inuse = true;
  ent.health = 100; // use_target_changelevel's own `g_edicts[1].health <= 0` guard
  ent.client.pers.connected = true;
  return ent;
}

function ent(classname: string, fields: Record<string, string> = {}): string {
  const body = Object.entries({ classname, ...fields })
    .map(([k, v]) => `"${k}" "${v}"`)
    .join("\n");
  return `{\n${body}\n}\n`;
}

const WORLD = ent("worldspawn");

/** SelectSpawnPoint's two outputs plus whether the landmark arm fired. */
function selectSpawn(ent_: EdictT): { origin: Vec3; angles: Vec3; landmark: boolean } {
  const origin = vec3();
  const angles = vec3();
  const landmark: [boolean] = [false];
  SelectSpawnPoint(ent_, origin, angles, landmark);
  return { origin, angles, landmark: landmark[0] };
}

function xyz(v: Vec3): string {
  return `${round(v[0])} ${round(v[1])} ${round(v[2])}`;
}
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// 1. The recorded half -- use_target_changelevel
// ---------------------------------------------------------------------------

describe("use_target_changelevel records landmark-relative state", () => {
  const SRC =
    WORLD +
    ent("info_player_start", { origin: "0 0 0" }) +
    ent("info_landmark", { origin: "100 200 300", targetname: "lm" }) +
    ent("target_changelevel", { map: "dest$sp", target: "lm", targetname: "exit" });

  function fireExit(rules: Ruleset = SINGLE_PLAYER): EdictT {
    loadMap("src", SRC, "", rules);
    const p = player();
    p.s.origin.set([110, 205, 330]);
    p.client!.ps.viewangles.set([10, 20, 30]);
    p.client!.oldvelocity.set([0, 400, -200]);

    const exit = G_Find(null, "targetname", "exit")!;
    use_target_changelevel(exit, p, p);
    return p;
  }

  test("an unrotated landmark records the plain difference", () => {
    const p = fireExit();
    expect(p.client!.landmark_name).toBe("lm");
    expect(xyz(p.client!.landmark_rel_pos)).toBe("10 5 30");
    // viewangles - landmark angles, with the landmark unrotated
    expect(xyz(p.client!.oldviewangles)).toBe("10 20 30");
    expect(xyz(p.client!.oldvelocity)).toBe("0 400 -200");
  });

  test("a yawed landmark un-rotates the offset, the velocity and the view", () => {
    const yawed =
      WORLD +
      ent("info_player_start", { origin: "0 0 0" }) +
      ent("info_landmark", { origin: "100 200 300", targetname: "lm", angle: "90" }) +
      ent("target_changelevel", { map: "dest$sp", target: "lm", targetname: "exit" });

    loadMap("src", yawed, "");
    const p = player();
    p.s.origin.set([110, 200, 300]); // +10 along +x from the landmark
    p.client!.ps.viewangles.set([0, 45, 0]);
    p.client!.oldvelocity.set([100, 0, 0]);

    use_target_changelevel(G_Find(null, "targetname", "exit")!, p, p);

    // un-rotating a +x offset by a yaw of 90 puts it on -y
    expect(xyz(p.client!.landmark_rel_pos)).toBe("0 -10 0");
    expect(xyz(p.client!.oldvelocity)).toBe("0 -100 0");
    expect(xyz(p.client!.oldviewangles)).toBe("0 -45 0");
  });

  test("no `target` on the changelevel records nothing -- the 1997 shape", () => {
    const vanilla =
      WORLD + ent("info_player_start", { origin: "0 0 0" }) + ent("target_changelevel", { map: "dest", targetname: "exit" });

    loadMap("src", vanilla, "");
    const p = player();
    p.s.origin.set([110, 205, 330]);
    p.client!.ps.viewangles.set([10, 20, 30]);
    const beforeVel = vec3(1, 2, 3);
    p.client!.oldvelocity.set(beforeVel);
    p.client!.oldviewangles.set([7, 8, 9]);

    use_target_changelevel(G_Find(null, "targetname", "exit")!, p, p);

    expect(p.client!.landmark_name).toBeNull();
    expect(xyz(p.client!.landmark_rel_pos)).toBe("0 0 0");
    // untouched: the rerelease's block never runs
    expect(xyz(p.client!.oldvelocity)).toBe("1 2 3");
    expect(xyz(p.client!.oldviewangles)).toBe("7 8 9");
  });

  test("a `target` that names nothing records nothing", () => {
    const dangling =
      WORLD + ent("info_player_start", { origin: "0 0 0" }) + ent("target_changelevel", { map: "dest", target: "nope", targetname: "exit" });

    loadMap("src", dangling, "");
    const p = player();
    use_target_changelevel(G_Find(null, "targetname", "exit")!, p, p);
    expect(p.client!.landmark_name).toBeNull();
  });

  test("deathmatch never records, whatever the map carries", () => {
    const p = fireExit({ skill: 1, deathmatch: 1, coop: 0 });
    expect(p.client!.landmark_name).toBeNull();
  });

  test("coop records for the activator only; the other clients stay vanilla", () => {
    loadMap("src", SRC, "", COOP);
    const p1 = player(1);
    const p2 = player(2);
    p1.s.origin.set([110, 205, 330]);
    p1.client!.ps.viewangles.set([0, 0, 0]);

    use_target_changelevel(G_Find(null, "targetname", "exit")!, p1, p1);

    expect(p1.client!.landmark_name).toBe("lm");
    expect(p2.client!.landmark_name).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. THE GATE -- with no landmark data the spawn is byte-for-byte vanilla
// ---------------------------------------------------------------------------

describe("the gate: no landmark data leaves vanilla's spawn untouched", () => {
  const DEST = WORLD + ent("info_player_start", { origin: "16 32 64", angle: "90" }) + ent("info_landmark", { origin: "0 0 0", targetname: "lm" });

  test("landmark_name null -> vanilla spot + 9, spot angles, landmark arm not taken", () => {
    loadMap("dest", DEST, "");
    const sel = selectSpawn(player());
    expect(xyz(sel.origin)).toBe("16 32 73");
    expect(xyz(sel.angles)).toBe("0 90 0");
    expect(sel.landmark).toBe(false);
  });

  test("landmark_name set but this map has no such landmark -> vanilla", () => {
    loadMap("dest", DEST, "");
    const p = player();
    p.client!.landmark_name = "lm_not_here";
    p.client!.landmark_rel_pos.set([500, 500, 500]);

    const sel = selectSpawn(p);
    expect(xyz(sel.origin)).toBe("16 32 73");
    expect(xyz(sel.angles)).toBe("0 90 0");
    expect(sel.landmark).toBe(false);
  });

  test("an empty landmark_name is treated as no landmark", () => {
    loadMap("dest", DEST, "");
    const p = player();
    p.client!.landmark_name = "";
    const sel = selectSpawn(p);
    expect(xyz(sel.origin)).toBe("16 32 73");
    expect(sel.landmark).toBe(false);
  });

  test("a map with no info_landmark at all is unreachable from the landmark arm", () => {
    const noLandmark = WORLD + ent("info_player_start", { origin: "1 2 3" });
    loadMap("dest", noLandmark, "");
    const p = player();
    p.client!.landmark_name = "lm";
    const sel = selectSpawn(p);
    expect(xyz(sel.origin)).toBe("1 2 12");
    expect(sel.landmark).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. The placing half -- TryLandmarkSpawn
// ---------------------------------------------------------------------------

describe("TryLandmarkSpawn places the player relative to the destination landmark", () => {
  test("an unrotated landmark: origin = landmark + rel_pos, angles = oldviewangles", () => {
    const dest = WORLD + ent("info_player_start", { origin: "0 0 0" }) + ent("info_landmark", { origin: "500 600 700", targetname: "lm" });
    loadMap("dest", dest, "");

    const p = player();
    p.client!.landmark_name = "lm";
    p.client!.landmark_rel_pos.set([10, 5, 30]);
    p.client!.oldviewangles.set([10, 20, 30]);

    const sel = selectSpawn(p);
    expect(sel.landmark).toBe(true);
    expect(xyz(sel.origin)).toBe("510 605 730");
    expect(xyz(sel.angles)).toBe("10 20 30");
    // ent.s.origin is written too, exactly as the rerelease does
    expect(xyz(p.s.origin)).toBe("510 605 730");
  });

  test("a yawed destination landmark rotates the offset and adds its own angles", () => {
    const dest =
      WORLD + ent("info_player_start", { origin: "0 0 0" }) + ent("info_landmark", { origin: "500 600 700", targetname: "lm", angle: "90" });
    loadMap("dest", dest, "");

    const p = player();
    p.client!.landmark_name = "lm";
    p.client!.landmark_rel_pos.set([0, -10, 0]); // what the yawed source recorded
    p.client!.oldviewangles.set([0, -45, 0]);

    const sel = selectSpawn(p);
    expect(sel.landmark).toBe(true);
    expect(xyz(sel.origin)).toBe("510 600 700");
    expect(xyz(sel.angles)).toBe("0 45 0");
  });

  test("a full out-and-back round trip through two yawed landmarks is the identity", () => {
    const src =
      WORLD +
      ent("info_player_start", { origin: "0 0 0" }) +
      ent("info_landmark", { origin: "100 200 300", targetname: "lm", angle: "35" }) +
      ent("target_changelevel", { map: "dest$sp", target: "lm", targetname: "exit" });
    // the destination landmark carries the SAME angle, so the two rotations
    // cancel and the player must land at the same offset they left with
    const dest =
      WORLD + ent("info_player_start", { origin: "0 0 0", targetname: "sp" }) + ent("info_landmark", { origin: "-900 40 12", targetname: "lm", angle: "35" });

    loadMap("src", src, "");
    const p = player();
    p.s.origin.set([137, 211, 288]);
    p.client!.ps.viewangles.set([0, 77, 0]);
    use_target_changelevel(G_Find(null, "targetname", "exit")!, p, p);

    loadNextMap("dest", dest, "sp");
    const p2 = player();
    const sel = selectSpawn(p2);

    expect(sel.landmark).toBe(true);
    // (137,211,288) - (100,200,300) = (37,11,-12), re-added to (-900,40,12)
    expect(xyz(sel.origin)).toBe("-863 51 0");
    expect(xyz(sel.angles)).toBe("0 77 0");
  });

  test("SPAWNFLAG_LANDMARK_KEEP_Z takes z from the spawn point, not the landmark", () => {
    const dest =
      WORLD +
      ent("info_player_start", { origin: "10 20 -224" }) +
      ent("info_landmark", { origin: "500 600 700", targetname: "lm", spawnflags: String(SPAWNFLAG_LANDMARK_KEEP_Z) });
    loadMap("dest", dest, "");

    const p = player();
    p.client!.landmark_name = "lm";
    p.client!.landmark_rel_pos.set([10, 5, 30]);

    const sel = selectSpawn(p);
    expect(sel.landmark).toBe(true);
    // x/y still landmark-relative; z is the spawn point's RAW z, not the
    // vanilla `+= 9` one -- that is what the rerelease reads
    expect(xyz(sel.origin)).toBe("510 605 -224");
  });

  test("the carried velocity is rotated into the destination landmark's frame", () => {
    const dest =
      WORLD + ent("info_player_start", { origin: "0 0 0" }) + ent("info_landmark", { origin: "0 0 0", targetname: "lm", angle: "90" });
    loadMap("dest", dest, "");

    const p = player();
    p.client!.landmark_name = "lm";
    p.client!.landmark_rel_pos.set([0, 0, 0]);
    p.velocity.set([100, 0, -300]);

    selectSpawn(p);
    expect(xyz(p.velocity)).toBe("0 100 -300");
  });

  test("a zero velocity is left alone (the rerelease's own guard)", () => {
    const dest =
      WORLD + ent("info_player_start", { origin: "0 0 0" }) + ent("info_landmark", { origin: "0 0 0", targetname: "lm", angle: "90" });
    loadMap("dest", dest, "");
    const p = player();
    p.client!.landmark_name = "lm";
    selectSpawn(p);
    expect(xyz(p.velocity)).toBe("0 0 0");
  });
});

// ---------------------------------------------------------------------------
// 4. The stuck fix
// ---------------------------------------------------------------------------

describe("G_FixStuckObject_Generic", () => {
  const MINS = vec3(-16, -16, -24);
  const MAXS = vec3(16, 16, 32);

  // An honest axis-aligned world: everything below FLOOR_Z is solid. A trace
  // is `startsolid` only when the box is ALREADY in the solid at `start`, and
  // otherwise stops where the box's bottom first reaches the floor -- which
  // is the distinction G_FixStuckObject_Generic's "push back to the opposite
  // side and measure the clearance" step depends on.
  const FLOOR_Z = 0;
  function floorTrace(start: Vec3, mins: Vec3 | null, maxs: Vec3 | null, end: Vec3): GTraceT {
    const lo = mins === null ? 0 : mins[2];
    const t = openTrace(end);
    if (start[2] + lo < FLOOR_Z) {
      t.startsolid = true;
      t.allsolid = end[2] + lo < FLOOR_Z;
      t.fraction = 0;
      t.endpos.set(start);
      return t;
    }
    if (end[2] + lo >= FLOOR_Z) return t; // never reaches the floor
    const dz = end[2] - start[2];
    const f = dz === 0 ? 0 : (FLOOR_Z - lo - start[2]) / dz;
    const frac = Math.max(0, Math.min(1, f));
    t.fraction = frac;
    t.endpos.set([start[0] + (end[0] - start[0]) * frac, start[1] + (end[1] - start[1]) * frac, start[2] + dz * frac]);
    return t;
  }

  test("clear space is reported GOOD_POSITION and the origin is untouched", () => {
    const origin = vec3(1, 2, 3);
    const r = G_FixStuckObject_Generic(origin, MINS, MAXS, (_s, _mi, _ma, end) => openTrace(end));
    expect(r).toBe(StuckResultT.GOOD_POSITION);
    expect(xyz(origin)).toBe("1 2 3");
  });

  test("solid everywhere is NO_GOOD_POSITION and the origin is untouched", () => {
    const origin = vec3(1, 2, 3);
    const r = G_FixStuckObject_Generic(origin, MINS, MAXS, () => solidTrace());
    expect(r).toBe(StuckResultT.NO_GOOD_POSITION);
    expect(xyz(origin)).toBe("1 2 3");
  });

  test("a floor 8 units into the box pushes the box up off it", () => {
    const origin = vec3(0, 0, FLOOR_Z - 8 - MINS[2]); // feet 8 units into the floor
    const r = G_FixStuckObject_Generic(origin, MINS, MAXS, floorTrace);
    expect(r).toBe(StuckResultT.FIXED);
    expect(origin[2] + MINS[2]).toBeGreaterThanOrEqual(FLOOR_Z);
  });

  test("TryLandmarkSpawn gives up on NO_GOOD_POSITION and leaves vanilla's spawn", () => {
    const dest = WORLD + ent("info_player_start", { origin: "16 32 64", angle: "90" }) + ent("info_landmark", { origin: "500 600 700", targetname: "lm" });
    loadMap("dest", dest, "");

    const p = player();
    p.client!.landmark_name = "lm";
    p.client!.landmark_rel_pos.set([1, 2, 3]);
    p.s.origin.set([-1, -1, -1]);
    traceFn = () => solidTrace();

    const sel = selectSpawn(p);
    expect(sel.landmark).toBe(false);
    expect(xyz(sel.origin)).toBe("16 32 73");
    expect(xyz(sel.angles)).toBe("0 90 0");
    // ent.s.origin must NOT have been moved to the rejected spot
    expect(xyz(p.s.origin)).toBe("-1 -1 -1");
  });

  test("TryLandmarkSpawn accepts a FIXED position and reports the nudged origin", () => {
    const dest = WORLD + ent("info_player_start", { origin: "0 0 0" }) + ent("info_landmark", { origin: "0 0 0", targetname: "lm" });
    loadMap("dest", dest, "");

    traceFn = floorTrace;

    const p = player();
    p.client!.landmark_name = "lm";
    p.client!.landmark_rel_pos.set([0, 0, 16]); // feet at -8, inside the floor

    const sel = selectSpawn(p);
    expect(sel.landmark).toBe(true);
    expect(sel.origin[2] - 24).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 4b. A save written mid-transition carries the landmark state
// ---------------------------------------------------------------------------

describe("the game file carries the landmark state across a save/load", () => {
  test("a save taken during the exit intermission restores every carried field", () => {
    const src =
      WORLD +
      ent("info_player_start", { origin: "0 0 0" }) +
      ent("info_landmark", { origin: "100 200 300", targetname: "lm", angle: "35" }) +
      ent("target_changelevel", { map: "dest$sp", target: "lm", targetname: "exit" });

    loadMap("src", src, "");
    const p = player();
    p.s.origin.set([137, 211, 288]);
    p.client!.ps.viewangles.set([0, 77, 0]);
    p.client!.oldvelocity.set([12, -34, 56]);
    use_target_changelevel(G_Find(null, "targetname", "exit")!, p, p);

    const before = {
      name: p.client!.landmark_name,
      rel: xyz(p.client!.landmark_rel_pos),
      vel: xyz(p.client!.oldvelocity),
      view: xyz(p.client!.oldviewangles),
    };
    expect(before.name).toBe("lm");

    // this is the save the server writes at the exit, and the load that
    // reads it back
    const json = JSON.parse(JSON.stringify(serializeGame(true))) as GameJSON;
    deserializeGame(json);

    const restored = game.clients[0]!;
    expect(restored.landmark_name).toBe(before.name);
    expect(xyz(restored.landmark_rel_pos)).toBe(before.rel);
    expect(xyz(restored.oldvelocity)).toBe(before.vel);
    expect(xyz(restored.oldviewangles)).toBe(before.view);
  });

  test("a game file written before clientLandmarks existed still loads", () => {
    loadMap("src", WORLD + ent("info_player_start", { origin: "0 0 0" }), "");
    const json = JSON.parse(JSON.stringify(serializeGame(false))) as GameJSON;
    delete json.clientLandmarks;
    deserializeGame(json);
    expect(game.clients[0]!.landmark_name).toBeNull();
    expect(xyz(game.clients[0]!.landmark_rel_pos)).toBe("0 0 0");
  });
});

// ---------------------------------------------------------------------------
// 5. Retail-gated: every shipped landmark transition
// ---------------------------------------------------------------------------

interface PackEntry {
  name: string;
  filepos: number;
  filelen: number;
}

function readPack(pakPath: string): { data: Buffer; entries: PackEntry[] } {
  const data = readFileSync(pakPath);
  if (data.toString("ascii", 0, 4) !== "PACK") throw new Error("not a PACK file");
  const dirofs = data.readInt32LE(4);
  const count = Math.floor(data.readInt32LE(8) / 64);

  const entries: PackEntry[] = [];
  for (let i = 0; i < count; i++) {
    const off = dirofs + i * 64;
    entries.push({
      name: data.toString("ascii", off, off + 56).replace(/\0.*$/, ""),
      filepos: data.readInt32LE(off + 56),
      filelen: data.readInt32LE(off + 60),
    });
  }
  return { data, entries };
}

function entityLump(bsp: Buffer): string | null {
  if (bsp.length < 16) return null;
  const magic = bsp.toString("ascii", 0, 4);
  if (magic !== "IBSP" && magic !== "QBSP") return null;
  const ofs = bsp.readInt32LE(8);
  const len = bsp.readInt32LE(12);
  if (ofs < 0 || len < 0 || ofs + len > bsp.length) return null;
  return bsp.toString("latin1", ofs, ofs + len);
}

interface RawEntity {
  classname: string;
  targetname: string | null;
  target: string | null;
  map: string | null;
  spawnflags: number;
  origin: Vec3;
  angles: Vec3;
}

/** Deliberately dumb reader, independent of this port's COM_Parse. */
function parseEntities(entityString: string): RawEntity[] {
  const out: RawEntity[] = [];
  for (const block of entityString.matchAll(/\{([^{}]*)\}/g)) {
    const kv = new Map<string, string>();
    for (const pair of block[1]!.matchAll(/"([^"]*)"\s*"([^"]*)"/g)) kv.set(pair[1]!, pair[2]!);

    const nums = (s: string | undefined): Vec3 => {
      const p = (s ?? "").trim().split(/\s+/).map(Number);
      return vec3(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0);
    };
    out.push({
      classname: kv.get("classname") ?? "",
      targetname: kv.get("targetname") ?? null,
      target: kv.get("target") ?? null,
      map: kv.get("map") ?? null,
      spawnflags: Number.parseInt(kv.get("spawnflags") ?? "0", 10) || 0,
      origin: nums(kv.get("origin")),
      angles: kv.has("angles") ? nums(kv.get("angles")) : vec3(0, Number(kv.get("angle") ?? 0), 0),
    });
  }
  return out;
}

interface ShippedMap {
  name: string;
  entityString: string;
  entities: RawEntity[];
}

let shippedCache: Map<string, ShippedMap> | null = null;

function shippedMaps(): Map<string, ShippedMap> {
  if (shippedCache !== null) return shippedCache;
  const pak = readPack(RETAIL_PAK);
  const maps = new Map<string, ShippedMap>();
  for (const entry of pak.entries) {
    if (!entry.name.toLowerCase().endsWith(".bsp")) continue;
    const text = entityLump(pak.data.subarray(entry.filepos, entry.filepos + entry.filelen));
    if (text === null) continue;
    const name = entry.name.slice("maps/".length, -".bsp".length).toLowerCase();
    maps.set(name, { name, entityString: text, entities: parseEntities(text) });
  }
  shippedCache = maps;
  return maps;
}

// --- the transcribed rerelease rule, independent of src/game/ ---------------

function rot(v: Vec3, angles: Vec3, sign: 1 | -1): Vec3 {
  const a = vec3(v[0], v[1], v[2]);
  const b = vec3();
  RotatePointAroundVector(b, vec3(1, 0, 0), a, sign * angles[0]);
  const c = vec3();
  RotatePointAroundVector(c, vec3(0, 1, 0), b, sign * angles[2]);
  const d = vec3();
  RotatePointAroundVector(d, vec3(0, 0, 1), c, sign * angles[1]);
  return d;
}

/** g_target.cpp's half, then p_client.cpp's, with no port code involved. */
function referenceArrival(
  playerOrigin: Vec3,
  playerViewangles: Vec3,
  srcLandmark: RawEntity,
  dstLandmark: RawEntity,
  spotOrigin: Vec3,
): { origin: Vec3; angles: Vec3 } {
  const diff = vec3(
    playerOrigin[0] - srcLandmark.origin[0],
    playerOrigin[1] - srcLandmark.origin[1],
    playerOrigin[2] - srcLandmark.origin[2],
  );
  const rel = rot(diff, srcLandmark.angles, -1);
  const oldview = vec3(
    playerViewangles[0] - srcLandmark.angles[0],
    playerViewangles[1] - srcLandmark.angles[1],
    playerViewangles[2] - srcLandmark.angles[2],
  );

  const placed = rot(rel, dstLandmark.angles, 1);
  const origin = vec3(placed[0] + dstLandmark.origin[0], placed[1] + dstLandmark.origin[1], placed[2] + dstLandmark.origin[2]);
  if ((dstLandmark.spawnflags & SPAWNFLAG_LANDMARK_KEEP_Z) !== 0) origin[2] = spotOrigin[2];

  const angles = vec3(oldview[0] + dstLandmark.angles[0], oldview[1] + dstLandmark.angles[1], oldview[2] + dstLandmark.angles[2]);
  return { origin, angles };
}

interface Transition {
  src: string;
  dst: string;
  spawnpoint: string;
  landmarkName: string;
  srcLandmark: RawEntity;
  dstLandmark: RawEntity | null;
}

function landmarkTransitions(): Transition[] {
  const maps = shippedMaps();
  const out: Transition[] = [];
  for (const map of maps.values()) {
    for (const e of map.entities) {
      if (e.classname.toLowerCase() !== "target_changelevel") continue;
      if (e.target === null || e.map === null) continue;

      const srcLandmark = map.entities.find((c) => c.classname.toLowerCase() === "info_landmark" && (c.targetname ?? "").toLowerCase() === e.target!.toLowerCase());
      if (srcLandmark === undefined) continue; // `target` names something else

      // "<dest>[$<spawnpoint>]", "*"-prefixed for a new unit, optionally
      // preceded by a "<cinematic>+" prefix the server strips.
      const raw = e.map.replace(/^[^+]*\+/, "").replace(/^\*/, "");
      const [destRaw, spawnpoint] = raw.split("$");
      const dest = (destRaw ?? "").toLowerCase();
      const destMap = maps.get(dest);
      if (destMap === undefined) continue;

      const dstLandmark =
        destMap.entities.find((c) => c.classname.toLowerCase() === "info_landmark" && (c.targetname ?? "").toLowerCase() === e.target!.toLowerCase()) ?? null;

      out.push({ src: map.name, dst: dest, spawnpoint: spawnpoint ?? "", landmarkName: e.target, srcLandmark, dstLandmark });
    }
  }
  return out.sort((a, b) => `${a.src}>${a.dst}>${a.landmarkName}`.localeCompare(`${b.src}>${b.dst}>${b.landmarkName}`));
}

/** The target_changelevel in the currently loaded map that points at `name`. */
function findExitFor(name: string): EdictT | null {
  let e: EdictT | null = null;
  while ((e = G_Find(e, "classname", "target_changelevel")) !== null) {
    if (e.target !== null && e.target.toLowerCase() === name.toLowerCase()) return e;
  }
  return null;
}

/** A full fixture reset plus a map load -- used where the previous map's
 *  client state must NOT carry over. */
function loadNextMapFresh(mapname: string, entities: string, spawnpoint: string): void {
  loadMap(mapname, entities, spawnpoint);
}

describe.skipIf(!haveRetail)("shipped landmark transitions", () => {
  test("every shipped landmark transition has its destination landmark, bar two", () => {
    const missing = landmarkTransitions()
      .filter((t) => t.dstLandmark === null)
      .map((t) => `${t.src} -> ${t.dst} (${t.landmarkName})`);

    // These two are gaps in the shipped CONTENT, not in this module: rmine2
    // carries no info_landmark at all, and xmoon1 carries two but not the one
    // xship's changelevel names. The rerelease reaches TryLandmarkSpawn's
    // `G_PickTarget(...) == nullptr` arm on both and falls back to the spawn
    // point; so does this module (see the fallback test below).
    expect(missing).toEqual(["rlava2 -> rmine2 (lm_rlava2_rmine2)", "xship -> xmoon1 (lm_xship_xmoon1)"]);
  });

  test("the two landmark-less destinations fall back to the vanilla spawn point", () => {
    for (const t of landmarkTransitions().filter((x) => x.dstLandmark === null)) {
      const destMap = shippedMaps().get(t.dst)!;

      loadNextMapFresh(t.src, shippedMaps().get(t.src)!.entityString, "");
      const p = player();
      p.s.origin.set([t.srcLandmark.origin[0] + 24, t.srcLandmark.origin[1] - 40, t.srcLandmark.origin[2] + 17]);
      const exit = findExitFor(t.landmarkName);
      expect(exit).not.toBeNull();
      use_target_changelevel(exit!, p, p);
      expect(p.client!.landmark_name).not.toBeNull();

      loadNextMap(t.dst, destMap.entityString, t.spawnpoint);
      const withLandmark = selectSpawn(player());
      expect(withLandmark.landmark).toBe(false);

      loadNextMap(t.dst, destMap.entityString, t.spawnpoint);
      const bareEnt = player();
      bareEnt.client!.landmark_name = null;
      const bare = selectSpawn(bareEnt);

      expect(xyz(withLandmark.origin)).toBe(xyz(bare.origin));
      expect(xyz(withLandmark.angles)).toBe(xyz(bare.angles));
    }
  });

  test("there really are the expected shipped landmark transitions to check", () => {
    expect(landmarkTransitions().length).toBeGreaterThan(100);
  });

  test("the classic module computes the rerelease's arrival on every one of them", () => {
    const transitions = landmarkTransitions();
    const mismatches: string[] = [];

    for (const t of transitions) {
      const dstLandmark = t.dstLandmark;
      if (dstLandmark === null) continue;
      const destMap = shippedMaps().get(t.dst)!;

      // a player standing somewhere non-trivial relative to the source
      // landmark, looking somewhere non-trivial
      const playerOrigin = vec3(t.srcLandmark.origin[0] + 24, t.srcLandmark.origin[1] - 40, t.srcLandmark.origin[2] + 17);
      const playerView = vec3(6, 123, 0);

      // --- what the real classic module does ---
      loadMap(t.src, shippedMaps().get(t.src)!.entityString, "");
      const p = player();
      p.s.origin.set(playerOrigin);
      p.client!.ps.viewangles.set(playerView);

      const exit = findExitFor(t.landmarkName);
      if (exit === null) {
        mismatches.push(`${t.src}->${t.dst}: exit entity not found after SpawnEntities`);
        continue;
      }
      use_target_changelevel(exit, p, p);

      loadNextMap(t.dst, destMap.entityString, t.spawnpoint);
      const p2 = player();
      const sel = selectSpawn(p2);

      if (!sel.landmark) {
        mismatches.push(`${t.src}->${t.dst}: landmark arm did not fire`);
        continue;
      }

      // --- the transcribed reference ---
      // SelectSpawnPoint's spot z is what KEEP_Z reads; recover it from the
      // module's own selection by re-running with landmark_name cleared, so
      // the landmark arm cannot fire and `origin` is the plain spot + 9.
      loadNextMap(t.dst, destMap.entityString, t.spawnpoint);
      const bareEnt = player();
      bareEnt.client!.landmark_name = null;
      const bare = selectSpawn(bareEnt);
      const spotOrigin = vec3(bare.origin[0], bare.origin[1], bare.origin[2] - 9);

      const ref = referenceArrival(playerOrigin, playerView, t.srcLandmark, dstLandmark, spotOrigin);

      const dist = Math.hypot(sel.origin[0] - ref.origin[0], sel.origin[1] - ref.origin[1], sel.origin[2] - ref.origin[2]);
      const adist = Math.hypot(sel.angles[0] - ref.angles[0], sel.angles[1] - ref.angles[1], sel.angles[2] - ref.angles[2]);
      if (dist > 0.01 || adist > 0.01) {
        mismatches.push(`${t.src}->${t.dst} (${t.landmarkName}): got ${xyz(sel.origin)} @ ${xyz(sel.angles)}, want ${xyz(ref.origin)} @ ${xyz(ref.angles)}`);
      }
    }

    expect(mismatches).toEqual([]);
    // 127 shipped transitions x (two SpawnEntities passes over a full retail
    // entity lump) is genuinely slow; the default 5s is not enough.
  }, 120000);
});
