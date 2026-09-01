/*
LOCAL SPLITSCREEN -- SERVER-TO-SEAT MESSAGES, per-seat view height, and the
seat count a server can actually hold.

Sibling of test/splitscreen_seats.test.ts (viewports, usercmds, HUD rects,
seat lifecycle), covering the three behaviors that were still broken after
that feature landed:

  1. A seat's own server messages were written into its buffers and then
     thrown away by the per-frame drain, so its centerprints never reached its
     pane and its private sounds never played. sv_seats.ts now CAPTURES every
     write (SizeBuf.observer, one entry per write, classified against what the
     primary connection was sent) and cl_seats.ts decodes it into the owning
     seat.
  2. The re-release 100ms crouch/stand eye-height ease was driven by
     cl.current_viewheight/cl.viewheight_change_time -- seat 0's singletons --
     so a seat's crouch snapped. Each seat now carries its own lerp state.
  3. `cl_seats 2` from the console or the command line against a default
     single-player launch found maxclients forced to 1 (sv_init.ts) and fell
     back to one seat, re-attempting (and re-printing) every frame. The seat
     code now applies PerformLaunch's own widening rule and reports once.

Self-sufficient per .orch/preferences.md rule 13: every describe block brings
up the globals it reads (SV_Init + maxclients, a fake game module, svs.clients,
sv.state, viddef, `re`, the screen cvars) in its own beforeEach and puts them
back in afterEach.
*/

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import { SZ_Init, SZ_Write, MSG_WriteByte, MSG_WriteShort, MSG_WriteString } from "../src/qcommon/sizebuf";
import { SvcOpsT } from "../src/qcommon/qcommon";
import { PrintTypeT } from "../src/kexapi/game";
import { PRINT_HIGH, CVAR_SERVERINFO, CVAR_LATCH, UsercmdT } from "../src/shared/q_shared";
import { Cvar_FullSet, Cvar_ForceSet, Cvar_VariableValue } from "../src/qcommon/cvar";
import { SV_Init } from "../src/server/sv_main";
import { sv, svs, ServerStateT, ClientStateT, ClientT } from "../src/server/server";
import { geHolder } from "../src/server/sv_game";
import type { GameExports, Edict } from "../src/game/game";
import {
  SV_AddLocalSeat,
  SV_RemoveLocalSeats,
  SV_NumLocalSeats,
  SV_LocalSeatClient,
  SV_TakeLocalSeatMessages,
  SV_ClearLocalSeatsForTests,
  SV_CloseLocalSeatCaptureWindowForTests,
} from "../src/server/sv_seats";
import {
  CL_Seat_ViewHeight,
  CL_Seat_ResetViewHeight,
  CL_Seats_Init,
  CL_Seats_Reconcile,
  CL_Seats_Count,
  CL_Seats_DrainServerMessages,
  CL_Seats_InputStateForTests,
  CL_Seats_MessageStatsForTests,
  CL_Seats_ResetMessageStatsForTests,
  CL_Seats_SetActiveForTests,
  CL_Seats_Shutdown,
  CL_Seats_WidenServerCvars,
} from "../src/client/cl_seats";
import { SCR_Init, SCR_ClearCenterPrint, SCR_CheckDrawCenterStringSeat, SCR_CenterPrintSeat } from "../src/client/cl_scrn";
import { cls, setRe, ConnstateT } from "../src/client/client";
import { viddef } from "../src/client/vid";
import type { RefExports, ImageS, DrawColorT } from "../src/client/ref";

// ---------------------------------------------------------------------------
// SHARED FIXTURES
// ---------------------------------------------------------------------------

// The client decodes with the same flag bits the server writes (sv_send.ts's
// SND_*), restated here so this suite pins the byte layout rather than
// importing the constant it is checking.
const SVC_SOUND_VOLUME = 1 << 0;
const SVC_SOUND_ATTENUATION = 1 << 1;
const SVC_SOUND_POS = 1 << 2;
const SVC_SOUND_ENT_FLAG = 1 << 3;
const SVC_SOUND_OFFSET = 1 << 4;


interface FakeGClient {
  ps: {
    pmove: { origin: Int16Array; viewheight: number; delta_angles: Int16Array };
    viewoffset: Float32Array;
    viewangles: Float32Array;
  };
}

function makeFakeEdict(number: number): Edict & { client: FakeGClient } {
  const client: FakeGClient = {
    ps: {
      pmove: { origin: new Int16Array(3), viewheight: 22, delta_angles: new Int16Array(3) },
      viewoffset: new Float32Array(3),
      viewangles: new Float32Array(3),
    },
  };
  const ent = { s: { number }, client, inuse: false, svflags: 0, areanum: 0, areanum2: 0 };
  // Same narrow shape test/splitscreen_seats.test.ts documents: the seat code
  // only reads .client.ps and hands the edict straight back to the game.
  return ent as unknown as Edict & { client: FakeGClient };
}

function makeSeatGameExports(edicts: (Edict & { client: FakeGClient })[]): GameExports {
  return {
    apiversion: 3,
    Init() {},
    Shutdown() {},
    SpawnEntities() {},
    WriteGame() {},
    ReadGame() {},
    WriteLevel() {},
    ReadLevel() {},
    ClientConnect(_ent: Edict, userinfo: string) {
      return { allowed: true, userinfo };
    },
    ClientBegin() {},
    ClientUserinfoChanged() {},
    ClientDisconnect() {},
    ClientCommand() {},
    ClientThink(_ent: Edict, _cmd: UsercmdT) {},
    RunFrame() {},
    ServerCommand() {},
    edicts,
    num_edicts: edicts.length,
    max_edicts: edicts.length,
  };
}

interface DrawnChar {
  x: number;
  y: number;
  c: number;
}

function makeFakeRe(): RefExports & { drawn: DrawnChar[] } {
  const fake = {
    drawn: [] as DrawnChar[],
    api_version: 3,
    Init: () => true,
    Shutdown: () => undefined,
    BeginRegistration: () => undefined,
    RegisterModel: () => null,
    RegisterSkin: () => null,
    RegisterPic: (): ImageS | null => null,
    RegisterRawPic: (): ImageS | null => null,
    SetSky: () => undefined,
    EndRegistration: () => undefined,
    RenderFrame: () => undefined,
    SupportsPerPixelLighting: () => false,
    DrawGetPicSize: () => ({ w: 0, h: 0 }),
    DrawPic: () => undefined,
    DrawStretchPic: () => undefined,
    DrawColorPic: (_x: number, _y: number, _w: number, _h: number, _name: string, _color: DrawColorT) => undefined,
    DrawStretchPicRegion: (_x: number, _y: number, _w: number, _h: number, _name: string, _sx: number, _sy: number, _sw: number, _sh: number, _color: DrawColorT) => undefined,
    DrawChar(x: number, y: number, c: number) {
      fake.drawn.push({ x, y, c });
    },
    DrawTileClear: () => undefined,
    DrawFill: () => undefined,
    DrawFadeScreen: () => undefined,
    DrawStretchRaw: () => undefined,
    CinematicSetPalette: () => undefined,
    SetGifBeatSeconds: () => undefined,
    BeginFrame: () => undefined,
    EndFrame: () => undefined,
    AppActivate: () => undefined,
  };
  return fake;
}

/** The primary connection's client slot, with the message buffers
 *  Netchan_Setup would have given it on a real connect -- a fresh ClientT's
 *  are zero-length, and SZ_Write on one throws rather than recording. */
function primaryClient(): ClientT {
  const primary = svs.clients.find((c) => !c.isLocalSeat);
  if (!primary) throw new Error("no primary client slot");
  SZ_Init(primary.netchan.message, primary.netchan.message_buf, primary.netchan.message_buf.length);
  SZ_Init(primary.datagram, primary.datagram_buf, primary.datagram_buf.length);
  primary.state = ClientStateT.cs_spawned;
  return primary;
}

/** Printable text of everything drawn, minus the blinking type-out cursor
 *  (glyph 10 or 11) cl_scrn.ts appends to the line being revealed. */
function drawnText(drawn: DrawnChar[]): string {
  return drawn
    .filter((d) => d.c !== 10 && d.c !== 11)
    .map((d) => String.fromCharCode(d.c))
    .join("");
}

// ---------------------------------------------------------------------------
// 1. SERVER-SIDE CAPTURE AND SHARED/PRIVATE CLASSIFICATION
// ---------------------------------------------------------------------------

describe("sv_seats -- capturing what the server writes to a seat", () => {
  let savedGe: GameExports | null = null;
  let savedState = ServerStateT.ss_dead;

  beforeEach(() => {
    Cvar_FullSet("maxclients", "8", CVAR_SERVERINFO | CVAR_LATCH);
    SV_Init();
    Cvar_FullSet("maxclients", "8", CVAR_SERVERINFO | CVAR_LATCH);

    savedGe = geHolder.ge;
    savedState = sv.state;
    geHolder.ge = makeSeatGameExports(Array.from({ length: 9 }, (_, i) => makeFakeEdict(i)));
    svs.clients = Array.from({ length: 8 }, () => new ClientT());
    sv.state = ServerStateT.ss_game;
    SV_ClearLocalSeatsForTests();
  });

  afterEach(() => {
    SV_RemoveLocalSeats();
    SV_ClearLocalSeatsForTests();
    for (const c of svs.clients) c.clear();
    geHolder.ge = savedGe;
    sv.state = savedState;
  });

  test("a seat's reliable writes survive the frame drain instead of being thrown away", () => {
    expect(SV_AddLocalSeat("\\name\\Player 2")).toBe(0);
    const client = SV_LocalSeatClient(0);
    expect(client).not.toBeNull();
    if (!client) return;

    MSG_WriteByte(client.netchan.message, SvcOpsT.svc_centerprint);
    MSG_WriteString(client.netchan.message, "HOLD THIS POSITION");

    SV_CloseLocalSeatCaptureWindowForTests();

    const chunks = SV_TakeLocalSeatMessages(0);
    expect(chunks.length).toBeGreaterThan(0);

    const bytes = chunks.flatMap((c) => Array.from(c.bytes));
    expect(bytes[0]).toBe(SvcOpsT.svc_centerprint);
    expect(String.fromCharCode(...bytes.slice(1, -1))).toBe("HOLD THIS POSITION");
    // Nobody else was sent these bytes, so none of them is a duplicate of the
    // primary connection's traffic.
    expect(chunks.some((c) => c.shared)).toBe(false);
  });

  test("taking the messages clears them -- a message is delivered once, not every frame", () => {
    SV_AddLocalSeat("\\name\\Player 2");
    const client = SV_LocalSeatClient(0);
    if (!client) throw new Error("seat client missing");

    MSG_WriteByte(client.datagram, SvcOpsT.svc_nop);
    SV_CloseLocalSeatCaptureWindowForTests();

    expect(SV_TakeLocalSeatMessages(0).length).toBe(1);
    expect(SV_TakeLocalSeatMessages(0).length).toBe(0);
  });

  test("both buffers are captured, and the seat's buffers are reset for the next window", () => {
    SV_AddLocalSeat("\\name\\Player 2");
    const client = SV_LocalSeatClient(0);
    if (!client) throw new Error("seat client missing");

    MSG_WriteByte(client.netchan.message, SvcOpsT.svc_centerprint);
    MSG_WriteString(client.netchan.message, "RELIABLE");
    MSG_WriteByte(client.datagram, SvcOpsT.svc_centerprint);
    MSG_WriteString(client.datagram, "UNRELIABLE");

    SV_CloseLocalSeatCaptureWindowForTests();
    const text = SV_TakeLocalSeatMessages(0)
      .map((c) => String.fromCharCode(...Array.from(c.bytes)))
      .join("");
    expect(text).toContain("RELIABLE");
    expect(text).toContain("UNRELIABLE");
  });

  test("a payload the primary connection also got is marked shared; a seat-only payload is not", () => {
    SV_AddLocalSeat("\\name\\Player 2");
    const seat = SV_LocalSeatClient(0);
    if (!seat) throw new Error("seat client missing");
    // The primary connection: an ordinary (non-seat) client slot.
    const primary = primaryClient();

    // SV_Multicast's shape: one SZ_Write of the same payload per recipient.
    const multicast = new Uint8Array([SvcOpsT.svc_sound, 0x08, 12, 0x40, 0x00]);
    SZ_Write(primary.datagram, multicast, multicast.length);
    SZ_Write(seat.datagram, multicast, multicast.length);

    // PF_centerprintf's shape: written to the one client it names.
    const unicast = new Uint8Array([SvcOpsT.svc_sound, 0x08, 13, 0x40, 0x00]);
    SZ_Write(seat.datagram, unicast, unicast.length);

    SV_CloseLocalSeatCaptureWindowForTests();

    const chunks = SV_TakeLocalSeatMessages(0);
    expect(chunks.length).toBe(2);
    expect(chunks[0].shared).toBe(true);
    expect(chunks[1].shared).toBe(false);
  });

  test("removing the seats stops capturing (no observer is left on a buffer that outlives the split)", () => {
    SV_AddLocalSeat("\\name\\Player 2");
    const client = SV_LocalSeatClient(0);
    if (!client) throw new Error("seat client missing");
    SV_RemoveLocalSeats();

    expect(client.netchan.message.observer).toBeNull();
    expect(client.datagram.observer).toBeNull();
    expect(SV_NumLocalSeats()).toBe(0);
    expect(SV_TakeLocalSeatMessages(0).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. CLIENT-SIDE DECODE AND PANE ROUTING
// ---------------------------------------------------------------------------

describe("cl_seats -- decoding a seat's captured messages into its own pane", () => {
  let savedGe: GameExports | null = null;
  let savedState = ServerStateT.ss_dead;
  let fake: RefExports & { drawn: DrawnChar[] };

  function seatClient(): ClientT {
    const client = SV_LocalSeatClient(0);
    if (!client) throw new Error("seat client missing");
    return client;
  }

  /** One server frame's worth of writes, then one client frame's drain. */
  function deliver(): void {
    SV_CloseLocalSeatCaptureWindowForTests();
    CL_Seats_DrainServerMessages();
  }

  beforeEach(() => {
    Cvar_FullSet("maxclients", "8", CVAR_SERVERINFO | CVAR_LATCH);
    SV_Init();
    Cvar_FullSet("maxclients", "8", CVAR_SERVERINFO | CVAR_LATCH);
    SCR_Init();
    Cvar_ForceSet("scr_centertime", "5.0");
    Cvar_ForceSet("scr_printspeed", "0.04");

    savedGe = geHolder.ge;
    savedState = sv.state;
    geHolder.ge = makeSeatGameExports(Array.from({ length: 9 }, (_, i) => makeFakeEdict(i)));
    svs.clients = Array.from({ length: 8 }, () => new ClientT());
    sv.state = ServerStateT.ss_game;
    SV_ClearLocalSeatsForTests();

    cls.clear();
    SCR_ClearCenterPrint();
    CL_Seats_ResetMessageStatsForTests();
    fake = makeFakeRe();
    setRe(fake);
    // 4:3 -- below the 3:2 side-by-side threshold, so two seats stack and
    // seat 1's pane is the BOTTOM half. That makes "which pane did this land
    // in" a plain y-coordinate question.
    viddef.width = 1280;
    viddef.height = 960;

    SV_AddLocalSeat("\\name\\Player 2");
    CL_Seats_SetActiveForTests(2);
  });

  afterEach(() => {
    CL_Seats_SetActiveForTests(1);
    SV_RemoveLocalSeats();
    SV_ClearLocalSeatsForTests();
    for (const c of svs.clients) c.clear();
    geHolder.ge = savedGe;
    sv.state = savedState;
    SCR_ClearCenterPrint();
    setRe(null);
  });

  test("svc_centerprint addressed to the seat is drawn inside the SEAT's pane, not seat 0's", () => {
    const client = seatClient();
    MSG_WriteByte(client.netchan.message, SvcOpsT.svc_centerprint);
    MSG_WriteString(client.netchan.message, "SECOND PLAYER");
    deliver();

    expect(CL_Seats_MessageStatsForTests().centerprints).toBe(1);

    // Seat 0's queue is untouched: only the seat that was addressed shows it.
    fake.drawn = [];
    SCR_CheckDrawCenterStringSeat(0);
    expect(fake.drawn).toHaveLength(0);

    fake.drawn = [];
    SCR_CheckDrawCenterStringSeat(1);
    expect(drawnText(fake.drawn)).toBe("SECOND PLAYER");
    // Two stacked panes on a 960-high display: seat 1 owns y >= 480.
    for (const d of fake.drawn) expect(d.y).toBeGreaterThanOrEqual(480);
  });

  test("seat 0's own centerprint stays in seat 0's pane while a seat's message is up", () => {
    const client = seatClient();
    MSG_WriteByte(client.netchan.message, SvcOpsT.svc_centerprint);
    MSG_WriteString(client.netchan.message, "PLAYER TWO");
    deliver();
    SCR_CenterPrintSeat(0, "PLAYER ONE");

    fake.drawn = [];
    SCR_CheckDrawCenterStringSeat(0);
    expect(drawnText(fake.drawn)).toBe("PLAYER ONE");
    for (const d of fake.drawn) expect(d.y).toBeLessThan(480);

    fake.drawn = [];
    SCR_CheckDrawCenterStringSeat(1);
    expect(drawnText(fake.drawn)).toBe("PLAYER TWO");
    for (const d of fake.drawn) expect(d.y).toBeGreaterThanOrEqual(480);
  });

  test("svc_print at PRINT_CENTER becomes the seat's centerprint (the rerelease's own centerprint carrier)", () => {
    const client = seatClient();
    MSG_WriteByte(client.netchan.message, SvcOpsT.svc_print);
    MSG_WriteByte(client.netchan.message, PrintTypeT.PRINT_CENTER);
    MSG_WriteString(client.netchan.message, "YOU NEED THE BLUE KEY");
    deliver();

    expect(CL_Seats_MessageStatsForTests().centerprints).toBe(1);
    fake.drawn = [];
    SCR_CheckDrawCenterStringSeat(1);
    expect(drawnText(fake.drawn)).toBe("YOU NEED THE BLUE KEY");
  });

  test("an ordinary print that only the seat was sent reaches the console; the same print sent to everyone does not, once per player", () => {
    const client = seatClient();
    const primary = primaryClient();

    // SV_ClientPrintf to this seat alone.
    MSG_WriteByte(client.netchan.message, SvcOpsT.svc_print);
    MSG_WriteByte(client.netchan.message, PRINT_HIGH);
    MSG_WriteString(client.netchan.message, "you got the shotgun\n");

    // SV_BroadcastPrintf: the same three writes to every client.
    for (const target of [primary.netchan.message, client.netchan.message]) {
      MSG_WriteByte(target, SvcOpsT.svc_print);
      MSG_WriteByte(target, PRINT_HIGH);
      MSG_WriteString(target, "Player 1 entered the game\n");
    }

    deliver();

    const stats = CL_Seats_MessageStatsForTests();
    expect(stats.prints).toBe(1);
    expect(stats.printsShared).toBe(1);
  });

  test("a seat-directed sound plays; a multicast the primary connection already played does not play twice", () => {
    const client = seatClient();
    const primary = primaryClient();

    // PF_LocalSound -> PF_Unicast: this seat only.
    const priv = new Uint8Array([SvcOpsT.svc_sound, SVC_SOUND_ENT_FLAG, 21, 0x08, 0x00]);
    SZ_Write(client.datagram, priv, priv.length);

    // SV_StartSound -> SV_Multicast: the same bytes to everyone in the PHS.
    const shared = new Uint8Array([SvcOpsT.svc_sound, SVC_SOUND_ENT_FLAG, 22, 0x10, 0x00]);
    SZ_Write(primary.datagram, shared, shared.length);
    SZ_Write(client.datagram, shared, shared.length);

    deliver();

    const stats = CL_Seats_MessageStatsForTests();
    expect(stats.sounds).toBe(1);
    expect(stats.soundsShared).toBe(1);
  });

  test("a write whose length the decoder does not know costs that write and nothing more", () => {
    const client = seatClient();

    // svc_temp_entity's payload length is a per-type table this decoder does
    // not carry -- written the way SV_Multicast delivers it, as one write.
    const tempEntity = new Uint8Array([SvcOpsT.svc_temp_entity, 3, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
    SZ_Write(client.datagram, tempEntity, tempEntity.length);

    // ...and a centerprint after it, in its own write, as PF_Unicast delivers.
    MSG_WriteByte(client.netchan.message, SvcOpsT.svc_centerprint);
    MSG_WriteString(client.netchan.message, "STILL DELIVERED");

    deliver();

    const stats = CL_Seats_MessageStatsForTests();
    expect(stats.skipped).toBe(1);
    expect(stats.centerprints).toBe(1);
    fake.drawn = [];
    SCR_CheckDrawCenterStringSeat(1);
    expect(drawnText(fake.drawn)).toBe("STILL DELIVERED");
  });

  test("known-length messages the seat does not act on are stepped over exactly, so what follows in the same write still decodes", () => {
    const client = seatClient();
    const buf = client.netchan.message;

    MSG_WriteByte(buf, SvcOpsT.svc_stufftext);
    MSG_WriteString(buf, "precache\n");
    MSG_WriteByte(buf, SvcOpsT.svc_layout);
    MSG_WriteString(buf, "xv 0 yv 0 string \"hi\"");
    MSG_WriteByte(buf, SvcOpsT.svc_configstring);
    MSG_WriteShort(buf, 42);
    MSG_WriteString(buf, "models/monsters/soldier/tris.md2");
    MSG_WriteByte(buf, SvcOpsT.svc_muzzleflash);
    MSG_WriteShort(buf, 3);
    MSG_WriteByte(buf, 1);
    MSG_WriteByte(buf, SvcOpsT.svc_centerprint);
    MSG_WriteString(buf, "AFTER THE SKIPS");

    deliver();

    const stats = CL_Seats_MessageStatsForTests();
    expect(stats.skipped).toBe(0);
    expect(stats.centerprints).toBe(1);
    fake.drawn = [];
    SCR_CheckDrawCenterStringSeat(1);
    expect(drawnText(fake.drawn)).toBe("AFTER THE SKIPS");
  });

  test("every svc_sound flag combination is stepped over at exactly its own length", () => {
    const client = seatClient();
    const primary = primaryClient();

    // flags -> payload bytes after the flags byte itself: soundindex, then
    // volume/attenuation/offset bytes, the entity short, the position vector.
    const cases: { flags: number; extra: number[] }[] = [
      { flags: 0, extra: [] },
      { flags: SVC_SOUND_VOLUME, extra: [200] },
      { flags: SVC_SOUND_ATTENUATION, extra: [64] },
      { flags: SVC_SOUND_OFFSET, extra: [10] },
      { flags: SVC_SOUND_ENT_FLAG, extra: [0x08, 0x00] },
      { flags: SVC_SOUND_POS, extra: [1, 0, 2, 0, 3, 0] },
      { flags: SVC_SOUND_VOLUME | SVC_SOUND_ATTENUATION | SVC_SOUND_OFFSET | SVC_SOUND_ENT_FLAG | SVC_SOUND_POS, extra: [200, 64, 10, 0x08, 0x00, 1, 0, 2, 0, 3, 0] },
    ];

    for (const { flags, extra } of cases) {
      // Marked shared (also written to the primary) so the decoder steps over
      // it by computed length rather than by decoding it -- which is the path
      // that has to land on the right byte.
      const payload = new Uint8Array([SvcOpsT.svc_sound, flags, 7, ...extra]);
      SZ_Write(primary.datagram, payload, payload.length);
      SZ_Write(client.datagram, payload, payload.length);
      MSG_WriteByte(client.datagram, SvcOpsT.svc_nop);
    }

    deliver();

    const stats = CL_Seats_MessageStatsForTests();
    expect(stats.soundsShared).toBe(cases.length);
    expect(stats.skipped).toBe(0);
  });

  test("nothing is decoded for a seat that is not active", () => {
    const client = seatClient();
    MSG_WriteByte(client.netchan.message, SvcOpsT.svc_centerprint);
    MSG_WriteString(client.netchan.message, "NOBODY IS SITTING HERE");

    CL_Seats_SetActiveForTests(1);
    deliver();

    expect(CL_Seats_MessageStatsForTests().centerprints).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. PER-SEAT CROUCH/STAND EYE-HEIGHT EASE
// ---------------------------------------------------------------------------

describe("CL_Seat_ViewHeight -- each seat eases its own crouch", () => {
  afterEach(() => {
    CL_Seats_Shutdown();
  });

  test("a change eases over 100ms instead of snapping", () => {
    // Standing at 22 since the seat spawned (what CL_Seats_Reconcile does for
    // a fresh seat).
    CL_Seat_ResetViewHeight(1, 22);
    expect(CL_Seat_ViewHeight(1, 22, 0)).toBeCloseTo(22, 5);

    // Crouch: the new height is only reached 100ms later, and the value at
    // the moment of the change is still the OLD one.
    expect(CL_Seat_ViewHeight(1, 4, 1000)).toBeCloseTo(22, 5);
    expect(CL_Seat_ViewHeight(1, 4, 1050)).toBeCloseTo(13, 5); // halfway
    expect(CL_Seat_ViewHeight(1, 4, 1100)).toBeCloseTo(4, 5);
    expect(CL_Seat_ViewHeight(1, 4, 1500)).toBeCloseTo(4, 5); // clamped, not overshooting
  });

  test("the ease is the same arithmetic the primary client uses (q2repro entities.c:1605-1609)", () => {
    CL_Seat_ResetViewHeight(1, 22);
    CL_Seat_ViewHeight(1, 4, 2000);
    for (const dt of [0, 10, 25, 60, 99, 100, 250]) {
      const lerp = 100 - Math.min(dt, 100);
      const expected = 4 + (22 - 4) * lerp * 0.01;
      expect(CL_Seat_ViewHeight(1, 4, 2000 + dt)).toBeCloseTo(expected, 5);
    }
  });

  test("two seats crouch independently -- one seat's transition does not move the other's eye", () => {
    CL_Seat_ResetViewHeight(1, 22);
    CL_Seat_ResetViewHeight(2, 22);

    // Seat 1 crouches at t=1000; seat 2 stays standing.
    CL_Seat_ViewHeight(1, 4, 1000);
    expect(CL_Seat_ViewHeight(2, 22, 1000)).toBeCloseTo(22, 5);
    expect(CL_Seat_ViewHeight(1, 4, 1050)).toBeCloseTo(13, 5);
    expect(CL_Seat_ViewHeight(2, 22, 1050)).toBeCloseTo(22, 5);

    // Seat 2 crouches 500ms later and runs its OWN clock, not seat 1's.
    CL_Seat_ViewHeight(2, 4, 1500);
    expect(CL_Seat_ViewHeight(2, 4, 1550)).toBeCloseTo(13, 5);
    expect(CL_Seat_ViewHeight(1, 4, 1550)).toBeCloseTo(4, 5);
  });

  test("the lerp state lives on the seat's own input/view state, and re-reading the same height in one frame is idempotent", () => {
    CL_Seat_ResetViewHeight(1, 22);
    CL_Seat_ViewHeight(1, 4, 3000);
    const state = CL_Seats_InputStateForTests(1);
    expect(state.current_viewheight).toBe(4);
    expect(state.prev_viewheight).toBe(22);
    expect(state.viewheight_change_time).toBe(3000);

    // A second call in the same frame (a stereo pass) records no new change.
    expect(CL_Seat_ViewHeight(1, 4, 3050)).toBeCloseTo(CL_Seat_ViewHeight(1, 4, 3050), 5);
    expect(state.viewheight_change_time).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// 4. SEAT COUNT vs. WHAT THE SERVER CAN HOLD
// ---------------------------------------------------------------------------

describe("cl_seats N against a server with no room for it", () => {
  let savedGe: GameExports | null = null;
  let savedState = ServerStateT.ss_dead;

  beforeEach(() => {
    Cvar_FullSet("maxclients", "1", CVAR_SERVERINFO | CVAR_LATCH);
    SV_Init();
    Cvar_FullSet("maxclients", "1", CVAR_SERVERINFO | CVAR_LATCH);
    Cvar_ForceSet("coop", "0");
    Cvar_ForceSet("deathmatch", "0");
    Cvar_ForceSet("cl_seats", "1");
    CL_Seats_Init(); // binds the module's own cl_seats/cl_splitscreen_layout handles
    CL_Seats_Shutdown(); // and clears any "already tried" latch a previous case left

    savedGe = geHolder.ge;
    savedState = sv.state;
    geHolder.ge = makeSeatGameExports(Array.from({ length: 9 }, (_, i) => makeFakeEdict(i)));
    sv.state = ServerStateT.ss_game;
    SV_ClearLocalSeatsForTests();
    CL_Seats_SetActiveForTests(1);
  });

  afterEach(() => {
    CL_Seats_SetActiveForTests(1);
    SV_RemoveLocalSeats();
    SV_ClearLocalSeatsForTests();
    for (const c of svs.clients) c.clear();
    geHolder.ge = savedGe;
    sv.state = savedState;
    Cvar_FullSet("maxclients", "8", CVAR_SERVERINFO | CVAR_LATCH);
    Cvar_ForceSet("coop", "0");
    Cvar_ForceSet("deathmatch", "0");
    Cvar_ForceSet("cl_seats", "1");
  });

  test("the widening rule matches PerformLaunch's (menu_content.ts:279-281): coop on, maxclients at least 4, at least the seat count", () => {
    CL_Seats_WidenServerCvars(2);
    expect(Cvar_VariableValue("coop")).toBe(1);
    expect(Cvar_VariableValue("maxclients")).toBeGreaterThanOrEqual(4);

    Cvar_ForceSet("maxclients", "4");
    CL_Seats_WidenServerCvars(6);
    expect(Cvar_VariableValue("maxclients")).toBeGreaterThanOrEqual(6);
  });

  test("a deathmatch server is left alone -- it already seats eight, and coop would change the game being played", () => {
    Cvar_ForceSet("deathmatch", "1");
    Cvar_ForceSet("coop", "0");
    CL_Seats_WidenServerCvars(2);
    expect(Cvar_VariableValue("coop")).toBe(0);
  });

  test("one seat asks for nothing", () => {
    Cvar_ForceSet("coop", "0");
    Cvar_ForceSet("maxclients", "1");
    CL_Seats_WidenServerCvars(1);
    expect(Cvar_VariableValue("coop")).toBe(0);
    expect(Cvar_VariableValue("maxclients")).toBe(1);
  });

  test("`cl_seats 2` on a one-slot server widens the latched cvars and does not retry the failed seating every frame", () => {
    // A single-player server: one client slot, already taken by the primary.
    svs.clients = [new ClientT()];
    svs.clients[0].state = ClientStateT.cs_spawned;
    Cvar_ForceSet("cl_seats", "2");
    // CL_Seats_Reconcile's own gate: the primary connection has to be in the
    // game for a seat to exist at all.
    cls.state = ConnstateT.ca_active;

    CL_Seats_Reconcile();
    expect(CL_Seats_Count()).toBe(1); // no room, so no second seat
    expect(SV_NumLocalSeats()).toBe(0);
    // ...but the next server start will have room.
    expect(Cvar_VariableValue("coop")).toBe(1);
    expect(Cvar_VariableValue("maxclients")).toBeGreaterThanOrEqual(4);

    // The failed attempt is latched off: a second frame must not re-run the
    // teardown/seat/report cycle (which is what made this print every frame).
    const before = svs.clients[0].state;
    CL_Seats_Reconcile();
    CL_Seats_Reconcile();
    expect(svs.clients[0].state).toBe(before);
    expect(CL_Seats_Count()).toBe(1);
  });

  test("with room, the same request seats the second player", () => {
    Cvar_FullSet("maxclients", "4", CVAR_SERVERINFO | CVAR_LATCH);
    svs.clients = Array.from({ length: 4 }, () => new ClientT());
    svs.clients[0].state = ClientStateT.cs_spawned;
    Cvar_ForceSet("cl_seats", "2");
    cls.state = ConnstateT.ca_active;

    CL_Seats_Reconcile();
    expect(SV_NumLocalSeats()).toBe(1);
    expect(CL_Seats_Count()).toBe(2);
  });
});
