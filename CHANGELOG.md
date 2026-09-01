# Changelog

## v1.0.0 — 2026-09-01

First stable release: a complete TypeScript port of Quake 2 (2023
re-release lineage) on Bun — one engine, five first-class game modules
(vanilla 3.21, Xatrix, Rogue, Zaero-free CTF, LM-CTF, and the full 2023
KEX game), all retail content playable.

### Engine
- Protocol 1038 (KEX) end to end: float pmove state, 64-slot stats,
  wide entity/configstring layouts, batched-move writer, challenge
  negotiation; legacy protocols 34/35/36 byte-faithful with zpacket.
- packet_length negotiation (loopback sessions get the full 4086-byte
  budget), per-client buffer sizing, transmit-truncation fix.
- Variable tick (10-50 Hz) with frame-division AI, savegames (SSV/SAV
  container), MVD/GTV multi-view demos and relay, HTTP downloads,
  demo recording/playback for every family with checkpoint parity.
- Bot navigation (.nav) with a working legacy-family opt-in
  (sv_nav_legacy) that resolves entities the reference engine cannot.

### Content and formats
- Full retail format census implemented: QBSP extended maps
  (DECOUPLED_LM, LIGHTGRID_OCTREE), MD5 skeletal models with .md5scale,
  materials (.mat), kfont + TTF/OTF with COLR/CPAL color controller
  icons, sprite/wal/pcx/tga/jpg (baseline + progressive)/png (palette,
  16-bit, interlaced)/bmp/gif (static + animated on the 2D layer),
  bnvib haptics, environmental reverb (default.environments DSP).
- Universal image-extension fallback across both renderers.

### Play-anything matrix
- New Game selects content x ruleset x DATA TREE: original 1997 data or
  re-release data per launch, with per-tree expansion/mod discovery and
  campaign-ordered map selection; kex rules on original maps serves the
  1997 geometry with re-release presentation per-ruleset assets.

### Renderers
- GL: shader pipeline with per-pixel lighting, correct two-pass
  lightmap invariance (ftransform), vanilla extension gating,
  lightgrid-correct model lighting, 1024px lightmap atlases for
  DECOUPLED_LM, capacity raised for modern content.
- Software: faithful 1997 renderer with QBSP support, correct PCX
  screenshot output, capacity raised for modern content.

### Input
- Full SDL gamepad support (buttons, triggers, sticks, hotplug) wired
  to the retail controller bindings, with haptics sharing the handle.

### Verification
- 3235 tests, zero failures, proven order-independent (three forward
  runs plus reversed-order, both repos).
- Live self-play regate across every game family, both renderers, both
  shader modes, with automated screenshot verification.
