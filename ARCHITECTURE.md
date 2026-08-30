# Architecture

Decisions locked 2026-08-29. This document is the contract for the
transformation from the inherited Quake-2-TS v1.1.0 tree to the unified
re-release engine. Nothing here is aspirational filler — each section is
a commitment with a reference implementation to check against.

## Reference sources (local checkouts)

Active-phase references:

| Path | Role |
|---|---|
| `~/Projects/quake2-rerelease-dll/rerelease` | The 2023 game module (C++17, 103,284 lines, GPLv2). Source of truth for the kex game port. |
| `~/Projects/q2repro` | Q2PRO-derived re-release-compatible engine. Reference specification for all engine behavior. |
| `~/Projects/q2proto` | Wire-protocol abstraction library. Reference for the protocol layer and protocol 1038 compatibility. |
| `~/Projects/quake2-rerelease-dll/original` | 1997 C sources (already ported; the legacy modules' provenance). |

The long-horizon reference library lives at `~/Projects/qsrc/` — see
"The long horizon" below for each tree's role.

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

---

# The long horizon: one engine for the id-tech family

Everything below phase 8 is future work, recorded now because it is the
real justification for the peer-binding architecture: the core is being
built wide so that game families are additive. The target is a single
engine hosting Quake 1 (original + 2021 re-release), Quake 2 (3.21 +
2023 re-release), and Quake 3 — with cross-game content play.

## The three unification layers

"Play X in Y" decomposes into three problems with different difficulty
and different proof status:

1. **Universal assets** — any map and model format loads and renders
   anywhere: BSP29/BSP38/BSP46, MDL/SPR/MD2/MD3, three palettes and
   lighting models, Q3 shader scripts and bezier patches. Proven
   territory: Nightdive's KEX engine runs both re-releases on one core;
   FTEQW has loaded Q1/Q2/Q3 content in one open engine for years.
   Known hard spots: Q1 BSP29 carries precomputed collision hulls for
   only three fixed box sizes, so arbitrary-size entities need
   brush-level collision reconstruction (BSPX `BRUSHLIST` extension;
   FTEQW is the reference implementation). Q3's shader system is the
   largest single renderer lift in the whole vision and goes last.
2. **Selectable rulesets** — whose pmove, weapons, and match rules run
   is a module choice, achievable by construction in this architecture:
   modules are peers over one core, and any module can run on any map
   the engine loads. Q1 bunny-hopping, Q2 movement, and Q3
   strafe-jumping are three pmove providers in the slot the kex/legacy
   bindings already define.
3. **Content crossover** — a map spawns entities by classname; cross-
   play requires the running module to implement whatever spawns, plus
   per-family classname translation tables. The endgame is a
   **crossover module**: the union bestiary and arsenal across all
   families. The 2023 re-release module is already this pattern in
   miniature (four games' content merged, including a ported Q1
   shambler); the crossover module extends it. Difficulty ranking of
   the canonical pairs: Q3-maps-under-Q2-rules (easiest: patch
   collision + a small item table), Q2-content-in-Q1-maps (BSPX
   collision + translation table), Q1-campaign-under-Q3-rules (hardest
   framing: Q3 has no monsters, so the crossover module carries the
   entire Q1 bestiary itself).

Layers 1 and 2 are engineering with existence proofs. Layer 3's full
matrix has never been shipped polished by anyone — that part is new
territory.

## Module family roadmap

Each step ships something playable on its own; the order forces the
core wide early.

1. **Q2 re-release** (phases 1-8 above) — forces the multi-family core,
   wide state, cgame host, protocol layer.
2. **Q1 family** — a QuakeC VM written in TypeScript (progs are ~110
   opcodes over a flat globals/fields model; same order of code as our
   BSP/MD2 loaders) plus BSP29/MDL/SPR loaders, the Q1 palette, and a
   Q1 binding mapping VM builtins onto engine-core services. Runs the
   original `progs.dat` bytecode — fidelity by interpretation, better
   than any port. Covers all five Q1 campaigns: base, hipnotic
   (Scourge of Armagon), rogue (Dissolution of Eternity), and the 2021
   re-release additions (mg1 / Dimension of the Machine), all of whose
   QuakeC is GPLv2. Doubles as a QuakeC mod platform.
3. **Crossover module** — the union content module plus translation
   tables. All required game logic (Q1 QC, Q2 3.21, Q2RR, Q3) is
   GPLv2-compatible, so the union can legally live in this tree; Q1
   monsters port from QuakeC to native TS here (the module needs them
   at native speed alongside kex content).
4. **Q3 family** — QVM support (the `lcc`/`q3asm` toolchain in qsrc
   pins the bytecode format from the producer side), BSP46 + shader
   system + MD3 renderer work, Q3 binding. Last because the renderer
   cost dominates and nothing else depends on it.

## Long-horizon reference library (`~/Projects/qsrc/`)

| Tree | Role | License |
|---|---|---|
| `quake/` | Q1 original: WinQuake, QuakeWorld, original QuakeC (`qw-qc`) | GPLv2 |
| `quake-rerelease-qc/` | 2021 re-release QuakeC: base + ctf + hipnotic + rogue + mg1 | GPLv2 |
| `quake-2/` | 3.21 GPL source (canonical tree for the already-ported legacy modules) | GPLv2 |
| `quake2-rerelease-dll/` | 2023 game module + original C (co-located copy of the active reference) | GPLv2 |
| `q2repro/` | Engine reference (co-located copy) | GPLv2 |
| `quake-iii-arena/` | Q3 source incl. `lcc` + `q3asm` (the QVM toolchain) | GPLv2 |
| `fteqw/` | Multi-game engine precedent; BSPX BRUSHLIST collision reference | GPLv2 |
| `quake-tools/` | qcc (reference QuakeC compiler — pins progs.dat from the producer side), QuakeEd, qutils | GPLv2 |
| `quake-2-tools/` | Q2 bsp compiler, qdata, qe4 | GPLv2 |
| `gtkradiant/` | Map editor / asset pipeline | GPL |
| QCVM (github.com/erysdren/QCVM) | Implementation reference for the TS QuakeC VM — MIT, may be translated freely | MIT |

## License rules (binding)

- This tree is GPLv2 throughout (q2repro's license). Every source that
  feeds it must be GPLv2-compatible; the table above qualifies.
- **GPLv3 projects are excluded entirely — including as reading
  references.** Clean-room reimplementation of incompatible-licensed
  work is legally defensible but launders the author's license choice;
  we don't do it. Specifically excluded: Paril's quake2c and
  quake2c-progs. If their ideas are ever genuinely needed, the path is
  asking the author for permission or relicensing, not "reading."
  (Running third-party `progs.dat` files as *data* through our VM is
  fine regardless of their license — the same arm's-length boundary
  that lets any GPL engine load any game module.)
- Game assets (paks, models, sounds, maps) remain commercial content,
  never included.
