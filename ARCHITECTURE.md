# Architecture

Decisions locked 2026-08-29. This document is the contract for the
transformation from the inherited Quake-2-TS v1.1.0 tree to the unified
re-release engine. Nothing here is aspirational filler — each section is
a commitment with a reference implementation to check against.

## Reference sources (local checkouts)

| Path | Role |
|---|---|
| `~/Projects/quake2-rerelease-dll/rerelease` | The 2023 game module (C++17, 103,284 lines, GPLv2). Source of truth for the kex game port. |
| `~/Projects/q2repro` | Q2PRO-derived re-release-compatible engine. Reference specification for all engine behavior. |
| `~/Projects/q2proto` | Wire-protocol abstraction library. Reference for the protocol layer and protocol 1038 compatibility. |
| `~/Projects/quake2-rerelease-dll/original` | 1997 C sources (already ported; the legacy modules' provenance). |

## Core model: one engine, five first-class game modules

The engine has exactly one internal model — the re-release superset —
and two peer game-API bindings over it. No proxy chaining (q2repro
routes legacy games through its 2023 API via `game3_proxy`; we do not).

```
                engine core (wide internal model,
                variable tick, protocol codec layer)
               /                                    \
   legacy binding (API v3)                 kex binding (API 2023)
   baseq2 / ctf / xatrix / rogue           re-release game module
   (frozen, bug-for-bug 3.21)              (content superset)
```

- **Legacy modules are frozen exhibits.** Their game code keeps its
  exact current `GameImports`/`GameExports` contract and bug-for-bug
  3.21 behavior. The legacy binding adapts engine-core services to that
  contract; the game trees themselves do not change.
- **The kex module is the content superset** (ZeniMax merged baseq2,
  xatrix, rogue, and CTF plus new content into one module). "Play
  baseq2 under re-release rules" is simply running the kex module.
  Re-release-only content is never backported into the legacy trees —
  that would destroy their fidelity, which is their entire value.
- **Pmove is always supplied by the binding.** The kex game exports its
  own (per the 2023 API); the legacy binding supplies the engine's
  classic pmove. Same slot, two providers, no special case.

## Engine core commitments

- **Internal state is the wide re-release shape** regardless of which
  module runs (q2proto takes the same stance: `Q2PROTO_FEATURES_RERELEASE`
  for in-memory structs, narrowing only at the wire). Entity state gains
  alpha/scale/instance_bits/loop_volume/loop_attenuation/owner/old_frame;
  player state gains the re-release fields; limits move to
  MAX_EDICTS 8192, MAX_MODELS 8192, MAX_SOUNDS 2048, MAX_IMAGES 512,
  with configstring remap tables (`cs_remap_old` / `cs_remap_rerelease`
  per q2repro `shared.c`) selected by module family.
- **Variable tick.** `sv_tick_rate` (default 40) for the kex module;
  legacy modules run their game logic at their native 10 Hz. Tick rate,
  frame_time_s, frame_time_ms are handed to the kex game as imports.
  The three literal `100`s in sv_main.ts and the per-tree `FRAMETIME`
  constants become derived values.
- **Framediv interpolation for legacy** (q2repro `USE_FPS` machinery,
  8-slot origin history per server entity): legacy game logic stays at
  10 Hz for fidelity while the wire and client run at full rate.
- **Savegames:** one container format (q2repro's `SSV2`/`SAV2` magic,
  engine owns file I/O) holding JSON blobs from either family. The kex
  API's string-returning WriteGameJson/ReadGameJson/WriteLevelJson/
  ReadLevelJson/CanSave is the native shape; the legacy binding wraps
  the existing g_save.ts JSON (already file-free at the format level —
  no base85 temp-file hack needed, unlike q2repro's C proxy).
- **64-bit flag enums** (`sv_ent_flags_t` and friends are uint64 in
  C++): port as `bigint` or split words — JS 32-bit bitops silently
  truncate. Audit every MAKE_ENUM_BITFLAGS type for width.

## Client: cgame host, two built-in cgames

The client becomes a cgame *host* implementing the 2022 cgame import
surface (tick fields, get_configstring, draw/font primitives, Localize,
CL_GetClientDogtag, etc.). Two first-class cgame implementations:

1. **Classic cgame** — the existing HUD/layout-string interpreter, temp
   entities, particles, inventory overlay (~8k lines currently in
   cl_scrn/cl_tent/cl_fx/cl_newfx/cl_inv) refactored behind the cgame
   interface. Serves the legacy modules. (q2repro's `cgame_classic.c`
   is the precedent; we carry the split further.)
2. **Kex cgame** — ported from `cg_screen.cpp`/`cg_main.cpp` (weapon
   wheel stats, POI, kfont drawing, splitscreen-aware DrawHUD).

## Protocol layer

Modeled on q2proto: per-protocol codecs behind one interface, with the
game-API family (`vanilla` / `rerelease`) and the client protocol as
independent axes.

- **Native + compat target: protocol 1038** (q2repro's re-release wire
  protocol) — byte-compatible, so real q2repro clients can connect to
  our server and vice versa, for kex and legacy-hosted games alike.
- The existing internal protocol-34 code remains as the legacy codec
  during transformation (and for old demos); it becomes one codec among
  peers rather than the hardcoded format.
- Reference: `q2proto_proto_q2repro.c`, `q2proto_proto_vanilla.c`, and
  q2repro's `q2proto-glue.c` / `q2proto_config.h`.

## KEX subsystems — all in scope

- **Bots + navmesh:** engine-side `.nav` loading and `GetPathToGoal`
  (q2repro `nav.c`, ~1,500 lines), the game-side `bots/` adapter in the
  kex module, and — beyond q2repro — **legacy bots**: the legacy
  binding synthesizes the `sv_entity_t` projection from legacy edicts
  so bots work in 3.21 DM/CTF too (q2repro stubs these for legacy).
- **Splitscreen:** MAX_SPLIT_PLAYERS, dupe_key dedup on unicast/
  local_sound, per-split cgame DrawHUD — implemented, not just carried.
- **Localization:** q2repro `loc.c` equivalent ($key resolution with
  argument reordering, loc_file cvar) feeding Loc_Print and the cgame
  Localize import.
- **Debug draw:** the ten Draw_* primitives as a versioned extension.
- **BSPX** (DECOUPLED_LM, lightgrid) per q2repro `bsp.c` for re-release
  map data.

## Porting standards (inherited from Quake-2-TS, still binding)

- Strict TypeScript: zero `any`, no casts (`as const` excepted).
- Bug-for-bug fidelity where observable; deviations documented in file
  headers. For the kex module the reference is the C++ source, bugs and
  all; attribution of quirks: id/ZeniMax for rerelease code, Xatrix/
  Rogue Entertainment for their merged content where it originates.
- C++ portisms: vec3 operator overloading becomes explicit function
  calls with copy-explicit value semantics (the `Object.assign`/shared-
  Float32Array trap class is already documented in PORTING.md);
  `gtime_t` ports as a branded int64-ms type, never float seconds;
  `G_Fmt`'s static-buffer aliasing hazard disappears in TS; the
  THINK/USE/PAIN/DIE macro registration system ports as an explicit
  name-to-function registry (it is the load-bearing mechanism of the
  JSON save system).

## Transformation process (seed-and-transform, always green)

Commit 1 is the working Quake-2-TS v1.1.0 tree (810 tests, four
playable games). Every subsequent step keeps `bunx tsc --noEmit` clean,
the suite green, and the legacy games playable — they are the living
test harness for the engine transformation. Rough phase order:

1. **Bindings skeleton** — introduce the 2023 API types (`game.h` port)
   and the engine-core service interfaces; wrap the existing four trees
   in the legacy binding (behavior-neutral refactor).
2. **Wide core** — entity/player state widening, configstring remap
   tables, limit lifts; protocol 34 codec keeps legacy wire behavior.
3. **Variable tick + framediv** — tick-rate plumbing, legacy pinned at
   10 Hz logic with interpolated delivery.
4. **cgame host** — extract the classic cgame; client renders legacy
   games through the host interface.
5. **Protocol layer** — codec abstraction, then the 1038 codec against
   q2proto's spec.
6. **Kex game module port** — the 103k-line C++ port (g_*, p_*, m_*,
   ctf/, rogue/, xatrix/, bots/), JSON save system, unified spawn/item
   registries; then the kex cgame.
7. **KEX subsystems** — nav/bots (incl. legacy projection), loc,
   splitscreen, debug draw, BSPX.
8. **Savegame container** unification and end-to-end compat testing
   against q2repro (protocol 1038 interop, .nav files, re-release
   game data).

Phases 2-5 are engine surgery under running games; phase 6 is the bulk
porting effort and can overlap with 7 once the bindings are stable.
