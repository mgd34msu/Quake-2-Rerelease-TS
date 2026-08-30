/*
Unit tests for the span-sorting edge rasterizer (r_edge.ts/r_scan.ts/
r_surf.ts). Exercises the pieces that are exact, hand-computable fixed-point
arithmetic or self-contained list algorithms, without depending on the
still-pending r_bsp.ts/r_main.ts/r_misc.ts/r_light.ts siblings:

- R_InsertNewEdges (r_edge.ts): keeps a fabricated active edge list u-sorted.
- D_DrawZSpans (r_scan.ts): the 1/z fixed-point gradient written per-pixel.
- D_DrawSpans16 (r_scan.ts): perspective-correct texture sampling, using an
  axis-aligned/unmipped setup (constant 1/z, t held constant) so the s/t
  stepping is plain linear arithmetic and every sampled index is
  hand-computable.
- D_SCAlloc/D_FlushCaches (r_surf.ts): the surface cache allocator
  reclaims/reuses its arena without letting live allocations overlap.

Each test initializes every global it reads, per PORTING.md/rule 13; none
of them rely on another test file (or another test in this file) having
run first.
*/

import { describe, test, expect } from "bun:test";
import type { RefImports } from "../src/client/ref";
import { CvarT } from "../src/shared/q_shared";
import { EdgeT, EspanT, SetRefImports, rCvars } from "../src/ref_soft/r_local";
import { R_InsertNewEdges } from "../src/ref_soft/r_edge";
import { D_DrawSpans16, D_DrawZSpans, D_SetCacheSource, D_SetStGradients, D_SetViewBuffer, D_SetZBuffer, D_SetZGradients } from "../src/ref_soft/r_scan";
import { D_FlushCaches, D_SCAlloc, R_InitCaches } from "../src/ref_soft/r_surf";

function fakeRefImports(): RefImports {
  return {
    Sys_Error(_err_level: number, str: string): never {
      throw new Error(str);
    },
    Cmd_AddCommand(_name, _cmd) {},
    Cmd_RemoveCommand(_name) {},
    Cmd_Argc() {
      return 0;
    },
    Cmd_Argv(_i) {
      return "";
    },
    Cmd_ExecuteText(_exec_when, _text) {},
    Con_Printf(_print_level, _str) {},
    FS_LoadFile(_name) {
      return { length: -1, data: null };
    },
    FS_FreeFile(_buf) {},
    FS_Gamedir() {
      return "";
    },
    Cvar_Get(_name, _value, _flags) {
      return null;
    },
    Cvar_Set(_name, _value) {
      return null;
    },
    Cvar_SetValue(_name, _value) {},
    Vid_GetModeInfo(_mode) {
      return null;
    },
    Vid_MenuInit() {},
    Vid_NewWindow(_width, _height) {},
  };
}

describe("R_InsertNewEdges", () => {
  test("keeps the active edge list sorted on u", () => {
    // active list: head(-1000) -> e20 -> tail(1_000_000)
    const head = new EdgeT();
    head.u = -1000;
    const tail = new EdgeT();
    tail.u = 1_000_000;
    const e20 = new EdgeT();
    e20.u = 20;

    head.next = e20;
    e20.prev = head;
    e20.next = tail;
    tail.prev = e20;

    // edgestoadd: e10 -> e30 -> e50 (already sorted, per R_InsertNewEdges's contract)
    const e10 = new EdgeT();
    e10.u = 10;
    const e30 = new EdgeT();
    e30.u = 30;
    const e50 = new EdgeT();
    e50.u = 50;
    e10.next = e30;
    e30.next = e50;
    e50.next = null;

    R_InsertNewEdges(e10, head.next);

    const forward: number[] = [];
    for (let e: EdgeT | null = head.next; e !== null && e !== tail; e = e.next) {
      forward.push(e.u);
    }
    expect(forward).toEqual([10, 20, 30, 50]);

    const backward: number[] = [];
    for (let e: EdgeT | null = tail.prev; e !== null && e !== head; e = e.prev) {
      backward.push(e.u);
    }
    expect(backward).toEqual([50, 30, 20, 10]);
  });
});

describe("D_DrawZSpans", () => {
  test("writes the 1/z fixed-point gradient across a span", () => {
    const zwidth = 32;
    const zbuffer = new Int16Array(zwidth * 4);
    D_SetZBuffer(zbuffer, zwidth);

    // zistepu = 2^-8 so izistep = trunc(zistepu * 0x8000 * 0x10000) = 2^23
    // = 8388608, an exact integer with no floating-point rounding, and
    // 8388608 >> 16 = 128 -- a clean per-pixel step.
    D_SetZGradients(1 / 256, 0, 0);

    const span = new EspanT();
    span.u = 0;
    span.v = 0;
    span.count = 5;
    span.pnext = null;

    D_DrawZSpans(span);

    // izi_0 = 0, izi_i = izi_0 + i*8388608; sample_i = izi_i >> 16 = i*128.
    expect(zbuffer[0]).toBe(0);
    expect(zbuffer[1]).toBe(128);
    expect(zbuffer[2]).toBe(256);
    expect(zbuffer[3]).toBe(384);
    expect(zbuffer[4]).toBe(512); // span end
  });
});

describe("D_DrawSpans16", () => {
  test("samples a flat, axis-aligned, unmipped span at the expected texel indices", () => {
    const screenwidth = 100;
    const viewbuffer = new Uint8Array(screenwidth * 4);
    D_SetViewBuffer(viewbuffer, screenwidth);

    // cachewidth doesn't matter here since t stays 0 for the whole span
    // (axis-aligned: t/z gradient is identically zero).
    const cachewidth = 64;
    const cacheblock = new Uint8Array(cachewidth * 4);
    for (let i = 0; i < cacheblock.length; i++) cacheblock[i] = i; // pbase[i] === i
    D_SetCacheSource(cacheblock, cachewidth);

    // Constant 1/z (zistepu = zistepv = 0, ziorigin = 1) removes perspective
    // correction from the picture entirely: z = 0x10000/1 = 0x10000 for
    // every pixel, so s is exactly linear in u (sdivzstepu = 1, everything
    // else 0) and t is exactly 0 everywhere (all t gradients 0).
    D_SetZGradients(0, 0, 1);
    D_SetStGradients({
      sdivzstepu: 1,
      tdivzstepu: 0,
      sdivzstepv: 0,
      tdivzstepv: 0,
      sdivzorigin: 0,
      tdivzorigin: 0,
      sadjust: 0,
      tadjust: 0,
      bbextents: 10_000_000,
      bbextentt: 10_000_000,
    });

    const span = new EspanT();
    span.u = 10;
    span.v = 0;
    span.count = 4; // <= 8: takes D_DrawSpans16's division-based (non-chunked) path
    span.pnext = null;

    D_DrawSpans16(span);

    // s(u) = u << 16 exactly (sdivz*z = u*0x10000, sadjust=0), so
    // s >> 16 == u for u = 10, 11, 12, 13; t >> 16 == 0 throughout, so the
    // sampled index is pbase[u] == u.
    expect(Array.from(viewbuffer.subarray(10, 14))).toEqual([10, 11, 12, 13]);
  });
});

describe("D_SCAlloc / D_FlushCaches", () => {
  test("allocates without overlap and reuses the arena after a flush", () => {
    SetRefImports(fakeRefImports());

    const override = new CvarT();
    override.value = 16384;
    rCvars.sw_surfcacheoverride = override;

    R_InitCaches();

    const alloc1 = D_SCAlloc(10, 100);
    const alloc2 = D_SCAlloc(20, 200);

    // distinct blocks, distinct backing storage
    expect(alloc1).not.toBe(alloc2);
    expect(alloc1.data).not.toBe(alloc2.data);
    expect(alloc1.data.length).toBe(10 * alloc1.height);
    expect(alloc2.data.length).toBe(20 * alloc2.height);

    // no overlap: alloc2 is exactly the leftover fragment chained directly
    // after alloc1 in the arena, so alloc1 ends precisely where alloc2 begins
    expect(alloc1.next).toBe(alloc2);

    D_FlushCaches();

    const alloc3 = D_SCAlloc(5, 50);

    // the flush collapsed the whole arena back into one free block at
    // sc_base, so this alloc reclaims the very same node alloc1 was
    expect(alloc3).toBe(alloc1);
    expect(alloc3.width).toBe(5);
    expect(alloc3.data.length).toBe(5 * alloc3.height);
  });
});
