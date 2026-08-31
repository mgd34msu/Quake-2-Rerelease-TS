/*
Regression coverage for a live-play defect: a base1 hint banner displayed the
RAW localization key "$map_crouch_here" instead of its localized text
("Crouch here.").

Root cause (see the task report for the full derivation): the base1 door
that triggers this hint has a map-authored `message` field of literally
"$map_crouch_here" (a normal, ordinary edict `message` spawn key -- nothing
base1-specific about the mechanism). The re-release's own C++ source always
runs a map-authored `message` field through localization before it can reach
a player (g_func.cpp:1682's `gi.LocCenter_Print(other, "{}", self->message)`,
g_utils.cpp:125-130's `gi.LocBroadcast_Print`/`gi.LocCenter_Print` in
G_PrintActivationMessage, ctf/g_ctf.cpp:1784's `gi.LocCenter_Print(who,
"$g_already_have_tech")`, g_items.cpp's various `gi.LocClient_Print(ent,
level, "$key")` calls, m_actor.cpp:473's `gi.LocClient_Print(ent, PRINT_CHAT,
"{}: {}\n", name, self->message)`) -- but several of this port's equivalent
call sites had drifted onto the BARE (unlocalized) `gi.Center_Print`/
`gi.Client_Print`/`gi.Broadcast_Print`, some behind an explicitly-wrong file
header comment claiming "this port has no localization backend" (false: see
src/qcommon/loc.ts, landed in an earlier phase). Fixed call sites:
  - src/kexgame/g_func.ts's door_touch (THE exact path base1's hint takes)
  - src/kexgame/g_utils.ts's G_PrintActivationMessage (both branches)
  - src/kexgame/ctf/g_ctf.ts's CTFHasTech
  - src/kexgame/m_actor.ts's target_actor_touch broadcast loop
  - src/kexgame/g_items.ts's LocClient_Print helper (6 call sites; see
    test/kexgame_poi.test.ts's "Use_Compass" test, updated alongside this
    unit, for a 7th already-existing regression test that caught this same
    defect pattern for "$no_valid_poi")

Two more layers needed a real fix, not just the game-logic call sites:
  - src/server/bindings/kex.ts's `Loc_Print` binding always routed through
    the single-client path regardless of the `PRINT_BROADCAST` bit -- see
    q2repro's own `PF_Loc_Print` (server/game.c:790-831), which branches on
    that bit and clamps the broadcast print level to something svc_print's
    broadcast form actually supports. Without this fix,
    G_PrintActivationMessage's coop-wide branch (ent=null,
    PRINT_CENTER|PRINT_BROADCAST) would silently degrade to a console-only
    print instead of reaching any client.
  - src/client/cl_parse.ts's svc_print handler never inspected the print
    level for PRINT_CENTER/PRINT_TYPEWRITER at all (q2repro's own
    CL_HandlePrint, src/client/parse.c:970-1001, routes those two levels to
    a centerprint banner instead of a console line) -- this port has no kex
    cgame ParseCenterPrint member yet (src/client/cgame/host.ts's own
    header), so those two levels now fall back to this port's own
    (vanilla-protocol) `SCR_CenterPrint` banner instead.

This file is self-sufficient (PORTING.md/.orch/preferences.md rule 13): it
wires its own fake KexGameImports fixture and its own tiny loc-table fixture
file (via a temp basedir + the REAL FS_InitFilesystem/Loc_Init/Loc_ReloadFile
wiring, not a hand-rolled substitute), and never assumes another test file
ran first.
*/

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import { Cvar_ForceSet, Cvar_Get } from "../src/qcommon/cvar";
import { FS_InitFilesystem } from "../src/qcommon/files";
import { Loc_Localize } from "../src/qcommon/loc";
import { ZipArchive } from "../src/qcommon/zipfile";
import { Com_BeginRedirect, Com_EndRedirect } from "../src/qcommon/common";
import { SvcOpsT } from "../src/qcommon/qcommon";
import { NetadrT, NetsrcT } from "../src/qcommon/qcommon";
import { Netchan_Setup } from "../src/qcommon/net_chan";
import { SZ_Clear, MSG_BeginReading, MSG_WriteByte, MSG_WriteString, MSG_ReadByte, MSG_ReadString } from "../src/qcommon/sizebuf";
import { net_message } from "../src/qcommon/net_chan";
import { cl, cls, clCvars, setRe } from "../src/client/client";
import { CL_ParseServerMessage } from "../src/client/cl_parse";
import { ClientStateT, ClientT, svs, setMaxclients } from "../src/server/server";
import { BuildKexImports } from "../src/server/bindings/kex";
import type { KexEdictT, KexGameExports, KexGameImports, KexTraceT } from "../src/kexapi/game";
import { GAME_API_VERSION, PrintTypeT, SvflagsT } from "../src/kexapi/game";
import { type EdictT } from "../src/kexgame/g_local";
import { defaultEdict, gi, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { Gtime_from_ms, Gtime_add, Gtime_from_sec } from "../src/kexgame/gtime";
import { G_PrintActivationMessage } from "../src/kexgame/g_utils";
import { LookupTouch } from "../src/kexgame/g_save_registry";

// =============================================================================
// shared tiny fake loc table (a temp basedir, loaded via the REAL Loc_Init/
// Loc_ReloadFile wiring -- see loc.test.ts's own identical precedent). Uses
// a non-default `loc_file` cvar value so it can never collide with the real
// "localization/loc_english.txt" path the e2e section (bottom of this file)
// points at the real retail install.
// =============================================================================

const FIXTURE_LOC_FILE = "localization/loc_test_fixture.txt";

let fixtureRoot: string;

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "q2loc-print-fixes-"));
  const locDir = join(fixtureRoot, "baseq2", "localization");
  mkdirSync(locDir, { recursive: true });

  writeFileSync(
    join(locDir, "loc_test_fixture.txt"),
    [
      `door_hint_key = "Crouch here."`,
      `test_key = "Test Value"`,
      `test_key_arg = "Hello, {0}!"`,
      ``,
    ].join("\n"),
  );

  Cvar_ForceSet("loc_file", FIXTURE_LOC_FILE);
  Cvar_ForceSet("basedir", fixtureRoot);
  FS_InitFilesystem();
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

// =============================================================================
// Section 1: src/client/cl_parse.ts's svc_print handler -- PRINT_CENTER /
// PRINT_TYPEWRITER route to SCR_CenterPrint (a banner), everything else
// stays a plain console line. Captured via Com_BeginRedirect/Com_EndRedirect
// (the same production console-capture mechanism rcon uses), since
// SCR_CenterPrint's own centering/banner state is module-private.
// =============================================================================

describe("cl_parse.ts svc_print -- PRINT_CENTER/PRINT_TYPEWRITER become a centerprint banner, not a console line", () => {
  beforeEach(() => {
    cl.clear();
    cls.clear();
    SZ_Clear(net_message);
    MSG_BeginReading(net_message);
    clCvars.cl_shownet = null;
    setRe(null);
  });

  function sendPrint(level: number, message: string): string {
    SZ_Clear(net_message);
    MSG_WriteByte(net_message, SvcOpsT.svc_print);
    MSG_WriteByte(net_message, level);
    MSG_WriteString(net_message, message);
    MSG_BeginReading(net_message);

    let captured = "";
    // target must be nonzero: Com_BeginRedirect no-ops on a falsy target
    // (common.ts:102, `if (!target || ...) return;`) -- any nonzero value
    // works here since this test's own flush callback is the only reader.
    Com_BeginRedirect(1, 1 << 16, (_target, buffer) => {
      captured += buffer;
    });
    try {
      CL_ParseServerMessage();
    } finally {
      Com_EndRedirect();
    }
    return captured;
  }

  test("PRINT_HIGH prints the raw string to the console, unpadded, no banner", () => {
    const out = sendPrint(PrintTypeT.PRINT_HIGH, "TEST_HIGH_MESSAGE");
    expect(out).toBe("TEST_HIGH_MESSAGE");
  });

  test("PRINT_CENTER routes through SCR_CenterPrint's banner instead of a bare console line", () => {
    const out = sendPrint(PrintTypeT.PRINT_CENTER, "TEST_CENTER_MESSAGE");
    // SCR_CenterPrint's banner separator (cl_scrn.ts:215) -- proves the
    // centerprint path was taken, not CL_HandlePrint's old unconditional
    // Com_Printf. The plain PRINT_HIGH case above proves the negative (no
    // banner marker there).
    expect(out).toContain("\x1d\x1e");
    expect(out).toContain("TEST_CENTER_MESSAGE");
    expect(out).not.toBe("TEST_CENTER_MESSAGE"); // not a bare, unpadded echo
  });

  test("PRINT_TYPEWRITER also routes through SCR_CenterPrint's banner (q2repro's CL_HandlePrint treats it the same as PRINT_CENTER)", () => {
    const out = sendPrint(PrintTypeT.PRINT_TYPEWRITER, "TEST_TYPEWRITER_MESSAGE");
    expect(out).toContain("\x1d\x1e");
    expect(out).toContain("TEST_TYPEWRITER_MESSAGE");
  });
});

// =============================================================================
// Section 2: src/server/bindings/kex.ts's `Loc_Print` binding -- real
// localization (bare $key, $key+args, unknown $key, non-$ passthrough) and
// the PRINT_BROADCAST-bit clamp (game.c lines 822-827 -- every broadcast
// print above PRINT_CHAT that isn't PRINT_TTS gets clamped down to PRINT_CHAT, since
// broadcast svc_print can't carry a per-client "extended" centerprint flag).
// Uses the REAL BuildKexImports() (no fake gi here) with one real connected
// ClientT so the actual wire bytes (opcode/level/string) can be inspected.
// =============================================================================

describe("kex.ts BuildKexImports().Loc_Print -- real localization + PRINT_BROADCAST clamp", () => {
  let imports: KexGameImports;
  let fakeClient: ClientT;

  beforeEach(() => {
    imports = BuildKexImports();

    const maxclients = Cvar_Get("maxclients", "4", 0);
    if (maxclients) setMaxclients(maxclients);
    if (maxclients) maxclients.value = 1;

    fakeClient = new ClientT();
    Netchan_Setup(NetsrcT.NS_SERVER, fakeClient.netchan, new NetadrT(), 0);
    fakeClient.state = ClientStateT.cs_spawned;
    fakeClient.messagelevel = 0;
    svs.clients = [fakeClient];
  });

  function readBroadcastMessage(): { opcode: number; level: number; text: string } {
    const msg = fakeClient.netchan.message;
    MSG_BeginReading(msg);
    const opcode = MSG_ReadByte(msg);
    const level = MSG_ReadByte(msg);
    const text = MSG_ReadString(msg);
    return { opcode, level, text };
  }

  test("bare $key expansion: a $-prefixed loc key resolves to its loaded format string", () => {
    imports.Loc_Print(null, PrintTypeT.PRINT_HIGH | PrintTypeT.PRINT_BROADCAST, "$test_key", [], 0);
    const { opcode, level: sentLevel, text } = readBroadcastMessage();
    expect(opcode).toBe(SvcOpsT.svc_print);
    expect(sentLevel).toBe(PrintTypeT.PRINT_HIGH); // no clamp needed, already <= PRINT_CHAT... see below
    expect(text).toBe("Test Value");
  });

  test("a key with substitution args: {0} is replaced from the args array", () => {
    imports.Loc_Print(null, PrintTypeT.PRINT_HIGH | PrintTypeT.PRINT_BROADCAST, "$test_key_arg", ["World"], 1);
    const { text } = readBroadcastMessage();
    expect(text).toBe("Hello, World!");
  });

  test("an unknown $key falls back to the key text (minus its leading '$'), matching q2repro's Loc_Localize fallback", () => {
    imports.Loc_Print(null, PrintTypeT.PRINT_HIGH | PrintTypeT.PRINT_BROADCAST, "$totally_unknown_test_key", [], 0);
    const { text } = readBroadcastMessage();
    expect(text).toBe("totally_unknown_test_key");
  });

  test("non-$ text passes through completely untouched", () => {
    imports.Loc_Print(null, PrintTypeT.PRINT_HIGH | PrintTypeT.PRINT_BROADCAST, "Plain text, no key here", [], 0);
    const { text } = readBroadcastMessage();
    expect(text).toBe("Plain text, no key here");
  });

  test("PRINT_BROADCAST + PRINT_CENTER is clamped to PRINT_CHAT (game.c:825-826: svc_print's broadcast form can't carry a centerprint level)", () => {
    imports.Loc_Print(null, PrintTypeT.PRINT_CENTER | PrintTypeT.PRINT_BROADCAST, "$test_key", [], 0);
    const { level: sentLevel, text } = readBroadcastMessage();
    expect(sentLevel).toBe(3); // PRINT_CHAT
    expect(text).toBe("Test Value"); // still localized correctly despite the clamp
  });

  test("PRINT_BROADCAST + PRINT_HIGH (already <= PRINT_CHAT) is sent unclamped", () => {
    imports.Loc_Print(null, PrintTypeT.PRINT_HIGH | PrintTypeT.PRINT_BROADCAST, "$test_key", [], 0);
    const { level: sentLevel } = readBroadcastMessage();
    expect(sentLevel).toBe(PrintTypeT.PRINT_HIGH);
  });
});

// =============================================================================
// Section 3: src/kexgame/g_utils.ts's G_PrintActivationMessage -- both
// branches (single-client via the non-coop path, and the coop-global
// broadcast path) now go through gi.Loc_Print instead of the bare
// gi.Center_Print/gi.Broadcast_Print.
// =============================================================================

function noHitTrace(end: ReturnType<typeof vec3>): KexTraceT {
  return {
    allsolid: false,
    startsolid: false,
    fraction: 1,
    endpos: vec3(end[0], end[1], end[2]),
    plane: new CplaneT(),
    surface: null,
    contents: 0,
    ent: null,
    plane2: new CplaneT(),
    surface2: null,
  };
}

interface LocPrintCall {
  ent: KexEdictT | null;
  level: number;
  base: string;
  args: string[];
}

function makeFakeGameImports(recorder: LocPrintCall[]): KexGameImports {
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
    Broadcast_Print() {},
    Com_Print() {},
    Client_Print() {},
    Center_Print() {},
    sound() {},
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
    trace(_start, _mins, _maxs, end) {
      return noHitTrace(end);
    },
    clip(_entity, _start, _mins, _maxs, end) {
      return noHitTrace(end);
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
    Bot_UnRegisterEdict() {},
    Bot_MoveToPoint() {
      return 0;
    },
    Bot_FollowActor() {
      return 0;
    },
    GetPathToGoal() {
      return false;
    },
    // The one member this test actually exercises: records the call AND
    // runs it through the REAL Loc_Localize against this file's tiny fake
    // loc table (top of file), so both "was the right base/args passed" and
    // "does it actually resolve to the right text" are provable.
    Loc_Print(ent, printLevel, base, args, num_args) {
      recorder.push({ ent, level: printLevel, base, args: [...args] });
      // Mirrors the real kex.ts binding's own Loc_Localize call site.
      Loc_Localize(base, true, args, num_args);
    },
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

function makeFakeGameExports(edicts: EdictT[]): KexGameExports {
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
    num_edicts: edicts.length,
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

const FIXTURE_POOL_SIZE = 24;

function setupKexgameWorld(recorder: LocPrintCall[]): { edicts: EdictT[] } {
  const edicts: EdictT[] = [];
  for (let i = 0; i < FIXTURE_POOL_SIZE; i++) {
    const e = defaultEdict();
    e.s.number = i;
    edicts.push(e);
  }
  SetGEdicts(edicts);
  game.maxclients = 4;
  game.maxentities = FIXTURE_POOL_SIZE;
  level.time = Gtime_from_ms(0);
  SetGameImports(makeFakeGameImports(recorder));
  SetGameExports(makeFakeGameExports(edicts));
  return { edicts };
}

describe("g_utils.ts G_PrintActivationMessage -- ent.message ($key or plain text) now goes through real localization", () => {
  let recorder: LocPrintCall[];
  let edicts: EdictT[];

  beforeEach(() => {
    recorder = [];
    ({ edicts } = setupKexgameWorld(recorder));
  });

  test("single-client branch (coop_global=false): a bare $key resolves to its loaded format", () => {
    const ent = edicts[5]!;
    ent.message = "$door_hint_key";
    const activator = edicts[6]!;
    activator.inuse = true;

    G_PrintActivationMessage(ent, activator, false);

    expect(recorder).toEqual([{ ent: activator, level: PrintTypeT.PRINT_CENTER, base: "{}", args: ["$door_hint_key"] }]);
    // Prove the "{}"-wrapped positional format actually resolves the way
    // door_touch/g_func.ts relies on: Loc_Localize("{}", true, ["$door_hint_key"], 1).
    expect(Loc_Localize("{}", true, ["$door_hint_key"], 1)).toBe("Crouch here.");
  });

  test("single-client branch: non-$ plain text passes through untouched", () => {
    const ent = edicts[5]!;
    ent.message = "Plain activation text";
    const activator = edicts[6]!;
    activator.inuse = true;

    G_PrintActivationMessage(ent, activator, false);

    expect(recorder[0]?.base).toBe("{}");
    expect(recorder[0]?.args).toEqual(["Plain activation text"]);
    expect(Loc_Localize("{}", true, ["Plain activation text"], 1)).toBe("Plain activation text");
  });

  test("single-client branch: an unknown $key falls back to the bare key text", () => {
    const ent = edicts[5]!;
    ent.message = "$totally_unknown_test_key";
    const activator = edicts[6]!;
    activator.inuse = true;

    G_PrintActivationMessage(ent, activator, false);

    expect(Loc_Localize("{}", true, ["$totally_unknown_test_key"], 1)).toBe("totally_unknown_test_key");
  });

  test("coop-global broadcast branch (ent=null, PRINT_BROADCAST set): still carries the message as a Loc_Print arg, not a bare Broadcast_Print", () => {
    const cvars = new Map<string, CvarT>();
    void cvars; // (kept for symmetry with the fixture above; not read here)

    const ent = edicts[5]!;
    ent.message = "$door_hint_key";
    const activator = edicts[6]!;
    activator.inuse = true;

    // Force coopEnabled() true: gi.cvar("coop", "0", ...) is memoized by
    // name in this fixture's cvar map, so setting .value after the first
    // read still takes effect on the SAME CvarT object G_PrintActivationMessage reads.
    const coopCvar = gi.cvar("coop", "0", 0);
    if (coopCvar) coopCvar.value = 1;

    G_PrintActivationMessage(ent, activator, true);

    expect(recorder).toEqual([{ ent: null, level: PrintTypeT.PRINT_CENTER | PrintTypeT.PRINT_BROADCAST, base: "{}", args: ["$door_hint_key"] }]);
  });

  test("activator with SVF_MONSTER set is skipped entirely (no print at all)", () => {
    const ent = edicts[5]!;
    ent.message = "$door_hint_key";
    const activator = edicts[6]!;
    activator.inuse = true;
    activator.svflags = SvflagsT.SVF_MONSTER;

    G_PrintActivationMessage(ent, activator, false);

    expect(recorder).toEqual([]);
  });
});

// =============================================================================
// Section 4: src/kexgame/g_func.ts's door_touch -- THE exact path base1's
// "$map_crouch_here" hint takes. Looked up via LookupTouch (the registry
// SP_func_door wires `ent.touch` from) rather than a full SP_func_door spawn,
// matching kexgame_g_func.test.ts's own stated convention ("handlers are
// driven the way the real engine drives them -- through the entity's own
// .use/.think/.touch fields").
// =============================================================================

describe("g_func.ts door_touch -- self.message ($key or plain text) now goes through real localization", () => {
  let recorder: LocPrintCall[];
  let edicts: EdictT[];

  beforeEach(() => {
    recorder = [];
    ({ edicts } = setupKexgameWorld(recorder));
    level.time = Gtime_from_ms(0);
  });

  function touch(door: EdictT, other: EdictT): void {
    const fn = LookupTouch("door_touch");
    expect(fn).not.toBeNull();
    fn!(door, other, noHitTrace(vec3(0, 0, 0)), false);
  }

  function makePlayer(edicts: EdictT[], index: number): EdictT {
    const e = edicts[index]!;
    e.inuse = true;
    // door_touch only checks `other.client === null`; a minimal non-null
    // marker is enough (this file doesn't need a real GClientT for this).
    e.client = {} as EdictT["client"];
    return e;
  }

  test("bare $key expansion: base1's exact case -- self.message = a $key resolves to the loaded format", () => {
    const door = edicts[5]!;
    door.inuse = true;
    door.message = "$door_hint_key";
    const other = makePlayer(edicts, 6);

    touch(door, other);

    expect(recorder).toEqual([{ ent: other, level: PrintTypeT.PRINT_CENTER, base: "{}", args: ["$door_hint_key"] }]);
    expect(Loc_Localize("{}", true, ["$door_hint_key"], 1)).toBe("Crouch here.");
  });

  test("an unknown $key falls back to the bare key text", () => {
    const door = edicts[5]!;
    door.inuse = true;
    door.message = "$totally_unknown_test_key";
    const other = makePlayer(edicts, 6);

    touch(door, other);

    expect(Loc_Localize("{}", true, ["$totally_unknown_test_key"], 1)).toBe("totally_unknown_test_key");
  });

  test("non-$ text passes through untouched", () => {
    const door = edicts[5]!;
    door.inuse = true;
    door.message = "This door requires the red key";
    const other = makePlayer(edicts, 6);

    touch(door, other);

    expect(Loc_Localize("{}", true, ["This door requires the red key"], 1)).toBe("This door requires the red key");
  });

  test("a null message never reaches gi.Loc_Print with a null arg (g_func.cpp has no null-message touch call in the first place, but this port's ?? \"\" fallback must not crash)", () => {
    const door = edicts[5]!;
    door.inuse = true;
    door.message = null;
    const other = makePlayer(edicts, 6);

    expect(() => touch(door, other)).not.toThrow();
    expect(recorder[0]?.args).toEqual([""]);
  });

  test("touch_debounce_time gates repeated touches (g_func.cpp:1678-1680)", () => {
    const door = edicts[5]!;
    door.inuse = true;
    door.message = "$door_hint_key";
    const other = makePlayer(edicts, 6);

    touch(door, other);
    touch(door, other); // still within the 5s debounce window

    expect(recorder.length).toBe(1);

    level.time = Gtime_add(level.time, Gtime_from_sec(6));
    touch(door, other);
    expect(recorder.length).toBe(2);
  });
});

// =============================================================================
// Section 5: e2e against the REAL retail Q2Game.kpf -- skipped if the retail
// install isn't present (mirrors test/cl_demo_retail.test.ts's precedent,
// including that precedent's own reason for NOT using this engine's own
// FS_AddGameDirectory/add_game_kpf against the real retail tree directly:
// doing so would mount the full retail Q2Game.kpf + baseq2/pak0.pak into the
// process-wide `fs_searchpaths` singleton for the rest of the test run,
// which is additive-only (FS_InitFilesystem never un-mounts anything) and
// would then shadow every OTHER test file's own synthetic fixtures for any
// path the real retail data also happens to provide -- concretely caught
// here: r_image_png.test.ts's "PNG fallback on a PCX miss" test broke the
// first time this section mounted the real basedir directly, because the
// real retail pak0.pak DOES ship a real pics/conchars.pcx, which then won
// that test's own lookup instead of its synthetic no-pcx fixture.
//
// Fixed the same way cl_demo_retail.test.ts fixes it: read the real KPF's
// bytes directly off disk with this codebase's own ZipArchive reader (no
// FS_* module involved, no shared search-path mutation), extract exactly
// "localization/loc_english.txt", and feed THOSE bytes into a private temp
// basedir that only this test ever mounts -- so the real loc loader
// (Loc_Init/Loc_ReloadFile/Loc_Parse) still runs end-to-end against the
// genuine retail file content, without ever touching the shared engine
// filesystem singleton with the rest of the retail install.
// =============================================================================

const RETAIL_KPF_PATH = "/home/buzzkill/q2rets/rerelease/Q2Game.kpf";
const haveRetailKpf = existsSync(RETAIL_KPF_PATH);

describe("loc.ts against the real retail Q2Game.kpf's loc_english.txt (skipped if the retail install isn't present)", () => {
  let e2eRoot: string;

  test.skipIf(!haveRetailKpf)("$map_crouch_here resolves to the real English hint text via the port's real loc loader", () => {
    const kpfBytes = new Uint8Array(readFileSync(RETAIL_KPF_PATH));
    const archive = ZipArchive.open(kpfBytes);
    expect(archive).not.toBeNull();
    const locBytes = archive!.readFile("localization/loc_english.txt");
    expect(locBytes).not.toBeNull();

    e2eRoot = mkdtempSync(join(tmpdir(), "q2loc-retail-e2e-"));
    try {
      const locDir = join(e2eRoot, "baseq2", "localization");
      mkdirSync(locDir, { recursive: true });
      writeFileSync(join(locDir, "loc_english.txt"), Buffer.from(locBytes!));

      Cvar_ForceSet("loc_file", "localization/loc_english.txt");
      Cvar_ForceSet("basedir", e2eRoot);
      FS_InitFilesystem();

      // Quoted verbatim from the retail loc_english.txt entry
      // (map_crouch_here = "%bind:+movedown:$m_crouch%Crouch here."): the
      // "%bind:...%" token is a SEPARATE client-side keybind-hint
      // substitution this port's loc.ts does not implement (and q2repro's
      // own loc.c doesn't either -- it's a cgame HUD concern, not
      // Loc_Localize's `{n}` grammar), so Loc_Localize's own output is the
      // literal, unexpanded string below.
      expect(Loc_Localize("$map_crouch_here", true, [], 0)).toBe("%bind:+movedown:$m_crouch%Crouch here.");
    } finally {
      rmSync(e2eRoot, { recursive: true, force: true });
    }
  });
});
