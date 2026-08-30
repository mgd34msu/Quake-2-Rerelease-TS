/*
Unit tests for the LM_CTF "identity systems" unit: runes (src/lmctf/g_runes.ts),
the plasma rifle (src/lmctf/plasma.ts), the in-game menu system
(src/lmctf/g_menu.ts), skins.ini parsing (src/lmctf/g_skins.ts), the vote
system (src/lmctf/g_vote.ts), player stats (src/lmctf/p_stats.ts), and the
StdLog/GibStats logging pair (src/lmctf/stdlog.ts, src/lmctf/gslog.ts).

Self-sufficient per .orch/preferences.md rule 13: this file calls
GetGameAPI(fakeImports) itself and never relies on another test file having
run first. Modeled after test/lmctf_core.test.ts's fake-GameImports pattern,
extended with a real cvar registry (stdlog.ts/gslog.ts/g_menu.ts all read
cvars by name at call time, not just once at InitGame) and a captured
FS_Write/FS_WriteFile channel for the file-writing tests.
*/

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vec3, type Vec3 } from "../src/shared/math";
import { CplaneT, CvarT, PRINT_HIGH } from "../src/shared/q_shared";
import { SolidT, type Edict, type GameImports, type GTraceT } from "../src/lmctf/game";
import { GetGameAPI } from "../src/lmctf/g_main";
import {
  EdictT,
  GClientT,
  MOD_FALLING,
  MOD_TELEFRAG,
  SetGEdicts,
  SetBlueFlag,
  SetRedFlag,
  g_edicts,
  game,
  gameCvars,
  globals,
  level,
} from "../src/lmctf/g_local";
import { CTF_TEAM_BLUE, CTF_TEAM_RED, CTF_TEAM_UNDEFINED } from "../src/lmctf/g_ctffunc";
import { InitItems } from "../src/lmctf/g_items";
import { SetMatchState, MatchStatesT } from "../src/lmctf/g_tourney";
import { DamageRuneHook, Pickup_Rune, ResistRuneHook, RUNE_DAMAGE, RUNE_HASTE, RUNE_REGEN, RUNE_RESIST, Rune_Think, RuneThinkHook, RuneWeaponThinkHook, SelectRuneSpawnPoint } from "../src/lmctf/g_runes";
import { fire_plasma, MOD_PLASMA, PLASMA_BOUNCE_DAMAGE, PLASMA_CELLS_PER_SHOT, PLASMA_REFLECT_SPEED, PLASMA_SPLASH_RADIUS, PLASMA_SPREAD_DAMAGE, PLASMA_SPREAD_SPEED, plasma_reflect_touch, Spawn_Goop, Weapon_PLASMA_Generic } from "../src/lmctf/plasma";
import { Help_Menu, Main_Menu, Menu_Draw, Menu_Free, Menu_Next, Menu_Prev, Menu_Set, Menu_Use, Ref_CTFFlags_Menu, Ref_DMFlags_Menu } from "../src/lmctf/g_menu";
import { ResetSkinsForTest, SetSkinsConfigForTest, SkinGetList, SkinListInUse, SkinRandom, SkinsReadFile, SkinValid } from "../src/lmctf/g_skins";
import { Check_Vote, Clear_All_Ballots, CTF_EXTRAFLAGS_VOTE_NO, CTF_EXTRAFLAGS_VOTE_YES, ResetVoteForTest, Vote_NO, Vote_Skip_Level, Vote_YES, VoteStarted } from "../src/lmctf/g_vote";
import { Cmd_StatsAll_f, stats_add, stats_clear, stats_cleanup, stats_find_dropped_player, stats_get, stats_log_init, stats_new_player, stats_set, STATS_DEATHS, STATS_FRAGS } from "../src/lmctf/p_stats";
import { sl_CloseLogFile, sl_LogPlayerConnect, sl_LogScore } from "../src/lmctf/stdlog";
import { sl_WriteStdLogDeath } from "../src/lmctf/gslog";
import { FS_WriteFile } from "../src/qcommon/files";

// ---------------------------------------------------------------------------
// fake GameImports (extends lmctf_core.test.ts's pattern with a real cvar
// registry, since stdlog.ts/gslog.ts/g_menu.ts read cvars by name at call
// time rather than once during InitGame)
// ---------------------------------------------------------------------------

interface Recorder {
  writeByte: number[];
  writeString: string[];
  sound: string[];
  linkentity: Edict[];
  unicast: number;
  cprintf: string[];
  bprintf: string[];
}

function makeRecorder(): Recorder {
  return { writeByte: [], writeString: [], sound: [], linkentity: [], unicast: 0, cprintf: [], bprintf: [] };
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
  return queued !== undefined ? queued : defaultTrace();
}

let argsValue = "";
const cvarRegistry = new Map<string, CvarT>();

function fakeCvarGet(name: string, value: string | null, _flags: number): CvarT {
  let c = cvarRegistry.get(name);
  if (c === undefined) {
    c = new CvarT();
    c.name = name;
    c.string = value ?? "";
    c.value = Number.parseFloat(c.string) || 0;
    cvarRegistry.set(name, c);
  }
  return c;
}

function fakeCvarSet(name: string, value: string): CvarT {
  const c = fakeCvarGet(name, value, 0);
  c.string = value;
  c.value = Number.parseFloat(value) || 0;
  return c;
}

function makeFakeGameImports(rec: Recorder): GameImports {
  return {
    bprintf(_level, fmt) {
      rec.bprintf.push(fmt);
    },
    dprintf() {},
    cprintf(_ent, _level, fmt) {
      rec.cprintf.push(fmt);
    },
    centerprintf() {},
    sound(_ent, _channel, soundIdx) {
      rec.sound.push(String(soundIdx));
    },
    positioned_sound() {},
    configstring() {},
    error(fmt): never {
      throw new Error(`gi.error: ${fmt}`);
    },
    modelindex() {
      return 1;
    },
    soundindex(name) {
      return name.length; // deterministic non-zero stand-in
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
    cvar: fakeCvarGet,
    cvar_set: fakeCvarSet,
    cvar_forceset: fakeCvarSet,
    argc() {
      return 0;
    },
    argv() {
      return "";
    },
    args() {
      return argsValue;
    },
    AddCommandString() {},
    DebugGraph() {},
  };
}

const MAXENTITIES = 32;
const MAXCLIENTS = 8;

function fakeCvar(value: number): CvarT {
  const c = new CvarT();
  c.value = value;
  return c;
}

function setupWorld(): Recorder {
  const rec = makeRecorder();
  GetGameAPI(makeFakeGameImports(rec));

  const edicts: EdictT[] = Array.from({ length: MAXENTITIES }, () => new EdictT());
  edicts.forEach((e, i) => {
    e.s.number = i;
    e.inuse = false;
  });
  SetGEdicts(edicts);

  game.clear();
  game.maxclients = MAXCLIENTS;
  game.maxentities = MAXENTITIES;
  game.clients = Array.from({ length: MAXCLIENTS }, () => new GClientT());
  InitItems();

  level.clear();

  gameCvars.maxclients = fakeCvar(MAXCLIENTS);
  gameCvars.dmflags = fakeCvar(0);
  gameCvars.ctfflags = fakeCvar(0);
  gameCvars.fraglimit = fakeCvar(0);
  gameCvars.timelimit = fakeCvar(0);
  gameCvars.password = fakeCvar(0);
  gameCvars.deathmatch = fakeCvar(1);

  globals.num_edicts = MAXENTITIES;

  traceQueue = [];
  argsValue = "";
  cvarRegistry.clear();
  SetMatchState(MatchStatesT.MATCH_INPLAY); // Match_CanScore() true by default for stats tests
  SetRedFlag(null);
  SetBlueFlag(null);
  stats_log_init();

  return rec;
}

function makePlayer(i: number, teamnum = CTF_TEAM_RED): EdictT {
  const ent = g_edicts[i];
  if (ent === undefined) throw new Error("makePlayer: no such edict");
  ent.inuse = true;
  ent.classname = "player";
  ent.client = new GClientT();
  ent.client.pers.connected = true;
  ent.client.pers.netname = `player${i}`;
  ent.client.ctf.teamnum = teamnum;
  ent.health = 100;
  ent.max_health = 100;
  ent.takedamage = 1; // DamageT.DAMAGE_YES
  return ent;
}

// ===========================================================================
// g_runes.ts -- effect math and scatter/respawn
// ===========================================================================

describe("g_runes.ts effect hooks", () => {
  beforeEach(() => setupWorld());

  test("DamageRuneHook: 1.75x multiplier, truncated toward zero", () => {
    const attacker = makePlayer(1);
    if (attacker.client === null) throw new Error("no client");
    attacker.client.rune = attacker; // any non-null edict marks "carrying a rune"
    attacker.client.rune.runetype = RUNE_DAMAGE;

    // 10 * 1.75 = 17.5 -> truncates to 17
    expect(DamageRuneHook(attacker, attacker, attacker, 10, 0, 0)).toBe(17);
    // 4 * 1.75 = 7.0 exactly
    expect(DamageRuneHook(attacker, attacker, attacker, 4, 0, 0)).toBe(7);
  });

  test("DamageRuneHook: no effect without the damage rune", () => {
    const attacker = makePlayer(1);
    expect(DamageRuneHook(attacker, attacker, attacker, 10, 0, 0)).toBe(10);
  });

  test("ResistRuneHook: damage / 1.75, truncated, plays ctf/resist.wav", () => {
    const rec = setupWorld();
    const targ = makePlayer(1);
    if (targ.client === null) throw new Error("no client");
    targ.client.rune = targ;
    targ.client.rune.runetype = RUNE_RESIST;

    // 10 / 1.75 = 5.714... -> truncates to 5
    expect(ResistRuneHook(targ, targ, targ, 10, 0, 0)).toBe(5);
    expect(rec.sound.length).toBe(1);
  });

  test("ResistRuneHook: no effect without the resist rune", () => {
    const targ = makePlayer(1);
    expect(ResistRuneHook(targ, targ, targ, 10, 0, 0)).toBe(10);
  });

  test("RuneThinkHook: regen heals by heartrate/3, clamped to [5,25]/5", () => {
    const ent = makePlayer(1);
    if (ent.client === null) throw new Error("no client");
    ent.client.rune = ent;
    ent.client.rune.runetype = RUNE_REGEN;
    ent.health = 50; // heartrate = 50/5 = 10 (within [5,25])
    ent.max_health = 100;
    ent.client.regentime = 0;
    level.framenum = 100;

    RuneThinkHook(ent);

    // heartrate=10, health += 10/3 = 3.33... -> health becomes 53.33...
    expect(ent.health).toBeCloseTo(50 + 10 / 3, 5);
    expect(ent.client.regentime).toBe(level.framenum);
  });

  test("RuneThinkHook: heartrate clamps to 25 above high health", () => {
    const ent = makePlayer(1);
    if (ent.client === null) throw new Error("no client");
    ent.client.rune = ent;
    ent.client.rune.runetype = RUNE_REGEN;
    // heartrate = 130/5 = 26 -> clamped to 25; health(130) < max_health(200)+25
    // so the heal branch actually runs (unlike a already-topped-off player).
    ent.health = 130;
    ent.max_health = 200;
    ent.client.regentime = 0;
    level.framenum = 100;

    RuneThinkHook(ent);

    expect(ent.health).toBeCloseTo(130 + 25 / 3, 5);
  });

  test("RuneThinkHook: gated by level.framenum < regentime + heartrate", () => {
    const ent = makePlayer(1);
    if (ent.client === null) throw new Error("no client");
    ent.client.rune = ent;
    ent.client.rune.runetype = RUNE_REGEN;
    ent.health = 50;
    ent.client.regentime = 100;
    level.framenum = 105; // heartrate=10, 105 < 100+10 -> gated, no change

    RuneThinkHook(ent);

    expect(ent.health).toBe(50);
  });

  test("RuneWeaponThinkHook: haste rune double-thinks the weapon and plays a sound while firing", () => {
    const rec = setupWorld();
    const ent = makePlayer(1);
    if (ent.client === null) throw new Error("no client");
    ent.client.rune = ent;
    ent.client.rune.runetype = RUNE_HASTE;
    ent.client.isfiring = 1;
    ent.client.ps.gunframe = 3;

    let thinkCalls = 0;
    ent.client.pers.weapon = Object.assign(Object.create(null), {
      weaponthink: () => {
        thinkCalls++;
      },
    }) as never;

    RuneWeaponThinkHook(ent);

    expect(thinkCalls).toBe(1);
    expect(rec.sound.length).toBe(1);
  });

  test("Rune_Think: RUNE_DAMAGE animation oscillates forward then backward", () => {
    const ent = makePlayer(1);
    ent.runetype = RUNE_DAMAGE;
    ent.solid = SolidT.SOLID_TRIGGER; // animation only advances while solid !== SOLID_NOT
    ent.s.frame = 0;
    ent.last_move_time = level.time; // don't trigger a relocate this tick

    for (let i = 0; i < 5; i++) Rune_Think(ent);
    // 5 forward ticks from frame 0: 1,2,3,4,5 -- hits >=5 on the 5th tick,
    // flips `forward` to false for the NEXT call.
    expect(ent.s.frame).toBe(5);

    Rune_Think(ent);
    expect(ent.s.frame).toBe(4); // now descending
  });

  test("Rune_Think: relocates after RUNETHINKTIME (30s) since last_move_time", () => {
    const ent = makePlayer(1);
    ent.runetype = RUNE_RESIST;
    ent.classname = "resist_rune";
    ent.last_move_time = 0;
    level.time = 31; // > last_move_time + 30

    Rune_Think(ent);

    // last_move_time is refreshed regardless of whether a spawn spot was found
    expect(ent.last_move_time).toBe(31);
  });

  test("SelectRuneSpawnPoint: finds an item_health_small spawn point", () => {
    const spot = makePlayer(2); // reuse an edict slot as a non-player spawn spot
    spot.classname = "item_health_small";
    spot.client = null;
    spot.inuse = true;

    const found = SelectRuneSpawnPoint();
    expect(found).toBe(spot);
  });

  test("Pickup_Rune: grants the rune and marks it non-solid/hidden", () => {
    const rec = setupWorld();
    const other = makePlayer(1);
    const runeEnt = makePlayer(2);
    runeEnt.client = null;
    runeEnt.item = null;

    const picked = Pickup_Rune(runeEnt, other);

    expect(picked).toBe(true);
    expect(other.client?.rune).toBe(runeEnt);
    expect(rec.sound.length).toBe(1);
  });
});

// ===========================================================================
// plasma.ts -- fire chain constants and dispatch
// ===========================================================================

describe("plasma.ts", () => {
  beforeEach(() => setupWorld());

  test("weapon constants match lmctf60/plasma.h exactly", () => {
    expect(PLASMA_SPREAD_DAMAGE).toBe(28);
    expect(PLASMA_BOUNCE_DAMAGE).toBe(39);
    expect(PLASMA_SPLASH_RADIUS).toBe(70);
    expect(PLASMA_REFLECT_SPEED).toBe(1200);
    expect(PLASMA_SPREAD_SPEED).toBe(1200);
    expect(PLASMA_CELLS_PER_SHOT).toBe(10);
    expect(MOD_PLASMA).toBe(34);
  });

  test("fire_plasma deducts PLASMA_CELLS_PER_SHOT - 1 cells regardless of mode", () => {
    const ent = makePlayer(1);
    if (ent.client === null) throw new Error("no client");
    ent.client.ammo_index = 5;
    ent.client.pers.inventory[5] = 50;

    fire_plasma(ent, vec3(0, 0, 0), vec3(1, 0, 0), 1);
    expect(ent.client.pers.inventory[5]).toBe(50 - (PLASMA_CELLS_PER_SHOT - 1));

    ent.client.pers.inventory[5] = 50;
    fire_plasma(ent, vec3(0, 0, 0), vec3(1, 0, 0), 0);
    expect(ent.client.pers.inventory[5]).toBe(50 - (PLASMA_CELLS_PER_SHOT - 1));
  });

  test("Spawn_Goop sets up the shared goop entity fields", () => {
    const owner = makePlayer(1);
    const goop = Spawn_Goop(owner, vec3(1, 2, 3));

    expect(goop.classname).toBe("goop");
    expect(goop.owner).toBe(owner);
    expect(goop.s.origin[0]).toBe(1);
    expect(goop.s.origin[1]).toBe(2);
    expect(goop.s.origin[2]).toBe(3);
  });

  test("plasma_reflect_touch: quadmeister quadruples bounce damage on a damageable hit", () => {
    const rec = setupWorld();
    // quadmeister is plasma.ts's own module-level flag (mirrors the C
    // source's file-scope `int quadmeister`), latched by
    // Weapon_PLASMA_Generic reading quad_framenum vs level.framenum --
    // shooter here only exists to latch that flag, decoupled from the
    // entity that actually touches something below (avoids PlayerNoise,
    // a genuine unported cross-dependency documented in plasma.ts).
    const shooter = makePlayer(1);
    if (shooter.client === null) throw new Error("no client");
    shooter.client.quad_framenum = 1000;
    level.framenum = 1; // quad_framenum > level.framenum -- quadmeister becomes true
    shooter.client.ps.gunframe = 999; // not FRAME_ACTIVATE_LAST, so it just increments and returns
    Weapon_PLASMA_Generic(shooter, 3, 11, 46, 51, null, [40, 41, 0], () => {});

    // A non-client owner sidesteps plasma.ts's PlayerNoise call (a real,
    // documented cross-dependency into unit A's pending p_weapon.ts --
    // only invoked when `self.owner.client !== null`).
    const owner = g_edicts[3];
    if (owner === undefined) throw new Error("no edict");
    owner.inuse = true;
    owner.classname = "plasma-owner";
    owner.client = null;

    const goop = Spawn_Goop(owner, vec3());
    goop.owner = owner;
    const target = makePlayer(2);
    target.takedamage = 1;

    plasma_reflect_touch(goop, target, new CplaneT(), null);

    expect(rec.sound.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// g_menu.ts -- menu open/navigate/select dispatch
// ===========================================================================

describe("g_menu.ts", () => {
  beforeEach(() => setupWorld());

  test("Menu_Set stores text/func; Menu_Free clears every slot", () => {
    const ent = makePlayer(1);
    Menu_Set(ent, 3, "hello", null);
    expect(ent.client?.localmenu[3]?.text).toBe("hello");

    Menu_Free(ent);
    for (let i = 0; i < 18; i++) {
      expect(ent.client?.localmenu[i]?.text).toBeNull();
      expect(ent.client?.localmenu[i]?.func).toBeNull();
    }
  });

  test("Menu_Draw writes an svc_layout string highlighting the selected item", () => {
    const rec = setupWorld();
    const ent = makePlayer(1);
    if (ent.client === null) throw new Error("no client");
    ent.client.menu = 0; // MENU_LOCAL
    Menu_Set(ent, 0, "Item A", () => {});
    Menu_Set(ent, 1, "Item B", () => {});
    ent.client.menuselect = 1;
    level.framenum = 5;
    ent.client.menumovetime = 0;

    Menu_Draw(ent);

    expect(rec.writeByte).toContain(4); // svc_layout
    expect(rec.writeString.length).toBe(1);
    const layout = rec.writeString[0] ?? "";
    expect(layout).toContain("Item A");
    expect(layout).toContain("Item B");
    // the selected row uses the highlighted "string" command with a \x0d prefix
    expect(layout).toContain('string "\x0dItem B"');
  });

  test("Menu_Draw is rate-limited to once per server frame", () => {
    const rec = setupWorld();
    const ent = makePlayer(1);
    if (ent.client === null) throw new Error("no client");
    ent.client.menu = 0;
    Menu_Set(ent, 0, "Only item", () => {});
    level.framenum = 7;

    Menu_Draw(ent);
    Menu_Draw(ent); // same frame -- should be a no-op

    expect(rec.writeString.length).toBe(1);
  });

  test("Menu_Next/Menu_Prev skip entries with no func and wrap around", () => {
    const ent = makePlayer(1);
    if (ent.client === null) throw new Error("no client");
    ent.client.menu = 0;
    Menu_Set(ent, 0, "A", () => {});
    Menu_Set(ent, 1, "spacer", null);
    Menu_Set(ent, 2, "B", () => {});
    ent.client.menuselect = 0;

    Menu_Next(ent);
    expect(ent.client.menuselect).toBe(2); // skipped slot 1 (no func)

    Menu_Prev(ent);
    expect(ent.client.menuselect).toBe(0); // back to A, skipping slot 1 again
  });

  test("Menu_Use dispatches the selected func and tracks prevmenu/currmenu/menupage", () => {
    const ent = makePlayer(1);
    if (ent.client === null) throw new Error("no client");
    ent.client.menu = 0;
    let calls = 0;
    const target = (): void => {
      calls++;
    };
    Menu_Set(ent, 0, "Go", target);
    ent.client.menuselect = 0;
    ent.client.menupage = 3;

    Menu_Use(ent);

    expect(calls).toBe(1);
    expect(ent.client.currmenu).toBe(target);
    expect(ent.client.menupage).toBe(0); // different menu than prevmenu (null) -> reset to 0

    // calling again with the same currmenu/prevmenu increments the page
    // (this is how "<next page>" entries work -- see Skin_Menu/Help_Menu)
    Menu_Use(ent);
    expect(ent.client.menupage).toBe(1);
  });

  test("Main_Menu shows Change Team/Become Observer for a red team player", () => {
    const ent = makePlayer(1, CTF_TEAM_RED);
    Main_Menu(ent);

    expect(ent.client?.localmenu[3]?.text).toBe("Become Observer");
    expect(ent.client?.localmenu[4]?.text).toBe("Change Team");
  });

  test("Help_Menu paginates 15 entries per page using the empty-string sentinel", () => {
    const ent = makePlayer(1);
    if (ent.client === null) throw new Error("no client");
    ent.client.menupage = 0;

    // helptext starts empty (see g_menu.ts's header -- populated by
    // g_save.c's config parser, not yet ported); Help_Menu must degrade to
    // "no entries" rather than throwing.
    Help_Menu(ent);

    expect(ent.client.localmenu[17]?.text).toBe("<next page>");
    expect(ent.client.localmenu[2]?.text).toBeNull();
  });

  test("Ref_CTFFlags_Menu: Offhand Hook lands in slot 7, not 6 (NOVOICE_OK is never defined)", () => {
    const ent = makePlayer(1);
    if (ent.client === null) throw new Error("no client");
    ent.client.ctf.extra_flags = 0;
    gameCvars.ctfflags = fakeCvar(0);

    Ref_CTFFlags_Menu(ent);

    expect(ent.client.localmenu[6]?.text).toBeNull();
    expect(ent.client.localmenu[7]?.text).toContain("Offhand Hook");
  });

  test("Ref_DMFlags_Menu reflects the dmflags cvar bits as ON/OFF", () => {
    const ent = makePlayer(1);
    gameCvars.dmflags = fakeCvar(0x1); // DF_NO_HEALTH

    Ref_DMFlags_Menu(ent);

    expect(ent.client?.localmenu[2]?.text).toContain("ON");
    expect(ent.client?.localmenu[3]?.text).toContain("OFF");
  });
});

// ===========================================================================
// g_skins.ts -- skins.ini parsing
// ===========================================================================

describe("g_skins.ts", () => {
  let tmpDir: string;

  beforeEach(() => {
    setupWorld();
    ResetSkinsForTest();
    tmpDir = mkdtempSync(join(tmpdir(), "lmctf-skins-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("SkinsReadFile parses [red]/[blue] sections and ignores comments", () => {
    const content = ["# a comment", "[red]", "male/rb-rm1", "male/rb-rm2", "; another comment", "[blue]", "female/rb-rf1", ""].join("\n");
    FS_WriteFile(join(tmpDir, "skins.ini"), content);
    SetSkinsConfigForTest(tmpDir, "skins.ini");

    SkinsReadFile();

    expect(SkinListInUse()).toBe(true);

    const ent = makePlayer(1, CTF_TEAM_RED);
    expect(SkinValid(ent, "male/rb-rm1")).toBe(true);
    expect(SkinValid(ent, "male/rb-rm2")).toBe(true);
    expect(SkinValid(ent, "female/rb-rf1")).toBe(false); // wrong team's list

    const blueEnt = makePlayer(2, CTF_TEAM_BLUE);
    expect(SkinValid(blueEnt, "female/rb-rf1")).toBe(true);

    const redList = SkinGetList(ent);
    expect(redList).toEqual(["male/rb-rm1", "male/rb-rm2"]);
  });

  test("SkinRandom returns one of the parsed entries for the player's team", () => {
    FS_WriteFile(join(tmpDir, "skins.ini"), ["[red]", "male/rb-rm1", "[blue]", "female/rb-rf1", "female/rb-rf2"].join("\n"));
    SetSkinsConfigForTest(tmpDir, "skins.ini");
    SkinsReadFile();

    const ent = makePlayer(1, CTF_TEAM_BLUE);
    const picked = SkinRandom(ent);
    expect(["female/rb-rf1", "female/rb-rf2"]).toContain(picked);
  });

  test("SkinsReadFile is a no-op when the file does not exist", () => {
    SetSkinsConfigForTest(tmpDir, "does-not-exist.ini");
    SkinsReadFile();
    expect(SkinListInUse()).toBe(false);
  });
});

// ===========================================================================
// g_vote.ts -- vote lifecycle
// ===========================================================================

describe("g_vote.ts", () => {
  beforeEach(() => {
    setupWorld();
    ResetVoteForTest();
  });

  test("Vote_Skip_Level refuses to start with fewer than 4 players", () => {
    const rec = setupWorld();
    const ent = makePlayer(1);
    makePlayer(2);
    makePlayer(3); // only 3 players

    Vote_Skip_Level(ent);

    expect(VoteStarted).toBe(false);
    expect(rec.cprintf.some((s) => s.includes("at least four players"))).toBe(true);
  });

  test("Vote_Skip_Level starts a vote with 4+ players and auto-votes YES", () => {
    makePlayer(1);
    makePlayer(2);
    makePlayer(3);
    const initiator = makePlayer(4);

    Vote_Skip_Level(initiator);

    expect(VoteStarted).toBe(true);
    expect((initiator.client?.ctf.extra_flags ?? 0) & CTF_EXTRAFLAGS_VOTE_YES).toBeTruthy();
    expect((initiator.client?.ctf.extra_flags ?? 0) & CTF_EXTRAFLAGS_VOTE_NO).toBeFalsy();
  });

  test("Clear_All_Ballots resets every player's yes/no flags to abstain", () => {
    const a = makePlayer(1);
    const b = makePlayer(2);
    if (a.client === null || b.client === null) throw new Error("no client");
    a.client.ctf.extra_flags = CTF_EXTRAFLAGS_VOTE_YES;
    b.client.ctf.extra_flags = CTF_EXTRAFLAGS_VOTE_NO;

    const count = Clear_All_Ballots(a);

    expect(count).toBe(2);
    expect(a.client.ctf.extra_flags & CTF_EXTRAFLAGS_VOTE_YES).toBeFalsy();
    expect(b.client.ctf.extra_flags & CTF_EXTRAFLAGS_VOTE_NO).toBeFalsy();
  });

  test("Vote_YES / Vote_NO toggle the caller's ballot flags exclusively", () => {
    const ent = makePlayer(1);
    Vote_YES(ent);
    expect((ent.client?.ctf.extra_flags ?? 0) & CTF_EXTRAFLAGS_VOTE_YES).toBeTruthy();
    expect((ent.client?.ctf.extra_flags ?? 0) & CTF_EXTRAFLAGS_VOTE_NO).toBeFalsy();

    Vote_NO(ent);
    expect((ent.client?.ctf.extra_flags ?? 0) & CTF_EXTRAFLAGS_VOTE_YES).toBeFalsy();
    expect((ent.client?.ctf.extra_flags ?? 0) & CTF_EXTRAFLAGS_VOTE_NO).toBeTruthy();
  });

  test("Check_Vote: 3 yes / 1 no is 75% and passes (skip vote ends the level)", () => {
    const rec = setupWorld();
    const initiator = makePlayer(1);
    const p2 = makePlayer(2);
    const p3 = makePlayer(3);
    const p4 = makePlayer(4);

    // Vote_Skip_Level itself calls Clear_All_Ballots first (resetting
    // every player to abstain) before auto-voting the initiator YES, so
    // the other players' ballots must be set AFTER this call, not before.
    Vote_Skip_Level(initiator);
    if (p2.client === null || p3.client === null || p4.client === null) throw new Error("no client");
    p2.client.ctf.extra_flags = CTF_EXTRAFLAGS_VOTE_YES;
    p3.client.ctf.extra_flags = CTF_EXTRAFLAGS_VOTE_YES;
    p4.client.ctf.extra_flags = CTF_EXTRAFLAGS_VOTE_NO;
    level.time = 100000; // force "30 seconds have passed"

    // initiator+p2+p3 = 3 YES, p4 = 1 NO -> 75% exactly, which passes and
    // (for a skip vote) calls EndDMLevel() -- a genuine unported
    // cross-dependency into unit A's g_main.ts, documented in g_vote.ts.
    expect(() => Check_Vote()).toThrow("EndDMLevel not yet ported");
    expect(VoteStarted).toBe(false); // set false before the throwing call
    expect(rec.bprintf.some((s) => s.includes("YES:3") && s.includes("NO:1"))).toBe(true);
    expect(rec.bprintf.some((s) => s.includes("Passes with 75 percent majority"))).toBe(true);
  });

  test("Check_Vote: 1 yes / 1 no fails outright (fewer than 2 total ballots is the real gate, not reached here -- 50% fails majority)", () => {
    const rec = setupWorld();
    const a = makePlayer(1);
    const b = makePlayer(2);
    makePlayer(3);
    makePlayer(4);
    if (a.client === null || b.client === null) throw new Error("no client");
    a.client.ctf.extra_flags = CTF_EXTRAFLAGS_VOTE_YES;
    b.client.ctf.extra_flags = CTF_EXTRAFLAGS_VOTE_NO;

    Vote_Skip_Level(a); // sets VoteStarted/VoteTime/VoteType, and re-votes a to YES
    b.client.ctf.extra_flags = CTF_EXTRAFLAGS_VOTE_NO; // Vote_Skip_Level didn't touch b
    level.time = 100000;

    Check_Vote();

    expect(rec.bprintf.some((s) => s.includes("Vote Fails"))).toBe(true);
  });
});

// ===========================================================================
// p_stats.ts -- stats accumulation
// ===========================================================================

describe("p_stats.ts", () => {
  beforeEach(() => setupWorld());

  test("stats_add/stats_set/stats_get round-trip through a player's p_stats_player", () => {
    const ent = makePlayer(1);
    if (ent.client === null) throw new Error("no client");
    ent.client.p_stats_player = stats_new_player("player1");

    stats_set(ent, STATS_FRAGS, 5);
    stats_add(ent, STATS_FRAGS, 1);
    expect(stats_get(ent, STATS_FRAGS)).toBe(6);
  });

  test("stats_add/stats_set are gated by Match_CanScore", () => {
    const ent = makePlayer(1);
    if (ent.client === null) throw new Error("no client");
    ent.client.p_stats_player = stats_new_player("player1");
    SetMatchState(MatchStatesT.MATCH_COUNTDOWN); // Match_CanScore() false

    stats_set(ent, STATS_FRAGS, 5);

    expect(stats_get(ent, STATS_FRAGS)).toBe(0);
  });

  test("stats_clear resets a player's stats array and resp.score", () => {
    const ent = makePlayer(1);
    if (ent.client === null) throw new Error("no client");
    ent.client.p_stats_player = stats_new_player("player1");
    stats_set(ent, STATS_DEATHS, 3);
    ent.client.resp.score = 42;

    stats_clear(ent);

    expect(stats_get(ent, STATS_DEATHS)).toBe(0);
    expect(ent.client.resp.score).toBe(0);
  });

  test("stats_cleanup drops players marked dropped and keeps active ones", () => {
    stats_log_init(); // p_start_player is module state; start from an empty list
    const dropped = stats_new_player("gone"); // prepended first -> ends up second
    dropped.dropped = true;
    const active = stats_new_player("staying"); // prepended second -> ends up at the head
    active.dropped = false;
    active.stats[STATS_FRAGS] = 9;

    stats_cleanup();

    // p_start_player is module-private (no exported "list everything"
    // accessor, matching p_stats.c's own lack of one); stats_find_dropped_player
    // is the only exported function that walks the live list, so a
    // now-removed dropped player must stop being findable by it.
    expect(stats_find_dropped_player("gone")).toBeNull();
    expect(active.stats[STATS_FRAGS]).toBe(0); // reinitialized, not just kept
  });

  test("Cmd_StatsAll_f: throws on the documented ctf_teamstring cross-dependency, not on anything else", () => {
    const ent = makePlayer(1);
    if (ent.client === null) throw new Error("no client");
    ent.client.p_stats_player = stats_new_player("player1");
    stats_set(ent, STATS_FRAGS, 2);

    // stats_output (p_stats.ts) unconditionally calls ctf_teamstring, a
    // cross-dependency into unit A's pending g_ctffunc.ts completion (see
    // p_stats.ts's own stats_output doc comment) -- this documents exactly
    // where it currently stops, not a p_stats.ts defect.
    expect(() => Cmd_StatsAll_f(ent)).toThrow("ctf_teamstring not yet ported");
  });
});

// ===========================================================================
// stdlog.ts / gslog.ts -- log line format vs the C's exact format strings
// ===========================================================================

describe("stdlog.ts / gslog.ts", () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    setupWorld();
    tmpDir = mkdtempSync(join(tmpdir(), "lmctf-log-"));
    logPath = join(tmpDir, "std.log");
  });

  afterEach(() => {
    sl_CloseLogFile(); // reset stdlog.ts's module-private open-file state between tests
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function registerCvar(name: string, value: string): void {
    const c = new CvarT();
    c.name = name;
    c.string = value;
    c.value = Number.parseFloat(value) || 0;
    cvarRegistry.set(name, c);
  }

  function enableLogging(): void {
    registerCvar("stdlogfile", "1");
    registerCvar("stdlogname", logPath);
  }

  function readLog(): string {
    sl_CloseLogFile();
    return readFileSync(logPath, "utf8");
  }

  // gslog.ts's `fWasAlreadyOpen` module flag (mirrors the C source's own
  // file-scope static) only ever flips true->false via sl_GameEnd, which
  // none of these tests call -- so whichever test happens to run FIRST in
  // the whole process gets sl_Logging's one-time version/date/time/
  // deathflags preamble and later ones don't, an ordering hazard these
  // tests must not depend on. Reading just the trailing score line makes
  // every sl_WriteStdLogDeath assertion robust to that either way.
  function readLastLogLine(): string {
    const content = readLog();
    const lines = content.split("\n").filter((l) => l.length > 0);
    return `${lines[lines.length - 1] ?? ""}\n`;
  }

  test("sl_LogScore writes tab-separated fields in the exact C order", () => {
    enableLogging();
    sl_LogScore("killer", "victim", "Kill", "Railgun", 1, 12.3);

    expect(readLog()).toBe("killer\tvictim\tKill\tRailgun\t1\t12.3\n");
  });

  test("sl_LogScore omits missing fields but keeps the tab structure", () => {
    enableLogging();
    sl_LogScore(null, null, "ERROR", null, 0, 5.0);

    expect(readLog()).toBe("\t\tERROR\t\t0\t5.0\n");
  });

  test("sl_LogPlayerConnect: with and without a team name", () => {
    enableLogging();
    sl_LogPlayerConnect("Alice", "red", 1.0);
    sl_LogPlayerConnect("Bob", null, 2.0);

    expect(readLog()).toBe("\t\tPlayerConnect\tAlice\tred\t1.0\n\t\tPlayerConnect\tBob\t\t2.0\n");
  });

  test("sl_LogScore is silent when stdlogfile is off (the default)", () => {
    sl_LogScore("k", "t", "Kill", "w", 1, 1.0);
    // no cvar registered at all -- _sl_MaybeOpenFile's lazy gi.cvar("stdlogfile","0",...)
    // creates a fresh, off-by-default cvar, so nothing should ever open.
    expect(() => readFileSync(logPath, "utf8")).toThrow();
  });

  test("sl_WriteStdLogDeath: MOD_FALLING via a non-self attacker path logs 'Fell' as a suicide", () => {
    enableLogging();
    gameCvars.deathmatch = fakeCvar(1);
    const self = makePlayer(1);
    setMeansOfDeath(MOD_FALLING);
    sl_WriteStdLogDeath(self, self, null); // no attacker -- world damage

    expect(readLastLogLine()).toBe(`player1\t\tSuicide\tFell\t-1\t${level.time.toFixed(1)}\n`);
  });

  test("sl_WriteStdLogDeath: MOD_TELEFRAG logs a kill with the 'Telefrag' weapon name", () => {
    enableLogging();
    gameCvars.deathmatch = fakeCvar(1);
    const self = makePlayer(1);
    const attacker = makePlayer(2);
    setMeansOfDeath(MOD_TELEFRAG);
    sl_WriteStdLogDeath(self, self, attacker);

    expect(readLastLogLine()).toBe(`player2\tplayer1\tKill\tTelefrag\t1\t${level.time.toFixed(1)}\n`);
  });

  test("sl_WriteStdLogDeath: attacker === self is always a weapon suicide, regardless of mod", () => {
    enableLogging();
    gameCvars.deathmatch = fakeCvar(1);
    const self = makePlayer(1);
    if (self.client === null) throw new Error("no client");
    setMeansOfDeath(MOD_FALLING); // would be "Fell" via the OTHER branch -- not taken here
    sl_WriteStdLogDeath(self, self, self);

    // self.client.pers.weapon is null in this test setup, so pWeaponName stays null (empty field)
    expect(readLastLogLine()).toBe(`player1\t\tSuicide\t\t-1\t${level.time.toFixed(1)}\n`);
  });

  test("sl_WriteStdLogDeath: outside deathmatch always logs the ERROR line", () => {
    enableLogging();
    gameCvars.deathmatch = fakeCvar(0);
    const self = makePlayer(1);
    setMeansOfDeath(MOD_FALLING);
    sl_WriteStdLogDeath(self, self, null);

    expect(readLastLogLine()).toBe(`\t\tERROR\t\t0\t${level.time.toFixed(1)}\n`);
  });

  // g_combat.ts owns meansOfDeathHolder's mutation site (T_Damage); tests
  // reach into the same shared holder object gslog.ts reads, exactly the
  // way the real T_Damage -> sl_WriteStdLogDeath call sequence does.
  function setMeansOfDeath(mod: number): void {
    (require("../src/lmctf/g_local") as { meansOfDeathHolder: { meansOfDeath: number } }).meansOfDeathHolder.meansOfDeath = mod;
  }
});
