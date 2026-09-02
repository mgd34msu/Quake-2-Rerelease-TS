/*
Per-client fog and info_world_text under the CLASSIC module.

Since c88447e a classic-ruleset session on re-release content runs the wide
configstring layout (protocol 4038, cls.csr.extended). That made re-release
presentation reachable, but two channels the re-release uses had no classic
equivalent at all: the svc_fog message trigger_fog and the worldspawn fog_* /
heightfog_* keys publish, and info_world_text's two debug-draw calls. src/game
tracked the fog state correctly and then dropped it on the floor.

Both now go through optional GameImports hooks -- gi.fog(),
gi.draw_oriented_world_text(), gi.draw_static_world_text() -- the same
optional-hook pattern extended_layout()/shadowlight() established, so the
frozen legacy trees (src/ctf, src/rogue, src/xatrix, src/lmctf) need no edit.
src/server/bindings/legacy.ts holds the engine half.

What this file pins:

  1. WIRE VOCABULARY. legacy.ts spells the svc_fog opcode and its 16 bit
     assignments locally rather than importing src/kexapi/game.ts, so that
     neither the binding nor src/game behind it takes a dependency on the kex
     API surface. That is only safe if the two definitions cannot drift, so
     every one of them is compared against kexapi's own constant here.

  2. THE ENCODING. PF_Fog's output is fed straight to
     qcommon/protocol/q2repro.ts's readFog -- the SAME decoder the kex path
     targets, and the one the client actually runs -- and the decoded fields
     are checked against the state that went in. Field order, the
     BIT_MORE_BITS 16-bit-bits escape, the *255 colour scaling and the
     density/skyfactor bit pairing are all covered by that round trip.

  3. THE NARROW GATE. A session still on CS_REMAP_OLD must emit NOTHING.
     Protocol 34 has no svc_fog, and a vanilla client handed that opcode
     would desync. This is the property that keeps 1997 content byte-for-byte
     vanilla, so it is tested for the fog hook and both world-text hooks.

  4. THE TRANSITION LOGIC in src/game/g_kextrig.ts: the converged-state guard
     (p_client.cpp's early return), and how fog_transition_time becomes the
     BIT_TIME value -- truncated to whole milliseconds, suppressed entirely
     when the change is instant or the trigger carries no delay, clamped to
     65535.

  5. RETAIL: every shipped map's fog_* / heightfog_* worldspawn keys parse
     through the classic module's spawn-field table, with the values the
     entity lump actually carries.

Retail-gated the same way the rest of this suite gates: loud skip when the
install is absent, nothing copied into the repository.

NOTE ON WHAT IS NOT TESTED HERE, because it does not exist in this engine:
there is no fog RENDERER. cl_parse.ts's svc_fog case calls readFog() and
discards the result, and src/ref_gl has no fog state, uniform or GL call
anywhere -- only a `gl_fog` cvar registered in gl_rmain.ts. So neither module
draws fog on screen; the gap these hooks close is the emit side only.
Likewise sv_debugdraw.ts's buffer, which both modules' world-text calls now
reach identically, has no consumer. See those files' own headers.
*/

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, openSync, readSync, closeSync } from "node:fs";

import { CS_REMAP_OLD, CS_REMAP_RERELEASE } from "../src/shared/cs_remap";
import { sv, svs } from "../src/server/server";
import { SZ_Clear, SZ_Init, MSG_BeginReading, MSG_ReadByte } from "../src/qcommon/sizebuf";
import { net_message } from "../src/qcommon/net_chan";
import { readFog } from "../src/qcommon/protocol/q2repro";
import { ServerCommandT, SvcFogDataBitsT } from "../src/kexapi/game";
import {
  PF_Fog,
  SVC_FOG,
  FOG_BIT_DENSITY,
  FOG_BIT_R,
  FOG_BIT_G,
  FOG_BIT_B,
  FOG_BIT_TIME,
  FOG_BIT_HEIGHTFOG_FALLOFF,
  FOG_BIT_HEIGHTFOG_DENSITY,
  FOG_BIT_MORE_BITS,
  FOG_BIT_HEIGHTFOG_START_R,
  FOG_BIT_HEIGHTFOG_START_G,
  FOG_BIT_HEIGHTFOG_START_B,
  FOG_BIT_HEIGHTFOG_START_DIST,
  FOG_BIT_HEIGHTFOG_END_R,
  FOG_BIT_HEIGHTFOG_END_G,
  FOG_BIT_HEIGHTFOG_END_B,
  FOG_BIT_HEIGHTFOG_END_DIST,
  PF_DrawOrientedWorldText,
  PF_DrawStaticWorldText,
} from "../src/server/bindings/legacy";
import { SV_DebugDraw_Drain, SV_DebugDraw_Clear } from "../src/server/sv_debugdraw";
import { vec3 } from "../src/shared/math";
import type { Edict, FogStateT } from "../src/game/game";

const RETAIL_BASEDIR = "/home/buzzkill/q2rets/rerelease";
const RETAIL_PAK = `${RETAIL_BASEDIR}/baseq2/pak0.pak`;
const havePak = existsSync(RETAIL_PAK);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ZERO: FogStateT = {
  density: 0,
  r: 0,
  g: 0,
  b: 0,
  sky_factor: 0,
  hf_falloff: 0,
  hf_density: 0,
  hf_start: [0, 0, 0, 0],
  hf_end: [0, 0, 0, 0],
};

function fogState(over: Partial<FogStateT>): FogStateT {
  return { ...ZERO, ...over };
}

/*
A stand-in edict whose s.number is 0, i.e. the world. PF_Unicast's
`if (p < 1 || p > maxclients) return;` bails on it BEFORE the SZ_Clear at the
end of the function, which is precisely what this harness wants: the encoded
bytes stay in sv.multicast where the test can read them, and no netchan or
client array has to exist. The encode path under test runs in full either way
-- PF_Fog has already finished every write by the time it calls unicast.
*/
const worldEdict = { s: { number: 0 } } as unknown as Edict;

let savedCsr: typeof svs.csr;

beforeEach(() => {
  savedCsr = svs.csr;
  // sv.multicast is only sized by SV_SpawnServer, and this file never boots a
  // server -- give it its own backing store so PF_Write* has somewhere to go.
  SZ_Init(sv.multicast, sv.multicast_buf, sv.multicast_buf.length);
  SZ_Clear(sv.multicast);
});

afterEach(() => {
  svs.csr = savedCsr;
  SZ_Clear(sv.multicast);
});

/** Everything PF_Fog wrote this call, as bytes. */
function emitted(): Uint8Array {
  return sv.multicast.data.subarray(0, sv.multicast.cursize).slice();
}

/*
Decode a captured svc_fog packet with the client's own reader.

SZ_Init, not a bare `net_message.data = bytes`: SizeBuf carries a DataView
alongside the byte array and MSG_ReadFloat reads through the VIEW while
MSG_ReadByte reads through the array. Swapping only the array leaves the view
pointed at the previous buffer, which reads bytes correctly and floats as
zero -- exactly the failure this harness hit first time out.
*/
function decode(bytes: Uint8Array): ReturnType<typeof readFog> & { opcode: number } {
  SZ_Init(net_message, bytes, bytes.length);
  net_message.cursize = bytes.length;
  MSG_BeginReading(net_message);
  const opcode = MSG_ReadByte(net_message);
  const fog = readFog();
  return { ...fog, opcode };
}

// ---------------------------------------------------------------------------
// 1. Wire vocabulary -- legacy.ts's local constants vs kexapi's
// ---------------------------------------------------------------------------

describe("svc_fog wire vocabulary stays pinned to the kex API's", () => {
  test("the opcode matches ServerCommandT.svc_fog", () => {
    expect(SVC_FOG).toBe(ServerCommandT.svc_fog);
  });

  test("every bit assignment matches SvcFogDataBitsT", () => {
    expect(FOG_BIT_DENSITY).toBe(SvcFogDataBitsT.BIT_DENSITY);
    expect(FOG_BIT_R).toBe(SvcFogDataBitsT.BIT_R);
    expect(FOG_BIT_G).toBe(SvcFogDataBitsT.BIT_G);
    expect(FOG_BIT_B).toBe(SvcFogDataBitsT.BIT_B);
    expect(FOG_BIT_TIME).toBe(SvcFogDataBitsT.BIT_TIME);
    expect(FOG_BIT_HEIGHTFOG_FALLOFF).toBe(SvcFogDataBitsT.BIT_HEIGHTFOG_FALLOFF);
    expect(FOG_BIT_HEIGHTFOG_DENSITY).toBe(SvcFogDataBitsT.BIT_HEIGHTFOG_DENSITY);
    expect(FOG_BIT_MORE_BITS).toBe(SvcFogDataBitsT.BIT_MORE_BITS);
    expect(FOG_BIT_HEIGHTFOG_START_R).toBe(SvcFogDataBitsT.BIT_HEIGHTFOG_START_R);
    expect(FOG_BIT_HEIGHTFOG_START_G).toBe(SvcFogDataBitsT.BIT_HEIGHTFOG_START_G);
    expect(FOG_BIT_HEIGHTFOG_START_B).toBe(SvcFogDataBitsT.BIT_HEIGHTFOG_START_B);
    expect(FOG_BIT_HEIGHTFOG_START_DIST).toBe(SvcFogDataBitsT.BIT_HEIGHTFOG_START_DIST);
    expect(FOG_BIT_HEIGHTFOG_END_R).toBe(SvcFogDataBitsT.BIT_HEIGHTFOG_END_R);
    expect(FOG_BIT_HEIGHTFOG_END_G).toBe(SvcFogDataBitsT.BIT_HEIGHTFOG_END_G);
    expect(FOG_BIT_HEIGHTFOG_END_B).toBe(SvcFogDataBitsT.BIT_HEIGHTFOG_END_B);
    expect(FOG_BIT_HEIGHTFOG_END_DIST).toBe(SvcFogDataBitsT.BIT_HEIGHTFOG_END_DIST);
  });
});

// ---------------------------------------------------------------------------
// 2. The narrow gate
// ---------------------------------------------------------------------------

describe("a narrow (protocol 34) session emits no fog traffic at all", () => {
  test("PF_Fog writes zero bytes on CS_REMAP_OLD, even for a full state change", () => {
    svs.csr = CS_REMAP_OLD;
    PF_Fog(
      worldEdict,
      ZERO,
      fogState({
        density: 0.024,
        r: 0.5,
        g: 0.25,
        b: 0.75,
        sky_factor: 0.2,
        hf_falloff: 0.0673,
        hf_density: 0.0005,
        hf_start: [0.9, 0.4, 0.1, -328],
        hf_end: [0, 0, 0, -349],
      }),
      500,
    );
    expect(sv.multicast.cursize).toBe(0);
  });

  test("the same state on a wide session does emit", () => {
    svs.csr = CS_REMAP_RERELEASE;
    PF_Fog(worldEdict, ZERO, fogState({ density: 0.024 }), null);
    expect(sv.multicast.cursize).toBeGreaterThan(0);
    expect(emitted()[0]).toBe(SVC_FOG);
  });
});

// ---------------------------------------------------------------------------
// 3. The encoding, round-tripped through the client's own decoder
// ---------------------------------------------------------------------------

describe("PF_Fog's packet decodes back to the state that went in", () => {
  beforeEach(() => {
    svs.csr = CS_REMAP_RERELEASE;
  });

  test("global fog only: density+skyfactor share a bit, colours scale by 255", () => {
    PF_Fog(worldEdict, ZERO, fogState({ density: 0.024, r: 0.4, g: 0.2, b: 0.8, sky_factor: 0.2 }), null);
    const d = decode(emitted());

    expect(d.opcode).toBe(SVC_FOG);
    expect(d.bits & FOG_BIT_DENSITY).toBeTruthy();
    expect(d.bits & FOG_BIT_R).toBeTruthy();
    expect(d.bits & FOG_BIT_G).toBeTruthy();
    expect(d.bits & FOG_BIT_B).toBeTruthy();
    // no height fog changed, so none of the high bits and no escape byte
    expect(d.bits & FOG_BIT_MORE_BITS).toBeFalsy();
    expect(d.bits & FOG_BIT_TIME).toBeFalsy();

    expect(d.density).toBeCloseTo(0.024, 6);
    expect(d.skyfactor).toBe(Math.trunc(0.2 * 255));
    expect(d.red).toBe(Math.trunc(0.4 * 255));
    expect(d.green).toBe(Math.trunc(0.2 * 255));
    expect(d.blue).toBe(Math.trunc(0.8 * 255));
  });

  test("only the fields that actually changed get a bit", () => {
    const current = fogState({ density: 0.024, r: 0.4, g: 0.2, b: 0.8, sky_factor: 0.2 });
    // same everything except green
    PF_Fog(worldEdict, current, { ...current, g: 0.6 }, null);
    const d = decode(emitted());

    expect(d.bits & FOG_BIT_DENSITY).toBeFalsy();
    expect(d.bits & FOG_BIT_R).toBeFalsy();
    expect(d.bits & FOG_BIT_B).toBeFalsy();
    expect(d.bits & FOG_BIT_G).toBeTruthy();
    expect(d.green).toBe(Math.trunc(0.6 * 255));
  });

  test("sky factor alone still trips the shared density bit", () => {
    const current = fogState({ density: 0.024, sky_factor: 0.2 });
    PF_Fog(worldEdict, current, { ...current, sky_factor: 0.5 }, null);
    const d = decode(emitted());

    expect(d.bits & FOG_BIT_DENSITY).toBeTruthy();
    expect(d.density).toBeCloseTo(0.024, 6);
    expect(d.skyfactor).toBe(Math.trunc(0.5 * 255));
  });

  test("height fog sets the high bits and forces the 16-bit bits escape", () => {
    PF_Fog(
      worldEdict,
      ZERO,
      fogState({
        hf_falloff: 0.0673,
        hf_density: 0.0005,
        hf_start: [0.92, 0.38, 0.09, -328],
        hf_end: [0.1, 0.2, 0.3, -349],
      }),
      null,
    );
    const d = decode(emitted());

    expect(d.bits & FOG_BIT_MORE_BITS).toBeTruthy();
    expect(d.hf_falloff).toBeCloseTo(0.0673, 6);
    expect(d.hf_density).toBeCloseTo(0.0005, 8);
    expect(d.hf_start_r).toBe(Math.trunc(0.92 * 255));
    expect(d.hf_start_g).toBe(Math.trunc(0.38 * 255));
    expect(d.hf_start_b).toBe(Math.trunc(0.09 * 255));
    expect(d.hf_start_dist).toBe(-328);
    expect(d.hf_end_r).toBe(Math.trunc(0.1 * 255));
    expect(d.hf_end_g).toBe(Math.trunc(0.2 * 255));
    expect(d.hf_end_b).toBe(Math.trunc(0.3 * 255));
    expect(d.hf_end_dist).toBe(-349);
  });

  test("a transition duration rides in BIT_TIME; null omits the field entirely", () => {
    PF_Fog(worldEdict, ZERO, fogState({ density: 0.5 }), 500);
    let d = decode(emitted());
    expect(d.bits & FOG_BIT_TIME).toBeTruthy();
    expect(d.time).toBe(500);

    SZ_Clear(sv.multicast);
    PF_Fog(worldEdict, ZERO, fogState({ density: 0.5 }), null);
    d = decode(emitted());
    expect(d.bits & FOG_BIT_TIME).toBeFalsy();
  });

  /*
  mgu6m1's real worldspawn, the map this change was verified on. Its values
  are the ones the kex module was observed putting on the wire at spawn --
  density 0.024 / skyfactor 51 / rgb 138,82,211 plus the height-fog gradient
  -- so this case pins the classic encoder against an actual observed kex
  packet rather than against invented numbers.
  */
  test("mgu6m1's worldspawn encodes to the bytes the kex module was seen sending", () => {
    PF_Fog(
      worldEdict,
      ZERO,
      fogState({
        density: 0.024,
        r: 0.54135865,
        g: 0.32424483,
        b: 0.82885087,
        sky_factor: 0.2,
        hf_falloff: 0.0673,
        hf_density: 0.00049999997,
        hf_start: [0.92420536, 0.3839562, 0.09038686, -328.317],
        hf_end: [0, 0, 0, -349.096],
      }),
      null,
    );
    const d = decode(emitted());

    expect(d.opcode).toBe(SVC_FOG);
    expect(d.skyfactor).toBe(51);
    expect(d.red).toBe(138);
    expect(d.green).toBe(82);
    expect(d.blue).toBe(211);
    expect(d.hf_start_r).toBe(235);
    expect(d.hf_start_g).toBe(97);
    expect(d.hf_start_b).toBe(23);
    expect(d.hf_start_dist).toBe(-328);
    expect(d.hf_end_r).toBe(0);
    expect(d.hf_end_g).toBe(0);
    expect(d.hf_end_b).toBe(0);
    expect(d.hf_end_dist).toBe(-349);
    expect(d.time).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3b. info_world_text's two draw hooks
// ---------------------------------------------------------------------------

/*
These reach src/server/sv_debugdraw.ts -- the same buffer bindings/kex.ts
hands the kex module's Draw_OrientedWorldText / Draw_StaticWorldText -- so the
records the two modules produce are directly comparable. Nothing drains that
buffer in the running engine (see its header), so this is emit-side parity
only; the test reads it through SV_DebugDraw_Drain the way a renderer would.
*/
describe("info_world_text's draw hooks", () => {
  beforeEach(() => {
    SV_DebugDraw_Clear();
  });

  afterEach(() => {
    SV_DebugDraw_Clear();
  });

  test("a narrow session records nothing", () => {
    svs.csr = CS_REMAP_OLD;
    PF_DrawOrientedWorldText(vec3(1, 2, 3), "hello", [255, 255, 255, 255], 16, 0.1, true);
    PF_DrawStaticWorldText(vec3(1, 2, 3), vec3(0, 90, 0), "hello", [255, 0, 0, 255], 16, 0.1, true);
    expect(SV_DebugDraw_Drain()).toHaveLength(0);
  });

  test("a wide session records an oriented entry with the text, colour and size intact", () => {
    svs.csr = CS_REMAP_RERELEASE;
    PF_DrawOrientedWorldText(vec3(1, 2, 3), "hello", [116, 61, 50, 255], 16, 0.1, true);

    const drained = SV_DebugDraw_Drain();
    expect(drained).toHaveLength(1);
    const entry = drained[0]!;
    expect(entry.shape.kind).toBe("orientedWorldText");
    if (entry.shape.kind !== "orientedWorldText") throw new Error("unreachable");
    expect(entry.shape.text).toBe("hello");
    expect(entry.shape.size).toBe(16);
    expect([...entry.shape.origin]).toEqual([1, 2, 3]);
    // KEX_RGBA_ORANGE, the one info_world_text colour that is not a pure
    // channel value -- so it also pins the tuple-to-RgbaT conversion.
    expect(entry.color).toEqual({ r: 116, g: 61, b: 50, a: 255 });
  });

  test("a wide session records a static entry, carrying its angles", () => {
    svs.csr = CS_REMAP_RERELEASE;
    PF_DrawStaticWorldText(vec3(4, 5, 6), vec3(0, 270, 0), "sign", [0, 255, 255, 255], 8, 0.1, true);

    const drained = SV_DebugDraw_Drain();
    expect(drained).toHaveLength(1);
    const entry = drained[0]!;
    expect(entry.shape.kind).toBe("staticWorldText");
    if (entry.shape.kind !== "staticWorldText") throw new Error("unreachable");
    expect(entry.shape.text).toBe("sign");
    expect([...entry.shape.angles]).toEqual([0, 270, 0]);
    expect(entry.color).toEqual({ r: 0, g: 255, b: 255, a: 255 });
  });
});

// ---------------------------------------------------------------------------
// 4. The transition logic in src/game/g_kextrig.ts
// ---------------------------------------------------------------------------

/*
P_ForceFogTransition is exercised through a fake gi.fog() rather than the real
binding, because what is under test here is the MODULE's half: when it decides
to publish at all, and what transitionMs it computes. The encoding half is
covered above against the real PF_Fog.
*/
describe("P_ForceFogTransition -- the converged-state guard and the transition time", () => {
  type Call = { current: FogStateT; wanted: FogStateT; transitionMs: number | null };

  async function harness(): Promise<{
    calls: Call[];
    state: ReturnType<typeof import("../src/game/g_kextrig").KexClientFogState>;
    force: (instant: boolean) => void;
  }> {
    const kextrig = await import("../src/game/g_kextrig");
    const glocal = await import("../src/game/g_local");
    const calls: Call[] = [];

    // A player edict the module's per-client map can key on. s.number 1 is
    // the first client slot.
    const ent = { s: { number: 1 }, client: {} } as unknown as import("../src/game/g_local").EdictT;

    // g_local.ts's `gi` is an `export let` filled in at InitGame; this file
    // never loads a game library, so install a recording stand-in through the
    // module's own setter. Only the members P_ForceFogTransition touches need
    // to exist.
    glocal.SetGameImports({
      fog: (_e: unknown, current: unknown, wanted: unknown, transitionMs: unknown) => {
        calls.push({
          current: current as FogStateT,
          wanted: wanted as FogStateT,
          transitionMs: transitionMs as number | null,
        });
      },
    } as unknown as Parameters<typeof glocal.SetGameImports>[0]);

    const state = kextrig.KexClientFogState(ent);
    // Reset -- the module's map is process-wide and other tests in the file
    // may have touched slot 1.
    state.fog = { density: 0, r: 0, g: 0, b: 0, sky_factor: 0 };
    state.heightfog = { start: [0, 0, 0, 0], end: [0, 0, 0, 0], falloff: 0, density: 0 };
    state.wanted_fog = null;
    state.wanted_heightfog = null;
    state.fog_transition_time = 0;

    return { calls, state, force: (instant: boolean) => kextrig.P_ForceFogTransition(ent, instant) };
  }

  test("already-converged state publishes nothing", async () => {
    const h = await harness();
    h.force(false); // zero wanted vs zero current
    expect(h.calls).toHaveLength(0);
  });

  test("a changed wanted state publishes once, then converges and goes quiet", async () => {
    const h = await harness();
    h.state.wanted_fog = { density: 0.024, r: 0.5, g: 0.25, b: 0.75, sky_factor: 0.2 };

    h.force(false);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.wanted.density).toBeCloseTo(0.024, 6);
    // the "current" handed over is the pre-change state, so the engine's
    // diff sees every field as changed
    expect(h.calls[0]!.current.density).toBe(0);

    h.force(false);
    expect(h.calls).toHaveLength(1); // converged -- guard returns
  });

  test("instant suppresses BIT_TIME even when a delay is set", async () => {
    const h = await harness();
    h.state.fog_transition_time = 0.5;
    h.state.wanted_fog = { density: 0.1, r: 0, g: 0, b: 0, sky_factor: 0 };

    h.force(true);
    expect(h.calls[0]!.transitionMs).toBeNull();
  });

  test("a delay becomes whole milliseconds, truncated", async () => {
    const h = await harness();
    h.state.fog_transition_time = 0.5;
    h.state.wanted_fog = { density: 0.1, r: 0, g: 0, b: 0, sky_factor: 0 };

    h.force(false);
    expect(h.calls[0]!.transitionMs).toBe(500);
  });

  test("a sub-millisecond delay truncates to zero and so omits BIT_TIME", async () => {
    const h = await harness();
    h.state.fog_transition_time = 0.0004;
    h.state.wanted_fog = { density: 0.1, r: 0, g: 0, b: 0, sky_factor: 0 };

    h.force(false);
    expect(h.calls[0]!.transitionMs).toBeNull();
  });

  test("a very long delay clamps to 65535", async () => {
    const h = await harness();
    h.state.fog_transition_time = 120; // 120000ms
    h.state.wanted_fog = { density: 0.1, r: 0, g: 0, b: 0, sky_factor: 0 };

    h.force(false);
    expect(h.calls[0]!.transitionMs).toBe(65535);
  });

  test("height fog alone is enough to break convergence", async () => {
    const h = await harness();
    h.state.wanted_heightfog = { start: [0, 0, 0, 100], end: [0, 0, 0, -100], falloff: 0.01, density: 0.001 };

    h.force(false);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.wanted.hf_falloff).toBeCloseTo(0.01, 6);
    expect(h.calls[0]!.wanted.hf_start[3]).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// 5. Retail -- every shipped map's fog keys parse under the classic module
// ---------------------------------------------------------------------------

/** Minimal .pak reader: the entity lump of every .bsp in the archive. */
function eachMapEntityString(pak: string, visit: (name: string, ents: string) => void): number {
  const fd = openSync(pak, "r");
  try {
    const hdr = Buffer.alloc(12);
    readSync(fd, hdr, 0, 12, 0);
    if (hdr.toString("ascii", 0, 4) !== "PACK") return 0;
    const dirofs = hdr.readUInt32LE(4);
    const dirlen = hdr.readUInt32LE(8);
    const dir = Buffer.alloc(dirlen);
    readSync(fd, dir, 0, dirlen, dirofs);

    let seen = 0;
    for (let i = 0; i < dirlen / 64; i++) {
      const off = i * 64;
      let name = dir.toString("ascii", off, off + 56);
      const z = name.indexOf("\0");
      if (z >= 0) name = name.slice(0, z);
      if (!name.toLowerCase().endsWith(".bsp")) continue;
      const pos = dir.readUInt32LE(off + 56);

      const bh = Buffer.alloc(16);
      readSync(fd, bh, 0, 16, pos);
      const eOfs = bh.readUInt32LE(8);
      const eLen = bh.readUInt32LE(12);
      if (eLen <= 0 || eLen > 8 * 1024 * 1024) continue;
      const ent = Buffer.alloc(eLen);
      readSync(fd, ent, 0, eLen, pos + eOfs);
      visit(name, ent.toString("latin1"));
      seen++;
    }
    return seen;
  } finally {
    closeSync(fd);
  }
}

const FOG_KEYS = new Set([
  "fog_color",
  "fog_color_off",
  "fog_density",
  "fog_density_off",
  "fog_sky_factor",
  "fog_sky_factor_off",
  "heightfog_falloff",
  "heightfog_density",
  "heightfog_start_color",
  "heightfog_start_dist",
  "heightfog_end_color",
  "heightfog_end_dist",
  "heightfog_falloff_off",
  "heightfog_density_off",
  "heightfog_start_color_off",
  "heightfog_start_dist_off",
  "heightfog_end_color_off",
  "heightfog_end_dist_off",
]);

describe.skipIf(!havePak)("retail: every shipped map's fog keys are known to the classic module", () => {
  test("no map carries a fog_* / heightfog_* key src/game cannot parse", async () => {
    const gsave = await import("../src/game/g_save");
    // The classic module's spawn-field table, the thing g_spawn.ts's
    // ED_ParseField walks. Every fog key a retail map uses must be in it, or
    // the value is silently dropped and the map spawns unfogged.
    const table = (gsave as unknown as { spawnFields?: { key: string }[] }).spawnFields;
    const known = new Set<string>();
    if (table) for (const f of table) known.add(f.key);

    const unknown = new Map<string, string[]>();
    let withFog = 0;
    const total = eachMapEntityString(RETAIL_PAK, (name, ents) => {
      let mapHasFog = false;
      // Key position only: the entity lump is `"key" "value"` per line, so a
      // key is always the quoted token that a second quoted token follows.
      // Without that anchor this also matches rlava2's `fog_values`, which is
      // the TARGETNAME of the info_notnull its trigger_fog reads its
      // height-fog payload out of -- a value, not a spawn key, and one
      // neither module parses (nor needs to: g_kextrig.ts reaches it through
      // self.movetarget, not through a key).
      for (const m of ents.matchAll(/"((?:height)?fog_[a-z_]*)"[ \t]+"/g)) {
        const key = m[1]!;
        mapHasFog = true;
        // Known to the re-release schema at all?
        expect(FOG_KEYS.has(key)).toBe(true);
        if (known.size > 0 && !known.has(key)) {
          const list = unknown.get(key) ?? [];
          list.push(name);
          unknown.set(key, list);
        }
      }
      if (mapHasFog) withFog++;
    });

    expect(total).toBeGreaterThan(100);
    expect(withFog).toBeGreaterThan(0);
    expect([...unknown.keys()]).toEqual([]);
  });

  test("`fog_values` is a targetname, not a key -- and stays unparsed by both modules", () => {
    let asKey = 0;
    let asValue = 0;
    eachMapEntityString(RETAIL_PAK, (_name, ents) => {
      asKey += [...ents.matchAll(/"fog_values"[ \t]+"/g)].length;
      asValue += [...ents.matchAll(/"fog_values"\s*$/gm)].length;
    });
    expect(asKey).toBe(0);
    expect(asValue).toBeGreaterThan(0);
  });

  test("mgu6m1's worldspawn still carries the fog this change was verified against", () => {
    let found = "";
    eachMapEntityString(RETAIL_PAK, (name, ents) => {
      if (name.toLowerCase() === "maps/mgu6m1.bsp") found = ents;
    });
    expect(found).not.toBe("");
    expect(found).toContain('"fog_density" "0.024"');
    expect(found).toContain('"fog_color" "0.54135865 0.32424483 0.82885087"');
    expect(found).toContain('"fog_sky_factor" "0.2"');
  });
});
