# Quake 2 (v3.21 GPL) → TypeScript port conventions

Source tree: `../quake-2-c` (id Software release, readme.txt). Runtime: bun.
Every worker follows this file. It is the contract; the check gate is `bun run check`.

## Directory and file mapping

| C | TS |
|---|---|
| `game/q_shared.h`, `game/q_shared.c` | `src/shared/q_shared.ts` (types + constants) and `src/shared/math.ts` (vector/angle/COM_Parse helpers) |
| `qcommon/*.c` | `src/qcommon/<basename>.ts` |
| `qcommon/qcommon.h`, `qfiles.h` | `src/qcommon/qcommon.ts`, `src/qcommon/qfiles.ts` |
| `server/*.c`, `server/server.h` | `src/server/<basename>.ts`, `src/server/server.ts` |
| `game/*.c`, `game/g_local.h`, `game/game.h` | `src/game/<basename>.ts`, `src/game/g_local.ts`, `src/game/game.ts` |
| `game/m_<monster>.h` (frame indices) | `src/game/m_<monster>_frames.ts` |
| `client/*.c`, headers | `src/client/<basename>.ts` |
| `ref_soft/r_*.c` (C only; `.asm` files are hand-optimized duplicates of the C paths and are not ported) | `src/ref_soft/<basename>.ts` |
| `linux/ win32/ solaris/ irix/` | `src/platform/` — ONE bun implementation of the sys/net/vid/snd interfaces (`sys.ts`, `net_udp.ts`, `vid.ts`, `snd.ts`). The per-OS dirs are alternative implementations of the same interface and are not transliterated. |
| `null/*.c` | `src/null/<basename>.ts` (headless client stubs for the dedicated server) |
| `linux/cd_linux.c`, `win32/cd_win.c` | `src/platform/cd_ogg.ts` — same six-entry `cdaudio.h` interface; the physical CD drive (ioctl/MCI redbook playback) is replaced by `music/NN.ogg` rips decoded via the system libvorbisfile (bun:ffi) into the mixer's raw-sample ring. Degrades to `src/null/cd_null.ts` behaviour when libvorbisfile is absent. |
| `ctf/` | `src/ctf/` (copies `src/game` structure) |
| `xatrix/` (mission pack 1, from quake2-rerelease-dll/original) | `src/xatrix/` — shared basenames start from the `src/game` port with the C diff (xatrix/X.c vs baseq2/X.c) applied; pack-only files are fresh ports |
| `rogue/` (mission pack 2, same source tree) | `src/rogue/` — same diff-driven strategy |
| `ref_gl/gl_*.c` | `src/ref_gl/<basename>.ts`; the C `qgl` function-pointer table becomes the `QGL` interface in `src/ref_gl/qgl.ts`, bound to the system libGL via `bun:ffi` at runtime (`loadQGLFromSystem`, extensions via SDL's GetProcAddress), with a `QGLRecording` fake for tests. Extension entry points are `| null` exactly like the C pointers. GLimp lives in `src/platform/glimp.ts` over SDL GL contexts; `vid_ref gl` selects it at runtime. |

Entry point: `src/main.ts` (Qcommon_Init + frame loop, dedicated-server configuration).

## Core data shapes

- `type Vec3 = Float32Array` (length 3), created by `vec3()` in `src/shared/math.ts`. Float32Array keeps C `float` semantics. Vector functions keep C out-param style: `VectorAdd(a, b, out)`. Never return fresh arrays on hot paths.
- C `int` arithmetic truncates: use `| 0` after division/multiplication where C used ints; `>>> 0` where C used unsigned. Bit ops already coerce to int32.
- C structs → `class` with every field initialized in the declaration (no optional fields for always-present data). Structs that are pure data with no methods stay classes anyway, so `new EdictT()` mirrors `memset(ent, 0, ...)` re-init via a `clear()` method when the C code memsets.
- C function pointers → typed function fields, `null` when C uses NULL: `think: ((self: EdictT) => void) | null`. Model callback sets with named type aliases in `g_local.ts`.
- `qboolean` → `boolean`. C truthiness on ints/pointers becomes explicit (`!== 0`, `!== null`).
- C enums → TS `enum` with the same numeric values (they cross the network protocol). `#define` constants → `export const NAME = value as const` (plain `export const NAME = 3;` is fine).
- Fixed-size C arrays → plain `T[]` initialized to length with a fill, or `Float32Array`/`Uint8Array`/`Int32Array` when the C type is numeric and indexed heavily.
- `sizebuf_t` → `SizeBuf` class over a `Uint8Array` + `DataView` in `src/qcommon/sizebuf.ts`; MSG_Write*/MSG_Read* stay byte-exact with the C wire format (little-endian).
- Binary file formats (BSP `qfiles.h`, MD2, WAL, PCX, PAK) → parsed from `ArrayBuffer` with `DataView`, struct-by-struct, offsets matching the C layout.
- `trace_t.ent` is `unknown` in `src/shared/q_shared.ts` (C forward-declares `struct edict_s` there). `src/game/game.ts` ports C `game.h`'s shared edict prefix as `interface Edict`; server code uses `Edict` throughout and game code recovers its full `EdictT` with the C idiom `g_edicts[ent.s.number]` (EDICT_NUM), never a cast. Game-facing traces are typed in `game.ts` as `interface GTraceT extends Omit<TraceT, "ent"> { ent: Edict | null }`.
- C helpers that mutate a `char*` in place (`Com_sprintf(dest, size, ...)`, `COM_DefaultExtension`, `Info_RemoveKey`, `Info_SetValueForKey`) return the new string instead; JS strings are immutable. `Com_sprintf(fmt, ...args): string`.
- When a helper's true source file differs from the mapping table above (e.g. `random()`/`crandom()` live in `g_local.h` but are mapped to `math.ts`), the brief's placement wins; report the mismatch, don't move it.
- Pending stubs (historical): during concurrent porting, briefs could authorize sibling stubs throwing `PendingPort`. The close phase ran: `pending.ts` is deleted and zero references remain. Functions that are bodyless declarations in the C source throw plain `Error`s naming themselves.

## Globals and module structure

- Shared mutable globals (`level`, `game`, `sv`, `svs`, `cls`, …) become exported `const` singleton objects mutated in place, declared in the module that owns them in C. They are never reassigned; C code that memsets them calls their `clear()`.
- C globals that are reassigned pointers (`g_edicts`, `currentmove`) become fields on their owning singleton or a small exported holder object.
- The game/engine boundary keeps the DLL shape: `game_import_t` → `interface GameImports`, `game_export_t` → `interface GameExports` in `src/game/game.ts`. The server constructs a `GameImports` object and calls `GetGameAPI(gi)`; nothing else crosses that boundary.
- Header modules (`g_local.ts`, `server.ts`, `client.ts`, `qcommon.ts`) hold shared types, constants, and singletons. Use `import type` for type-only imports. If two modules need each other's values at load time, move the shared value into the header module instead of importing sideways.
- Import-cycle rule: when a static import closes a value cycle that breaks module init (TDZ `ReferenceError` at load), the module on the *less fundamental* side breaks the cycle by dropping the static import and resolving lazily inside the function bodies with Bun's synchronous `require()` (keep `import type` for the types). This is the one sanctioned use of `require()`; report each use. First instance: `files.ts` → `cvar`/`cmd`.

## Idiom map

- `Com_Error(ERR_DROP, ...)` / `longjmp` recovery → `class ComError extends Error { constructor(public code: number, message: string) }` thrown, caught by `try/catch` in `Qcommon_Frame`. `Sys_Error` → `class SysError`. Never `throw` bare strings.
- varargs `printf` style → `Com_sprintf(fmt, ...args)` ported in `src/shared/q_shared.ts` supporting `%s %d %i %u %f %g %c %x %%` with width/precision as used by the codebase; `va()` → template literals at call sites are fine when the format is trivial.
- `strcpy/strncpy/Q_strcasecmp/strtok` patterns → string operations; `COM_Parse(data)` keeps its C signature via a parse-state object `{ data: string; index: number }` returning the token.
- `Z_Malloc/Z_Free/Hunk_*/Z_TagMalloc` → plain allocation; tag-freeing loops become explicit list clears. Report any place where tag semantics carry logic.
- `#ifdef WIN32/__linux__/id386/BIG_ENDIAN` → take the portable little-endian C path; list dropped branches in your report. `#if 0` blocks are dropped silently.
- `goto` → restructure with early return, labeled break, or a small state flag; keep the original control flow order.
- `rand()`/`random()`/`crandom()` → helpers in `src/shared/math.ts` using `Math.random()` (determinism across runs is not a goal; determinism within the C algorithms that seed explicitly must be preserved with a ported LCG).
- `Sys_Milliseconds` → monotonic clock in `src/platform/sys.ts`.
- File I/O: `node:fs` sync calls inside `src/platform` and `src/qcommon/files.ts` only. PAK archives are parsed per `qfiles.h`.
- UDP networking: `Bun.udpSocket` inside `src/platform/net_udp.ts`, presenting the `NET_*`/`netadr_t` interface from `qcommon.h`.
- No `console.log` outside `src/platform/sys.ts` (Sys_ConsoleOutput is the one print boundary).

## Game-track conventions (settled after G1)

- `gi`, `globals`, `g_edicts` are bare `export let` globals in `g_local.ts`, assigned via `SetGameImports`/`SetGameExports`/`SetGEdicts` from `GetGameAPI`/`InitGame`. Call sites keep the C shape (`gi.dprintf(...)`, `g_edicts[i]`). No holders, no null-checks; undefined-before-load matches the C global's lifetime.
- C field-offset macros die at the call site: `FOFS(targetname)` → the literal property name `"targetname"`. `G_Find(from, field, match)` takes `field` typed as the string-valued keys of `EdictT` (`type EdictStringKey = { [K in keyof EdictT]: EdictT[K] extends string | null ? K : never }[keyof EdictT]`). `g_save.c`'s `fields[]` table gets the same property-name redesign.

## Type discipline (enforced)

`tsc --strict` with zero `any` (grep-gated, including `as any`, `<any>`, `any[]`). No `as` casts except `as const`; parse external bytes/strings into typed shapes at the boundary and trust the types inside. Discriminated unions where the C code switches on a type tag. Exhaustive switches get `default: { const _exhaustive: never = x; }` only where the input type is closed.

## What "done" means for a unit

`bun run check` passes with the unit's files included, the module exports what its C header exported, and TODOs are absent — a function you cannot port faithfully is a reported deviation, not a `// TODO`.
