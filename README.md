# Quake 2 Re-release TS

A TypeScript port of the 2023 Quake II re-release, running on
[Bun](https://bun.sh) — one engine hosting both the re-release game
module and the original v3.21-era games as first-class citizens.

The engine core is re-release-native (wide entity state, variable tick
rate, cgame host, navmesh bots, localization) with two peer game-API
bindings: the 2023 KEX API for the ported re-release game module, and
the classic v3 API for the frozen bug-for-bug legacy modules (baseq2,
ThreeWave CTF, The Reckoning, Ground Zero) inherited from
[Quake-2-TS](https://github.com/mgd34msu/Quake-2-TS). See
`ARCHITECTURE.md` for the full design, `PORTING.md` for the inherited
3.21 port's C-to-TS mapping.

**Status: early.** The repo is seeded with the complete, working
Quake-2-TS v1.1.0 tree (810 tests, four playable games) and is being
transformed in place toward the target architecture.

The long-horizon goal, recorded in `ARCHITECTURE.md`, is one engine for
the id-tech family: Quake 1 (original + 2021 re-release, via a
TypeScript QuakeC VM), Quake 2 (3.21 + 2023 re-release), and Quake 3,
with a crossover module for cross-game content play. The peer-binding
core exists to make each family additive.

## Lineage and attribution

- **id Software** — Quake II (1997) and the v3.21 GPL source release.
- **ZeniMax Media Inc.** — the 2023 re-release game module source
  ([quake2-rerelease-dll](https://github.com/id-Software/quake2-rerelease-dll)),
  GPLv2; the game-module port derives from it.
- **Q2PRO** by skullernet and contributors
  ([q2pro](https://github.com/skullernet/q2pro)) — the engine lineage
  this project's re-release engine design descends from.
- **q2repro** by Paril and contributors
  ([q2repro](https://github.com/Paril/q2repro), including Paril-KEX and
  Sam-KEX work) — the open re-release-compatible engine used as the
  reference specification for engine behavior.
- **q2proto** by res2k (Frank Richter)
  ([q2proto](https://github.com/res2k/q2proto)) — the reference for the
  wire-protocol abstraction and re-release protocol compatibility.
- **Quake-2-TS** — the complete TypeScript port of v3.21 this repo is
  seeded from.

## License

GNU General Public License v2 (`LICENSE`), the same license as the
re-release game source, Q2PRO, and q2repro. Game assets (paks, models,
sounds, maps) are commercial content and are not included or covered.
