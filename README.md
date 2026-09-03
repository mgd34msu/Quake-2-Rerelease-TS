# Quake 2 Re-release TS

A TypeScript port of the 2023 Quake II re-release, running on
[Bun](https://bun.sh) — one engine hosting both the re-release game
module and the original v3.21-era games as first-class citizens.

The engine core is re-release-native (wide entity state, variable tick
rate, cgame host, navmesh bots, localization) with two peer game-API
bindings: the 2023 KEX API for the ported re-release game module, and
the classic v3 API for the legacy modules (baseq2, ThreeWave CTF,
LM-CTF, The Reckoning, Ground Zero), whose behavior matches the 1997
releases exactly, quirks preserved on purpose, inherited from
[Quake-2-TS](https://github.com/mgd34msu/Quake-2-TS). See
`ARCHITECTURE.md` for the full design, `PORTING.md` for the inherited
3.21 port's C-to-TS mapping, `CHANGELOG.md` for what each release
changed.

**Status: v1.1.0.** The complete 2023 re-release game module (~103k
lines of C++) is ported and coverage-audited, running at its native
40Hz over the re-release wire protocol against retail game data,
alongside the five classic games exactly as they shipped. Any content
plays under any ruleset: every shipped map, the re-release's Call of
the Machine campaign included, loads under the classic module and the
expansion modules with every entity present, and the 1997 maps play
under the re-release module. Two- to four-player local splitscreen,
full shadow mapping in the GL renderer with models casting and
receiving, the re-release's fog, world text, glow maps and MD5 models,
resolution-independent texture replacement (drop higher-resolution
files of any supported format into a game directory), a scalable
HUD, and both a hardware and a software renderer.

### Running

Install [Bun](https://bun.sh), then from a checkout:

    bun install
    bun run src/main.ts +set basedir /path/to/quake2

`basedir` is a Quake II install: a classic 1997 tree, the 2023
re-release tree, or a classic tree with the re-release nested inside
it (both are detected; the New Game screen picks content, ruleset and
map set). Release builds on the GitHub releases page are single-file
executables for Linux, Windows and macOS that need no Bun install.

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
