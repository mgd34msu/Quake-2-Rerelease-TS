// sv_debugdraw.ts -- server-side buffer for the kex/[Paril-KEX] debug-draw
// game import family (gi.Draw_Line/Draw_Point/Draw_Circle/Draw_Bounds/
// Draw_Sphere/Draw_OrientedWorldText/Draw_StaticWorldText/Draw_Cylinder/
// Draw_Ray/Draw_Arrow).
//
// ============================================================================
// WHAT q2repro ACTUALLY DOES (finding, not assumption)
// ============================================================================
// q2repro's server/game.c (#if USE_REF block, ~game.c:834-878) implements
// every PF_Draw_* by calling straight into the CLIENT renderer's own debug
// primitive list -- R_AddDebugLine/R_AddDebugPoint/R_AddDebugCircle/
// R_AddDebugBounds/R_AddDebugSphere/R_AddDebugText/R_AddDebugCylinder/
// R_AddDebugArrow (refresh/refresh.h). This is an in-process C function
// call, not a network message: q2repro's "server" and "client" (and
// renderer) are the same executable/address space on a listen server, so
// PF_Draw_Line can dereference the renderer's debug-line array directly.
// There is no svc_* message, no MSG_Write* call, nothing on the wire for
// any of these ten entry points -- grepped for svc_/MSG_Write*/SV_Multicast
// near every PF_Draw_* definition and found none. When USE_REF is not
// compiled in (dedicated server), q2repro's #else block (game.c:880-889)
// makes all ten literal no-ops, exactly like this port's legacy.ts already
// does for the non-kex path.
//
// RULING: this project's kex server binding is a headless/dedicated boot
// (kex.ts's own header: "a headless engine has no renderer"; no client
// renderer object exists in this process, and there is no q2repro precedent
// for sending these over the wire to fabricate one). Faking a client-visible
// render from here would be inventing behavior q2repro itself does not have.
// So: this module is the sensible port of the *dedicated-server* case q2repro
// itself falls back to when USE_REF is off, upgraded from a bare no-op to a
// real buffer -- draw requests are recorded with their shape data and
// lifetime instead of being silently discarded, so a future renderer/
// transport unit (splitscreen/local-client phase, or a wire protocol for a
// remote debug overlay) has real data to drain rather than needing to
// reinstrument every Draw_* call site. Actual rendering remains
// unimplemented; this is the seam, not the renderer.
//
// ============================================================================
// BUFFER SEMANTICS
// ============================================================================
// Each Add call appends one entry, oldest-first (SV_DebugDraw_Drain returns
// insertion order, i.e. FIFO -- "drain order").
//
// `lifeTime` mirrors q2repro's parameter (seconds; converted to ms here as
// q2repro's own PF_Draw_* do: `lifeTime * 1000`, see game.c:839 etc.):
//   - lifeTime <= 0: a "one-shot" request (q2repro's renderer convention for
//     "draw for the current frame only"). It is returned by exactly one
//     SV_DebugDraw_Drain() call and removed as part of that call.
//   - lifeTime > 0: a persistent request. It is returned by every
//     SV_DebugDraw_Drain() call until its remaining lifetime, decremented by
//     SV_DebugDraw_Tick(deltaMs), drops to zero or below -- at which point
//     SV_DebugDraw_Tick removes it (it will not appear in a Drain call after
//     the Tick that expires it, even if Drain is called before the *next*
//     Tick).
import type { Vec3 } from "../shared/math";
import type { RgbaT } from "../kexapi/game";

export type DebugDrawShape =
  | { kind: "line"; start: Vec3; end: Vec3 }
  | { kind: "point"; point: Vec3; size: number }
  | { kind: "circle"; origin: Vec3; radius: number }
  | { kind: "bounds"; mins: Vec3; maxs: Vec3 }
  | { kind: "sphere"; origin: Vec3; radius: number }
  | { kind: "orientedWorldText"; origin: Vec3; text: string; size: number }
  | { kind: "staticWorldText"; origin: Vec3; angles: Vec3; text: string; size: number }
  | { kind: "cylinder"; origin: Vec3; halfHeight: number; radius: number }
  | { kind: "ray"; origin: Vec3; direction: Vec3; length: number; size: number }
  | { kind: "arrow"; start: Vec3; end: Vec3; size: number; arrowColor: RgbaT };

export interface DebugDrawEntry {
  readonly id: number;
  readonly shape: DebugDrawShape;
  readonly color: RgbaT;
  readonly depthTest: boolean;
  // ms remaining. <= 0 means "one-shot": alive for exactly one Drain call.
  remainingMs: number;
  readonly oneShot: boolean;
}

let nextId = 1;
let buffer: DebugDrawEntry[] = [];

function add(shape: DebugDrawShape, color: RgbaT, lifeTime: number, depthTest: boolean): number {
  const id = nextId++;
  buffer.push({
    id,
    shape,
    color,
    depthTest,
    remainingMs: lifeTime > 0 ? lifeTime * 1000 : 0,
    oneShot: lifeTime <= 0,
  });
  return id;
}

export function SV_DebugDraw_Line(start: Vec3, end: Vec3, color: RgbaT, lifeTime: number, depthTest: boolean): number {
  return add({ kind: "line", start, end }, color, lifeTime, depthTest);
}

export function SV_DebugDraw_Point(point: Vec3, size: number, color: RgbaT, lifeTime: number, depthTest: boolean): number {
  return add({ kind: "point", point, size }, color, lifeTime, depthTest);
}

export function SV_DebugDraw_Circle(origin: Vec3, radius: number, color: RgbaT, lifeTime: number, depthTest: boolean): number {
  return add({ kind: "circle", origin, radius }, color, lifeTime, depthTest);
}

export function SV_DebugDraw_Bounds(mins: Vec3, maxs: Vec3, color: RgbaT, lifeTime: number, depthTest: boolean): number {
  return add({ kind: "bounds", mins, maxs }, color, lifeTime, depthTest);
}

export function SV_DebugDraw_Sphere(origin: Vec3, radius: number, color: RgbaT, lifeTime: number, depthTest: boolean): number {
  return add({ kind: "sphere", origin, radius }, color, lifeTime, depthTest);
}

export function SV_DebugDraw_OrientedWorldText(
  origin: Vec3,
  text: string,
  color: RgbaT,
  size: number,
  lifeTime: number,
  depthTest: boolean,
): number {
  return add({ kind: "orientedWorldText", origin, text, size }, color, lifeTime, depthTest);
}

export function SV_DebugDraw_StaticWorldText(
  origin: Vec3,
  angles: Vec3,
  text: string,
  color: RgbaT,
  size: number,
  lifeTime: number,
  depthTest: boolean,
): number {
  return add({ kind: "staticWorldText", origin, angles, text, size }, color, lifeTime, depthTest);
}

export function SV_DebugDraw_Cylinder(
  origin: Vec3,
  halfHeight: number,
  radius: number,
  color: RgbaT,
  lifeTime: number,
  depthTest: boolean,
): number {
  return add({ kind: "cylinder", origin, halfHeight, radius }, color, lifeTime, depthTest);
}

export function SV_DebugDraw_Ray(
  origin: Vec3,
  direction: Vec3,
  length: number,
  size: number,
  color: RgbaT,
  lifeTime: number,
  depthTest: boolean,
): number {
  return add({ kind: "ray", origin, direction, length, size }, color, lifeTime, depthTest);
}

export function SV_DebugDraw_Arrow(
  start: Vec3,
  end: Vec3,
  size: number,
  lineColor: RgbaT,
  arrowColor: RgbaT,
  lifeTime: number,
  depthTest: boolean,
): number {
  return add({ kind: "arrow", start, end, size, arrowColor }, lineColor, lifeTime, depthTest);
}

/*
====================
SV_DebugDraw_Tick

Advances every persistent (lifeTime > 0) entry's remaining lifetime by
deltaMs and removes any that have expired. One-shot entries are untouched
here -- they are removed by SV_DebugDraw_Drain instead, on the call that
returns them.

Not wired to the server frame loop by this unit: there is no per-frame kex
binding hook to drive it from (kex.ts's `ServerFrame` import is a one-shot
query of `sv.framenum`, not a per-frame callback), and doing so is the
renderer/transport unit's job once it exists to consume the drained data.
====================
*/
export function SV_DebugDraw_Tick(deltaMs: number): void {
  if (buffer.length === 0) return;
  buffer = buffer.filter((entry) => {
    if (entry.oneShot) return true;
    entry.remainingMs -= deltaMs;
    return entry.remainingMs > 0;
  });
}

/*
====================
SV_DebugDraw_Drain

Returns every currently-live entry, oldest first. One-shot entries
(lifeTime <= 0) are removed from the buffer as part of this call, having
been delivered exactly once; persistent entries remain buffered until
SV_DebugDraw_Tick expires them.
====================
*/
export function SV_DebugDraw_Drain(): DebugDrawEntry[] {
  const snapshot = buffer.map((entry) => ({ ...entry }));
  if (buffer.some((entry) => entry.oneShot)) {
    buffer = buffer.filter((entry) => !entry.oneShot);
  }
  return snapshot;
}

// Test-only: resets buffer state between test files/cases.
export function SV_DebugDraw_Clear(): void {
  buffer = [];
  nextId = 1;
}
