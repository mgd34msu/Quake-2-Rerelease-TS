// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_svcmds.c -- the "sv" server-console command dispatch (2023 Quake II
// re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/g_svcmds.cpp (302 lines,
// C++17): Svcmd_Test_f, StringToFilter, SV_FilterPacket, SVCmd_AddIP_f,
// SVCmd_RemoveIP_f, SVCmd_ListIP_f, SVCmd_NextMap_f, SVCmd_WriteIP_f,
// ServerCommand. Behavioral code, ported bug-for-bug per this port line's
// house conventions (see g_monster.ts/g_utils.ts headers).
//
// ============================================================================
// `gi.LocClient_Print` -- placement-mismatch helper, duplicated locally
// ============================================================================
// Same treatment as g_items.ts's own `LocClient_Print` local helper: this
// port's `gi` has no `LocClient_Print`, only `Client_Print`; every call
// site below passes either a plain literal string or a `$`-prefixed loc
// key with format arguments substituted at the call site (this file's own
// C++ source uses `fmt`-style `{}` placeholders, e.g. `"Bad filter
// address: {}\n"`, not the `$key` + args pair the rest of this port line's
// `gi.Loc_Print` calls use) -- ported as plain `Com_sprintf`-free template
// interpolation into `gi.Client_Print`, matching this file's own
// non-localized, developer-facing console-message nature (every message
// here is a raw admin-console string, never a `$g_...` loc key, unlike
// g_cmds.ts's client-facing messages).
//
// ============================================================================
// EndDMLevel -- REAL import (was a throwing stub)
// ============================================================================
//   - `EndDMLevel()` -> g_main.cpp:521, now landed in src/kexgame/g_main.ts.
//     Previously a local, unexported, cited throwing stub ("not yet ported
//     (pending g_main.ts, see g_main.cpp:521)") stood in here; swapped for
//     the real, imported implementation now that g_main.ts exists.
//
// ============================================================================
// DEVIATIONS
// ============================================================================
// - `ipfilter_t ipfilters[MAX_IPFILTERS]; int numipfilters;` (C++ file-scope
//   globals, zero-initialized BSS): ported as a module-level, pre-filled
//   `{ mask: 0, compare: 0 }` array of exactly `MAX_IPFILTERS` slots plus a
//   `numipfilters` live-count, matching this port line's "shared mutable
//   globals become exported/module-scope singletons" convention
//   (PORTING.md's "Globals and module structure"). Pre-filling every slot
//   (rather than leaving `undefined` holes past `numipfilters`) matters for
//   one exact behavior: `SVCmd_AddIP_f`'s failure path
//   (`ipfilters[i].compare = 0xffffffff;`) mutates only `.compare`, leaving
//   `.mask` at whatever it already was (zero for a never-used slot, or a
//   stale value for a reused freed slot) -- exactly like the C++ global's
//   persistent storage. `numipfilters` bounds every real loop exactly as in
//   the C++, so the tail past it is simply unused either way.
// - `StringToFilter`'s `char num[128]` scratch buffer and byte-by-byte
//   ASCII-digit scan: ported as a plain character-by-character string scan
//   (`s[idx]` comparisons against `'0'`-`'9'`), matching the same terminate-
//   on-first-non-digit / accumulate-into-a-per-octet-buffer control flow.
//   `f->mask = *(unsigned *) m; f->compare = *(unsigned *) b;` (reading the
//   4-byte `byte[4]` arrays as a little-endian `unsigned` via pointer-cast):
//   ported as `(m[0] | (m[1] << 8) | (m[2] << 16) | (m[3] << 24)) >>> 0`,
//   the same little-endian byte order a `byte b[4]` -> `unsigned` cast
//   produces on this port's target (x86/ARM little-endian) platforms --
//   matching PORTING.md's "portable little-endian C path" convention.
// - `SV_FilterPacket`'s `const char *from` (a `"a.b.c.d:port"`-shaped
//   address string, called with the connecting client's IP): parses up to
//   4 dotted octets exactly like the C++ (stopping at `:` or a non-digit,
//   NOT validating dot placement -- same permissive parsing the C++ itself
//   does, bug-for-bug).
// - `SVCmd_WriteIP_f`'s entire body is commented out in the C++ source
//   itself (`KEX_FIXME: Sys_FOpen isn't available atm...`) -- ported as a
//   genuine no-op function (not a throwing stub: the C++ function exists,
//   compiles, and does nothing when called; a throwing stub would be less
//   faithful than an empty body here).
// - `qsort`/`fmt::format_to` (Cmd_Players_f-style formatting) do not appear
//   in this file (g_svcmds.cpp has no such calls) -- no deviation needed.

import { Q_strcasecmp } from "../shared/q_shared";
import { PrintTypeT } from "../kexapi/game";
import type { EdictT } from "./g_local";
import { gi } from "./g_main_globals";
import { EndDMLevel } from "./g_main";

// ---------------------------------------------------------------------------
// `gi.LocClient_Print` placement-mismatch local helper -- see file header
// ---------------------------------------------------------------------------

function giClientPrint(ent: EdictT | null, printlevel: PrintTypeT, message: string): void {
  gi.Client_Print(ent, printlevel, message);
}

// ---------------------------------------------------------------------------
// cvar access -- duplicated per-file per this port line's own convention
// (see p_client.ts's/g_target.ts's identical `cvarInt`/`cvarBool` copies)
// ---------------------------------------------------------------------------

function cvarInt(name: string, def: string): number {
  const c = gi.cvar(name, def, 0);
  return c === null ? 0 : c.value;
}

// ---------------------------------------------------------------------------
// Svcmd_Test_f (g_svcmds.cpp:6-9)
// ---------------------------------------------------------------------------

export function Svcmd_Test_f(): void {
  giClientPrint(null, PrintTypeT.PRINT_HIGH, "Svcmd_Test_f()\n");
}

// ---------------------------------------------------------------------------
// PACKET FILTERING (g_svcmds.cpp:11-45 doc comment; ipfilter_t/MAX_IPFILTERS)
// ---------------------------------------------------------------------------

interface IpfilterT {
  mask: number; // uint32_t
  compare: number; // uint32_t
}

const MAX_IPFILTERS = 1024;

// `ipfilter_t ipfilters[MAX_IPFILTERS];` is a C++ file-scope global array,
// zero-initialized (BSS) before any code runs -- pre-filled here to match,
// rather than left as sparse `undefined` holes, so a failed `StringToFilter`
// call below can mutate just `.compare` on an as-yet-untouched slot exactly
// like the C++ (`ipfilters[i].compare = 0xffffffff;` leaves `.mask`
// unchanged, whatever zero-initialized or previously-removed value it had).
const ipfilters: IpfilterT[] = Array.from({ length: MAX_IPFILTERS }, () => ({ mask: 0, compare: 0 }));
let numipfilters = 0;

/** little-endian `byte[4]` -> `unsigned` -- see file header's
 *  `*(unsigned *) b` note. */
function bytesToUint32LE(b: readonly [number, number, number, number]): number {
  return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
}

/** g_svcmds.cpp:63-103: `static bool StringToFilter(const char *s, ipfilter_t *f)`. */
function StringToFilter(s: string): IpfilterT | null {
  const b: [number, number, number, number] = [0, 0, 0, 0];
  const m: [number, number, number, number] = [0, 0, 0, 0];

  let idx = 0;

  for (let i = 0; i < 4; i++) {
    if (idx >= s.length || s[idx] < "0" || s[idx] > "9") {
      giClientPrint(null, PrintTypeT.PRINT_HIGH, `Bad filter address: ${s}\n`);
      return null;
    }

    let num = "";
    while (idx < s.length && s[idx] >= "0" && s[idx] <= "9") {
      num += s[idx];
      idx++;
    }
    b[i] = Number.parseInt(num, 10) || 0;
    if (b[i] !== 0) m[i] = 255;

    if (idx >= s.length) break;
    idx++; // skip '.'
  }

  return { mask: bytesToUint32LE(m), compare: bytesToUint32LE(b) };
}

/** g_svcmds.cpp:110-140: `bool SV_FilterPacket(const char *from)`. */
export function SV_FilterPacket(from: string): boolean {
  const m: [number, number, number, number] = [0, 0, 0, 0];

  let i = 0;
  let p = 0;
  while (p < from.length && i < 4) {
    m[i] = 0;
    while (p < from.length && from[p] >= "0" && from[p] <= "9") {
      m[i] = (m[i] * 10 + (from.charCodeAt(p) - 48)) & 0xff;
      p++;
    }
    if (p >= from.length || from[p] === ":") break;
    i++;
    p++;
  }

  const inAddr = bytesToUint32LE(m);

  const filterban = cvarInt("filterban", "1");

  for (i = 0; i < numipfilters; i++) {
    if ((inAddr & ipfilters[i].mask) === ipfilters[i].compare) return filterban !== 0;
  }

  return filterban === 0;
}

/** g_svcmds.cpp:147-172: `void SVCmd_AddIP_f()`. */
export function SVCmd_AddIP_f(): void {
  if (gi.argc() < 3) {
    giClientPrint(null, PrintTypeT.PRINT_HIGH, "Usage:  addip <ip-mask>\n");
    return;
  }

  let i = 0;
  for (i = 0; i < numipfilters; i++) {
    if (ipfilters[i].compare === 0xffffffff) break; // free spot
  }
  if (i === numipfilters) {
    if (numipfilters === MAX_IPFILTERS) {
      giClientPrint(null, PrintTypeT.PRINT_HIGH, "IP filter list is full\n");
      return;
    }
    numipfilters++;
  }

  const parsed = StringToFilter(gi.argv(2));
  if (parsed !== null) ipfilters[i] = parsed;
  else ipfilters[i].compare = 0xffffffff;
}

/** g_svcmds.cpp:179-203: `void SVCmd_RemoveIP_f()`. */
export function SVCmd_RemoveIP_f(): void {
  if (gi.argc() < 3) {
    giClientPrint(null, PrintTypeT.PRINT_HIGH, "Usage:  sv removeip <ip-mask>\n");
    return;
  }

  const f = StringToFilter(gi.argv(2));
  if (f === null) return;

  for (let i = 0; i < numipfilters; i++) {
    if (ipfilters[i].mask === f.mask && ipfilters[i].compare === f.compare) {
      for (let j = i + 1; j < numipfilters; j++) ipfilters[j - 1] = ipfilters[j];
      numipfilters--;
      giClientPrint(null, PrintTypeT.PRINT_HIGH, "Removed.\n");
      return;
    }
  }
  giClientPrint(null, PrintTypeT.PRINT_HIGH, `Didn't find ${gi.argv(2)}.\n`);
}

/** g_svcmds.cpp:210-221: `void SVCmd_ListIP_f()`. */
export function SVCmd_ListIP_f(): void {
  giClientPrint(null, PrintTypeT.PRINT_HIGH, "Filter list:\n");
  for (let i = 0; i < numipfilters; i++) {
    const c = ipfilters[i].compare;
    const b0 = c & 0xff;
    const b1 = (c >>> 8) & 0xff;
    const b2 = (c >>> 16) & 0xff;
    const b3 = (c >>> 24) & 0xff;
    giClientPrint(null, PrintTypeT.PRINT_HIGH, `${b0}.${b1}.${b2}.${b3}\n`);
  }
}

/** [Paril-KEX] g_svcmds.cpp:224-228: `void SVCmd_NextMap_f()`. */
export function SVCmd_NextMap_f(): void {
  gi.Loc_Print(null, PrintTypeT.PRINT_HIGH | PrintTypeT.PRINT_BROADCAST, "$g_map_ended_by_server", [], 0);
  EndDMLevel();
}

/** g_svcmds.cpp:235-272: `void SVCmd_WriteIP_f(void)`. The entire C++ body
 *  is commented out (`KEX_FIXME: Sys_FOpen isn't available atm`) -- see
 *  file header. Genuine no-op, not a stub. */
export function SVCmd_WriteIP_f(): void {
  // intentionally empty -- see file header
}

// ---------------------------------------------------------------------------
// ServerCommand (g_svcmds.cpp:283-302)
// ---------------------------------------------------------------------------

export function ServerCommand(): void {
  const cmd = gi.argv(1);

  if (Q_strcasecmp(cmd, "test") === 0) Svcmd_Test_f();
  else if (Q_strcasecmp(cmd, "addip") === 0) SVCmd_AddIP_f();
  else if (Q_strcasecmp(cmd, "removeip") === 0) SVCmd_RemoveIP_f();
  else if (Q_strcasecmp(cmd, "listip") === 0) SVCmd_ListIP_f();
  else if (Q_strcasecmp(cmd, "writeip") === 0) SVCmd_WriteIP_f();
  else if (Q_strcasecmp(cmd, "nextmap") === 0) SVCmd_NextMap_f();
  else giClientPrint(null, PrintTypeT.PRINT_HIGH, `Unknown server command "${cmd}"\n`);
}
