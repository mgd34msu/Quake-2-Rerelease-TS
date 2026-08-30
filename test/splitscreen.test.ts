/*
Splitscreen scope-ruling tests (ARCHITECTURE.md phase 7 "Splitscreen").

SCOPE RULING (investigated against ~/Projects/qsrc/q2repro and
~/Projects/quake2-rerelease-dll/rerelease, cited per-claim below):

  q2repro -- our PC engine reference -- does NOT implement local splitscreen
  rendering or input. src/client/cgame_classic.c:858's own comment says so
  outright: "Note: isplit is ignored, due to missing split screen support".
  Splitscreen is a console/KEX-client feature; the game DLL's API (game.h's
  MAX_SPLIT_PLAYERS=8, `dupe_key` on unicast/local_sound, `isplit` on
  DrawHUD/SCR_DrawBind/centerprint/notify) is carried by q2repro purely so
  the SAME game module also runs on the console client, not because the PC
  engine does anything with it: q2repro's own PF_Unicast (server/game.c:100)
  and PF_LocalSound (server/game.c:638) both accept a `dupe_key` parameter
  and never read it in either body.

  On a PC engine, what a console calls "the second splitscreen player" is
  instead an ordinary second network client with its own connection --
  ClientChooseSlot_Any/_Coop (p_client.cpp:2678-2814, this port's
  src/kexgame/p_client.ts:2836-2954) just hands out distinct player slots to
  distinct callers, exactly as multiplayer already requires. There is no
  "dupe_key dedup" work to do: dedup only matters when several local players
  share ONE physical connection (the console case), which never happens
  here.

  Per rule 17 (match the reference's OBSERVED BEHAVIOR): this port's correct
  scope is the SAME as q2repro's -- full API-level plumbing (already landed
  in earlier phase-7 units: MAX_SPLIT_PLAYERS-sized arrays in
  src/kexgame/cgame/cg_screen.ts's hud_data/src/kexgame/g_local_types.ts's
  poi_points, isplit threaded through every cgame draw/print entry point) +
  correct multi-CLIENT server behavior (this file), WITHOUT local split
  rendering, and WITHOUT implementing dupe_key deduplication (implementing
  real dedup would be a DEPARTURE from the reference, not a fix -- there is
  no shared connection here for it to protect).

  This unit's own investigation found one genuine, non-splitscreen-specific
  bug along the way: src/server/bindings/kex.ts's `local_sound` had been
  wired straight to SV_StartSound (the PVS/PHS BROADCAST sound path), so a
  "private" cue (pickup jingle, low-ammo warning) was reaching every client
  in the emitting entity's PVS, not just its intended `target`. Fixed by
  adding a real PF_LocalSound (src/server/sv_game.ts, modeled on q2repro's
  PF_LocalSound, server/game.c:638-673) that unicasts to `target` alone.
  This file's first describe block is the regression coverage for that fix;
  it also happens to be exactly the guarantee splitscreen dupe_key would
  otherwise be protecting (one client's private cues never reaching another
  client), so it satisfies this unit's "unicast/local_sound don't
  cross-contaminate across multiple clients" brief directly.

  ClientUserinfoChanged's "split-suffixed userinfo keys" (this unit's brief)
  were independently investigated here too, before finding p_client.ts
  already carries this exact finding as a documented DEVIATION (its own
  "DEVIATION: split-screen suffixed userinfo keys -- not present in the
  cited source" comment, p_client.ts:196-209): grepping
  ~/Projects/quake2-rerelease-dll/rerelease/p_client.cpp for
  "split"/"splitscreen" turns up zero matches. ClientUserinfoChanged reads
  plain, unsuffixed keys only. This file's userinfo describe block is an
  executable regression test for that already-documented finding.

Self-sufficient per .orch/preferences.md rule 13: every global this suite
reads is initialized here; run alone with `bun test test/splitscreen.test.ts`.

Scope (11 cases):
  - local_sound (src/server/sv_game.ts's new PF_LocalSound, wired from
    src/server/bindings/kex.ts): unicasts only to `target`, one other
    connected client's buffers stay untouched (4 cases: cross-contamination,
    no SND_POS ever sent, sendchan encodes TARGET's edict number not the
    source entity's, CHAN_RELIABLE routes to the reliable buffer).
  - dupe_key on local_sound/unicast: accepted, never deduplicated -- matches
    q2repro's own PF_Unicast/PF_LocalSound ignoring the same parameter (2
    cases).
  - unicast (PF_Unicast, pre-existing): delivers to the addressed client
    only (1 case).
  - two real ClientT frame deltas (SV_WriteFrameToClient/VANILLA_CODEC):
    distinct playerstates for two clients never bleed into each other's
    written bytes or ring-buffer slot (1 case).
  - ClientUserinfoChanged: a split-suffixed key ("name_1") is inert; the
    plain "name" key wins (1 case).
  - ClientChooseSlot (cinematic bypass -> ClientChooseSlot_Any): two
    successive callers land on two DISTINCT edict slots, never the same one
    -- this is literally how a PC engine gets "multiple players" (1 case).
  - Coop instanced items across two clients (Touch_Item/
    Entity_IsVisibleToPlayer, src/kexgame/g_items.ts): first player's pickup
    doesn't remove the item or mark it picked up for the second player, who
    can independently pick it up too (1 case).
*/

import { describe, test, expect } from "bun:test";
import { vec3 } from "../src/shared/math";
import { EntityStateT, PlayerStateT, CplaneT, CvarT, CHAN_RELIABLE, Info_ValueForKey as SharedInfoValueForKey } from "../src/shared/q_shared";
import { SvcOpsT, UPDATE_MASK } from "../src/qcommon/qcommon";
import { SizeBuf, SZ_Init } from "../src/qcommon/sizebuf";
import { VANILLA_CODEC } from "../src/qcommon/protocol/vanilla";
import { ClientT, sv, svs, ClientStateT, maxclients } from "../src/server/server";
import { SV_Init } from "../src/server/sv_main";
import { SV_WriteFrameToClient } from "../src/server/sv_ents";
import { SND_ENT, SND_POS } from "../src/server/sv_send";
import { BuildKexImports, adaptKexGameExports } from "../src/server/bindings/kex";
import type { KexGameImports, KexGameExports, KexEdictT, KexTraceT, KexPlayerStateT, KexPmoveStateT, KexUsercmdT } from "../src/kexapi/game";
import { GAME_API_VERSION as KEX_GAME_API_VERSION, MAX_STATS, MAX_CLIENTS, SolidT, SvflagsT } from "../src/kexapi/game";
import { type EdictT, ItemIdT, MovetypeT } from "../src/kexgame/g_local";
import { defaultEdict, gi, globals, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { Gtime_from_ms } from "../src/kexgame/gtime";
import { GetItemByIndex, Touch_Item, Entity_IsVisibleToPlayer } from "../src/kexgame/g_items";
import { defaultGClient, ClientUserinfoChanged, ClientChooseSlot } from "../src/kexgame/p_client";

// =============================================================================
// Server-layer fixtures (ClientT / kex binding), for the local_sound/unicast/
// frame-delta describe blocks
// =============================================================================

SV_Init();
if (!maxclients) throw new Error("splitscreen.test.ts: SV_Init did not register maxclients");
maxclients.value = 3; // slots 1,2 used as two connected clients; 0 stays world

// sv.multicast defaults to an unconfigured SizeBuf (data: new Uint8Array(0),
// maxsize: 0) until SZ_Init gives it a real backing buffer -- PF_Unicast/
// PF_LocalSound both stage their payload through it, matching
// test/server_core.test.ts's own "SV_Multicast" describe block setup.
function resetMulticast(): void {
  SZ_Init(sv.multicast, sv.multicast_buf, sv.multicast_buf.length);
  sv.multicast.allowoverflow = true;
}

function makeServerClient(state: ClientStateT): ClientT {
  const cl = new ClientT();
  cl.state = state;
  SZ_Init(cl.datagram, cl.datagram_buf, cl.datagram_buf.length);
  cl.datagram.allowoverflow = true;
  SZ_Init(cl.netchan.message, cl.netchan.message_buf, cl.netchan.message_buf.length);
  cl.netchan.message.allowoverflow = true;
  return cl;
}

function fakeKexEdict(number: number): KexEdictT {
  const e = defaultEdict();
  e.s.number = number;
  e.inuse = true;
  return e;
}

interface KexCallLog {
  calls: string[];
}

function fakeKexGameExportsForBinding(edicts: KexEdictT[]): KexGameExports {
  const log: KexCallLog = { calls: [] };
  return {
    apiversion: KEX_GAME_API_VERSION,
    PreInit: () => log.calls.push("PreInit"),
    Init: () => log.calls.push("Init"),
    Shutdown: () => {},
    SpawnEntities: () => {},
    WriteGameJson: (autosave, out_size) => {
      out_size[0] = 0;
      return String(autosave);
    },
    ReadGameJson: () => {},
    WriteLevelJson: (transition, out_size) => {
      out_size[0] = 0;
      return String(transition);
    },
    ReadLevelJson: () => {},
    CanSave: () => true,
    ClientChooseSlot: () => null,
    ClientConnect: (_ent, userinfo) => {
      userinfo[0] = userinfo[0];
      return true;
    },
    ClientBegin: () => {},
    ClientUserinfoChanged: () => {},
    ClientDisconnect: () => {},
    ClientCommand: () => {},
    ClientThink: () => {},
    RunFrame: () => {},
    PrepFrame: () => {},
    ServerCommand: () => {},
    edicts,
    num_edicts: edicts.length,
    max_edicts: edicts.length,
    server_flags: 0,
    Pmove: () => {},
    GetExtension: () => null,
    Bot_SetWeapon: () => {},
    Bot_TriggerEdict: () => {},
    Bot_UseItem: () => {},
    Bot_GetItemID: () => -1,
    Edict_ForceLookAtPoint: () => {},
    Bot_PickedUpItem: () => false,
    Entity_IsVisibleToPlayer: () => true,
    GetShadowLightData: () => null,
  };
}

/** Wires up the real kex binding (src/server/bindings/kex.ts): builds the
 *  engine<->kex edict bridge via adaptKexGameExports(...).Init() (this is
 *  what allocateEngineViews needs), then returns BuildKexImports()'s real
 *  `gi` (KexGameImports) plus the engine-visible edicts (adapter.edicts) to
 *  address by index -- the same edict-bridge mechanics
 *  test/kexbinding.test.ts's own "edicts getter is index-aligned" case
 *  exercises, reused here to drive local_sound/unicast for real. */
function setupKexBindingWorld(numEdicts: number): { imports: KexGameImports; kexEdicts: readonly KexEdictT[] } {
  const kexEdicts: KexEdictT[] = Array.from({ length: numEdicts }, (_, i) => fakeKexEdict(i));
  const kexGe = fakeKexGameExportsForBinding(kexEdicts);
  const adapter = adaptKexGameExports(kexGe);
  adapter.Init(); // builds the engine<->kex edict bridge BuildKexImports()'s local_sound/unicast resolve through
  const imports = BuildKexImports();
  return { imports, kexEdicts };
}

function readSoundBytes(buf: { data: Uint8Array; cursize: number }): { flags: number; soundindex: number; sendchan: number } | null {
  if (buf.cursize === 0) return null;
  return {
    flags: buf.data[1] ?? 0,
    soundindex: buf.data[2] ?? 0,
    sendchan: (buf.data[3] ?? 0) | ((buf.data[4] ?? 0) << 8),
  };
}

// =============================================================================
// local_sound: unicasts privately to `target` (regression coverage for the
// SV_StartSound broadcast bug this unit fixed; also the splitscreen ruling's
// "one client's private cues never reach another client" guarantee)
// =============================================================================

describe("kex local_sound (PF_LocalSound) -- private per-target delivery, two connected clients", () => {
  function twoClientHarness(): { imports: KexGameImports; world: KexEdictT; player1Kex: KexEdictT; player2Kex: KexEdictT; client1: ClientT; client2: ClientT } {
    resetMulticast();
    const { imports, kexEdicts } = setupKexBindingWorld(3);
    const client1 = makeServerClient(ClientStateT.cs_spawned);
    const client2 = makeServerClient(ClientStateT.cs_spawned);
    svs.clients = [client1, client2];

    const world = kexEdicts[0];
    const player1 = kexEdicts[1];
    const player2 = kexEdicts[2];
    if (!world || !player1 || !player2) throw new Error("test fixture: engine edicts not built");

    return { imports, world, player1Kex: player1, player2Kex: player2, client1, client2 };
  }

  test("delivers only to the addressed target: the other connected client's buffers stay untouched", () => {
    const { imports, world, player1Kex, client1, client2 } = twoClientHarness();

    imports.local_sound(player1Kex, null, world, 3, 5, 1.0, 1.0, 0, 1);

    expect(client1.datagram.cursize).toBeGreaterThan(0);
    expect(client2.datagram.cursize).toBe(0);
    expect(client2.netchan.message.cursize).toBe(0);
  });

  test("never sends SND_POS, even when a non-null origin is passed (matches q2repro's PF_LocalSound, which never reads its origin parameter)", () => {
    const { imports, world, player1Kex, client1 } = twoClientHarness();

    imports.local_sound(player1Kex, vec3(1, 2, 3), world, 3, 5, 1.0, 1.0, 0, 1);

    const sound = readSoundBytes(client1.datagram);
    expect(sound).not.toBeNull();
    expect((sound!.flags & SND_POS) === 0).toBe(true);
    expect((sound!.flags & SND_ENT) !== 0).toBe(true);
  });

  test("encodes the channel-override entity/channel using TARGET's edict number, not the source entity's (q2repro server/game.c:644: entnum = NUM_FOR_EDICT(target))", () => {
    const { imports, world, player2Kex, client2 } = twoClientHarness();

    // target = player2 (edict 2), source "entity" = world (edict 0):
    // sendchan must encode player2's number, never world's.
    imports.local_sound(player2Kex, null, world, 3, 5, 1.0, 1.0, 0, 1);

    const sound = readSoundBytes(client2.datagram);
    expect(sound).not.toBeNull();
    expect(sound!.sendchan).toBe((2 << 3) | (3 & 7));
  });

  test("CHAN_RELIABLE routes the message to the target's reliable buffer, not its datagram, and still only the target", () => {
    const { imports, world, player1Kex, client1, client2 } = twoClientHarness();

    imports.local_sound(player1Kex, null, world, 3 | CHAN_RELIABLE, 5, 1.0, 1.0, 0, 1);

    expect(client1.netchan.message.cursize).toBeGreaterThan(0);
    expect(client1.datagram.cursize).toBe(0);
    expect(client2.netchan.message.cursize).toBe(0);
  });

  test("dupe_key is accepted but never deduplicated: two local_sound calls with the SAME dupe_key both land (q2repro's own PF_LocalSound/PF_Unicast never read dupe_key either)", () => {
    const { imports, world, player1Kex, client1 } = twoClientHarness();

    imports.local_sound(player1Kex, null, world, 3, 5, 1.0, 1.0, 0, 42);
    const firstSize = client1.datagram.cursize;
    expect(firstSize).toBeGreaterThan(0);

    imports.local_sound(player1Kex, null, world, 3, 5, 1.0, 1.0, 0, 42); // same dupe_key
    expect(client1.datagram.cursize).toBe(firstSize * 2); // both deliveries present, nothing suppressed
  });
});

// =============================================================================
// unicast (PF_Unicast, pre-existing): per-client delivery + dupe_key ignored
// =============================================================================

describe("kex unicast (PF_Unicast) -- per-client delivery, dupe_key ignored", () => {
  test("delivers to the addressed client only; the other connected client's buffers stay untouched", () => {
    resetMulticast();
    const { imports, kexEdicts } = setupKexBindingWorld(3);
    const client1 = makeServerClient(ClientStateT.cs_spawned);
    const client2 = makeServerClient(ClientStateT.cs_spawned);
    svs.clients = [client1, client2];
    const player1 = kexEdicts[1];
    if (!player1) throw new Error("test fixture");

    sv.multicast.data[0] = 0x77;
    sv.multicast.cursize = 1;
    imports.unicast(player1, false, 0);

    expect(client1.datagram.cursize).toBe(1);
    expect(client1.datagram.data[0]).toBe(0x77);
    expect(client2.datagram.cursize).toBe(0);
  });

  test("dupe_key is accepted but never deduplicated: two unicast calls with the same dupe_key both deliver", () => {
    resetMulticast();
    const { imports, kexEdicts } = setupKexBindingWorld(3);
    const client1 = makeServerClient(ClientStateT.cs_spawned);
    svs.clients = [client1];
    const player1 = kexEdicts[1];
    if (!player1) throw new Error("test fixture");

    sv.multicast.data[0] = 0x11;
    sv.multicast.cursize = 1;
    imports.unicast(player1, false, 5);

    sv.multicast.data[0] = 0x22;
    sv.multicast.cursize = 1;
    imports.unicast(player1, false, 5); // same dupe_key as above

    expect(client1.datagram.cursize).toBe(2);
    expect(client1.datagram.data[0]).toBe(0x11);
    expect(client1.datagram.data[1]).toBe(0x22);
  });
});

// =============================================================================
// Two real ClientT frame deltas never cross-contaminate (SV_WriteFrameToClient
// / VANILLA_CODEC), extending the "fabricated client" technique
// test/protocol_frame_envelope.test.ts's own E2E describe block established
// =============================================================================

describe("SV_WriteFrameToClient -- two independently-fabricated clients", () => {
  test("distinct per-client playerstates are written to distinct buffers without bleeding into each other's frame slot or bytes", () => {
    const savedCodec = svs.codec;
    const savedFramenum = sv.framenum;
    try {
      svs.codec = VANILLA_CODEC;

      const clientA = new ClientT();
      const clientB = new ClientT();

      sv.framenum = 1;
      const frameA = clientA.frames[sv.framenum & UPDATE_MASK];
      frameA.ps = new PlayerStateT();
      frameA.ps.pmove.origin.set([100, 0, 0]);
      frameA.ps.stats[0] = 25; // stand-in for "player A's own HUD/inventory state"
      frameA.areabytes = 0;
      frameA.num_entities = 0;
      frameA.first_entity = 0;

      const frameB = clientB.frames[sv.framenum & UPDATE_MASK];
      frameB.ps = new PlayerStateT();
      frameB.ps.pmove.origin.set([-100, 0, 0]);
      frameB.ps.stats[0] = 99; // different from A's -- must never be seen in A's output
      frameB.areabytes = 0;
      frameB.num_entities = 0;
      frameB.first_entity = 0;

      const msgA = new SizeBuf();
      SZ_Init(msgA, new Uint8Array(1024), 1024);
      const msgB = new SizeBuf();
      SZ_Init(msgB, new Uint8Array(1024), 1024);

      SV_WriteFrameToClient(clientA, msgA);
      SV_WriteFrameToClient(clientB, msgB);

      const bytesA = Array.from(msgA.data.subarray(0, msgA.cursize));
      const bytesB = Array.from(msgB.data.subarray(0, msgB.cursize));

      expect(bytesA).not.toEqual(bytesB); // separate content -- no shared mutable state
      expect(bytesA[0]).toBe(SvcOpsT.svc_frame); // sanity: both are real frame packets
      expect(bytesB[0]).toBe(SvcOpsT.svc_frame);

      // each client's OWN ring-buffer slot holds only its own snapshot,
      // untouched by writing the other client's frame afterwards
      expect(Array.from(clientA.frames[1].ps!.pmove.origin)).toEqual([100, 0, 0]);
      expect(Array.from(clientB.frames[1].ps!.pmove.origin)).toEqual([-100, 0, 0]);
    } finally {
      svs.codec = savedCodec;
      sv.framenum = savedFramenum;
    }
  });
});

// =============================================================================
// kexgame-layer fixture (ClientUserinfoChanged / ClientChooseSlot /
// Touch_Item), modeled on test/kexgame_coop_items.test.ts's own
// setupWorld()/makeFakeGameImports()/makeFakeGameExports() convention (no
// shared, importable factory exists for these -- see that file's header)
// =============================================================================

const missTrace: KexTraceT = {
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

interface Recorder {
  cvars: Map<string, CvarT>;
}

function makeRecorder(): Recorder {
  return { cvars: new Map() };
}

function makePmoveState(): KexPmoveStateT {
  return { pm_type: 0, origin: vec3(), velocity: vec3(), pm_flags: 0, pm_time: 0, gravity: 0, delta_angles: vec3(), viewheight: 0 };
}

function makePlayerState(): KexPlayerStateT {
  return {
    pmove: makePmoveState(),
    viewangles: vec3(),
    viewoffset: vec3(),
    kick_angles: vec3(),
    gunangles: vec3(),
    gunoffset: vec3(),
    gunindex: 0,
    gunskin: 0,
    gunframe: 0,
    gunrate: 0,
    screen_blend: new Float32Array(4),
    damage_blend: new Float32Array(4),
    fov: 90,
    rdflags: 0,
    stats: new Int16Array(MAX_STATS),
    team_id: 0,
  };
}
void makePlayerState; // kept for symmetry with defaultGClient's own ps shape; unused directly (defaultGClient builds its own)

function makeFakeKexGameImports(rec: Recorder): KexGameImports {
  function getCvar(name: string, value: string): CvarT {
    let c = rec.cvars.get(name);
    if (c === undefined) {
      c = new CvarT();
      c.name = name;
      c.string = value;
      c.value = Number(value);
      rec.cvars.set(name, c);
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
    trace() {
      return missTrace;
    },
    clip() {
      return missTrace;
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
    // Real Info_ValueForKey (not a stub): the userinfo-suffix test needs
    // genuine key parsing, matching src/server/bindings/kex.ts's own
    // Info_ValueForKey box adapter (kex.ts:924-929).
    Info_ValueForKey(s, key, buffer, buffer_len) {
      const value = SharedInfoValueForKey(s, key);
      const truncated = value.length > buffer_len ? value.slice(0, buffer_len) : value;
      buffer[0] = truncated;
      return truncated.length;
    },
    Info_RemoveKey() {
      return false;
    },
    Info_SetValueForKey() {
      return false;
    },
  };
}

function makeFakeKexGameExports(edicts: EdictT[], numEdicts: number): KexGameExports {
  return {
    apiversion: KEX_GAME_API_VERSION,
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

/** Preallocates `maxentities` blank edicts and wires up gi/globals/g_edicts/game/level. */
function setupKexgameWorld(maxclients_: number, maxentities: number): { edicts: EdictT[]; rec: Recorder } {
  const edicts: EdictT[] = [];
  for (let i = 0; i < maxentities; i++) {
    const e = defaultEdict();
    e.s.number = i;
    edicts.push(e);
  }
  SetGEdicts(edicts);
  game.maxclients = maxclients_;
  game.maxentities = maxentities;
  level.time = Gtime_from_ms(0);

  const rec = makeRecorder();
  SetGameImports(makeFakeKexGameImports(rec));
  SetGameExports(makeFakeKexGameExports(edicts, maxentities));
  globals.num_edicts = maxentities;

  return { edicts, rec };
}

function makePlayerEdict(edicts: EdictT[], index: number): EdictT {
  const e = edicts[index]!;
  e.inuse = true;
  e.classname = "player";
  e.health = 100;
  e.max_health = 100;
  e.movetype = MovetypeT.MOVETYPE_WALK;
  e.solid = SolidT.SOLID_BBOX;
  e.client = defaultGClient();
  return e;
}

function makeItemEdict(edicts: EdictT[], index: number, itemId: ItemIdT): EdictT {
  const e = edicts[index]!;
  e.inuse = true;
  const item = GetItemByIndex(itemId);
  if (item === null) throw new Error(`test fixture: bad itemId ${itemId}`);
  e.item = item;
  e.classname = item.classname;
  return e;
}

void MAX_CLIENTS; // referenced only for the module-load compile-time proof that the import resolves

// =============================================================================
// ClientUserinfoChanged: no split-suffixed userinfo convention exists
// =============================================================================

describe("ClientUserinfoChanged -- split-suffixed userinfo keys are inert", () => {
  test("a name_1/skin_1 suffixed pair (as a console-splitscreen client might send) never overrides the plain name/skin keys", () => {
    const { edicts } = setupKexgameWorld(2, 4);
    const player = makePlayerEdict(edicts, 1);
    // ClientUserinfoChanged unconditionally overwrites pers.netname with
    // G_EncodedPlayerName(ent) (p_client.ts:2618-2620, "##P<lobbyusernum>")
    // for real (non-bot) players -- faithful kex behavior, unrelated to this
    // test. Marking the fixture a bot skips that overwrite so the assertion
    // below observes the actual Info_ValueForKey("name", ...) parse result.
    player.svflags |= SvflagsT.SVF_BOT;

    const userinfo = "\\name\\Player1\\name_1\\SplitGhost\\skin\\male/grunt\\skin_1\\female/athena";
    ClientUserinfoChanged(player, userinfo);

    expect(player.client!.pers.netname).toBe("Player1");
    expect(player.client!.pers.netname).not.toBe("SplitGhost");
  });
});

// =============================================================================
// ClientChooseSlot: two connecting clients land on distinct slots (this is
// how a PC engine gets "multiple players" -- distinct network clients, not
// shared-connection splitscreen)
// =============================================================================

describe("ClientChooseSlot (cinematic bypass -> ClientChooseSlot_Any)", () => {
  test("two successive connecting clients are assigned two distinct edict slots", () => {
    const { edicts } = setupKexgameWorld(2, 4);
    edicts[1]!.client = defaultGClient();
    edicts[2]!.client = defaultGClient();

    const first = ClientChooseSlot("\\name\\PlayerOne", "sid1", false, [], true);
    expect(first).not.toBeNull();
    expect(first).toBe(edicts[1]);
    first!.client!.pers.connected = true; // simulate the slot now being occupied

    const second = ClientChooseSlot("\\name\\PlayerTwo", "sid2", false, [], true);
    expect(second).not.toBeNull();
    expect(second).toBe(edicts[2]);
    expect(second).not.toBe(first);
  });
});

// =============================================================================
// Coop instanced items across two clients (separate visibility/pickup state)
// =============================================================================

describe("Touch_Item across two clients -- instanced-item separation", () => {
  test("player1's pickup does not remove the item or mark it picked-up-by player2; player2 independently picks it up too", () => {
    const { edicts, rec } = setupKexgameWorld(2, 8);
    rec.cvars.set("coop", Object.assign(new CvarT(), { name: "coop", string: "1", value: 1 }));
    rec.cvars.set("g_coop_instanced_items", Object.assign(new CvarT(), { name: "g_coop_instanced_items", string: "1", value: 1 }));
    rec.cvars.set("g_coop_squad_respawn", Object.assign(new CvarT(), { name: "g_coop_squad_respawn", string: "0", value: 0 }));

    const item = makeItemEdict(edicts, 3, ItemIdT.IT_HEALTH_SMALL); // HEALTH_IGNORE_MAX -- pickup always succeeds
    const player1 = makePlayerEdict(edicts, 1);
    const player2 = makePlayerEdict(edicts, 2);

    Touch_Item(item, player1, missTrace, false);

    expect(item.item_picked_up_by[player1.s.number - 1]).toBe(true);
    expect(item.item_picked_up_by[player2.s.number - 1]).toBe(false); // player2's own view of the item is untouched
    expect(item.inuse).toBe(true); // stays in the world for player2
    expect(Entity_IsVisibleToPlayer(item, player2)).toBe(true);
    expect(player1.health).toBe(102);
    expect(player2.health).toBe(100); // unaffected by player1's pickup

    Touch_Item(item, player2, missTrace, false);

    expect(item.item_picked_up_by[player2.s.number - 1]).toBe(true);
    expect(player2.health).toBe(102); // player2 got their own copy of the pickup
    expect(gi).toBeDefined(); // gi/game/level wiring above actually took effect (module-load sanity)
  });
});
