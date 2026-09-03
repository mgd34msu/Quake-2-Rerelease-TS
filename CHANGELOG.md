# Changelog

## v1.1.0 — 2026-09-02

### Any content, any ruleset
- The classic 3.21 game module, and now The Reckoning, Ground Zero, CTF
  and LMCTF modules too, spawn every re-release entity class as
  first-class content: all Call of the Machine monsters (shambler,
  gladiator/soldier variants, stalker, gekk, ...), weapons, ammo,
  powerups, targets, triggers, shadow/dynamic lights, props and movers,
  ported from our own expansion and re-release modules. Every shipped
  map loads under the classic ruleset with zero unknown entities.
- The configstring space is now a property of the session, not the game
  module: content that exceeds vanilla's 256-model limit (three CotM
  maps) widens to the re-release layout mid-load; content that fits
  stays byte-for-byte on the vanilla layout and protocol, so vanilla
  remote clients and protocol-34 demos are unchanged.
- Re-release content under the classic ruleset presents fully: shadow
  lights, flares, per-entity alpha/scale. The map's own entity lump
  decides when a session uses the wide layout; the 1997 map set never
  does and stays byte-for-byte on vanilla's.
- The Reckoning, Ground Zero and CTF modules gained the re-release-only
  entity classes their maps place.
- LMCTF: the module shipped a partial item list, so LMCTF maps had no
  weapons, ammo or armor pickups at all. The full LM-CTF item list,
  weapon set and deathmatch item rules are now ported; every LMCTF map
  spawns every entity.
- Start points on re-release maps match the re-release under the
  classic ruleset (coop-only entities are inhibited in single player as
  the re-release does; spawn-point fallback ported).
- Coop under the classic ruleset on re-release maps inhibits single-
  player-only entities as the re-release does and falls back to the
  re-release's coop start chain when vanilla's finds no start (gated on
  re-release content; 1997 coop unchanged).
- Landmark-relative level transitions (base1->base2 and the other
  campaign exits) work under the classic ruleset; the re-release
  module's own landmark flag was also wrong (it tested a bit no map
  carries), so its landmark transitions silently fell back too -- fixed.
- func_animation brushes now animate under the classic module (the
  start/end keys never armed the animation, so every one freed itself).
- New Game: every ruleset selectable for every content; maps/data lists
  every tree that has the content; nothing greyed, blank or locked. The
  re-release tree is auto-detected when nested under a classic basedir.

- The classic ruleset presents the re-release's objective compass
  markers (target_poi, `compass` command) and boss health bars
  (target_healthbar) exactly as the re-release ruleset does, and the
  misc_hologram particle shell renders under both rulesets.
- Re-release ruleset fixes found on the way: using the compass no longer
  desyncs the connection (objective positions were written as shorts
  where the client reads floats); colored 2D HUD draws (boss bars,
  story/timer backgrounds) now actually draw and take their tint.

- Classic ruleset on re-release maps: crouch and jump work and monsters
  see the player. The widened session's move format dropped the
  vertical-move and light-level fields the classic module reads, so the
  server never saw a crouch or jump and every monster treated the player
  as standing in the dark.

- The compass help path (breadcrumb trail to the objective) works under
  both rulesets, drawn with the re-release's marker model; the
  navigation mesh query was never wired to either game module, and the
  classic module now loads navigation data by default (sv_nav_legacy 0
  opts out).

### Local splitscreen
- 1-4 players on one machine under both rulesets: keyboard/mouse plus
  gamepads, per-pane HUDs, cameras, centerprints and sounds; New Game
  "local players" row; cl_seats N from the console.
- Menus taller than the screen now scroll (Controllers, Keys) with the
  cursor kept in view; menus that fit are unchanged.
- Options > Controllers: per-player controller assignment (by device
  GUID, survives replug) and per-player sensitivity, invert and dead
  zone.

### Full shadow mapping (GL)
- Models receive shadow-map shadows as well as casting them.
- Cone and point/omni shadow lights cast real shadows (six cube faces
  packed into one depth atlas); players, monsters and movers cast
  shadows; depth maps cached until something in view moves.
- Video > OpenGL: "shadow mapping" toggle and "shadow quality" slider.

### Rendering
- Software renderer: the re-release HUD's tinted boxes and glyphs no
  longer paint the palette's transparent index (the objective panel drew
  as a pink box).
- Model skins render correctly: skeletal (MD5) models had their
  high-resolution skins overwritten by the old MD2 skin on every
  registration, so items, monsters and barrels drew a magnified crop of
  the wrong texture panel. Every skeletal model in the re-release was
  verified against its MD2 render.
- The re-release's emissive glow maps render on models and world
  surfaces under both rulesets, in the surface's own colour.
- High-resolution replacement textures work: a truecolor file next to a
  classic .pcx/.wal now wins, every image, skins and world textures included, uploads at
  native size with driver-built mipmaps where the GL allows (the 1997
  skins were all being resampled and lost about half their detail), and
  every image keeps the shipped asset's logical size whatever the
  replacement's format or resolution (a 4x font atlas or crosshair png
  dropped over the re-release's own png used to garble HUD text and
  draw the crosshair 4x), so a larger replacement never warps. The
  software renderer resamples replacements to the shipped size.
- LM-CTF is a complete port now. The module had shipped with its player
  view, HUD and per-frame client logic stubbed: the eye sat at the
  origin (the "crouched by default" look), no weapon bob, kick, damage
  or water blends, no footstep or pain sounds; no weapon could fire at
  all (the weapon think had no caller); a carried flag stayed parked at
  its base; runes never ticked; votes never resolved; walking into an
  exploding barrel crashed the game; a passing skip-level vote threw.
  p_view.c, p_hud.c (scoreboards, squadboard, help, stats), the
  ClientThink/ClientBeginServerFrame blocks, every client command
  (id, position, radio, compass, match, playerlist, referee, kick,
  gotomap, quadtime, votes, stats, ...), and the maplist.txt reader are
  ported from lmctf60, behavior kept exactly, quirks preserved.
- Mod directories mount every .pak they hold, not only pak0..pak9, so map
  packs with their own names (LMCTF's q2lmctfmaps2012.pak, seedmappak.pak)
  load; a vid_ref value from another engine's config (r1gl) means gl instead
  of failing the load and falling back to software.
- A map change that fails part-way (a map the engine cannot load, an
  error while spawning) shuts the server down cleanly instead of running
  the next game frame over a half-built level ("SV_PointContents: no
  world model").
- Level changes between large re-release maps no longer drop to the
  console with "MAX_GLTEXTURES" (Strogg Gateway to Uplink Tower); the GL
  image table holds 4096 entries.
- Menus: spin-control values sit next to their labels again on every
  screen (New Game, Video, Options had a 120-pixel gap), the Video body
  starts below its banner, Player Setup finds the loose players/ models
  of a classic install, and the Video menu has a "hud scale" row (auto,
  1x to 4x) for the classic HUD, crosshair and re-release text size.
- Video: "scale to fullscreen: fit screen" works (a 4:3 mode on a 16:9
  display is scaled to full height and centered with black bars; it
  used to sit unscaled in a corner), resolution scale goes up to 2.00x
  supersampling, screenshots capture the clean render at render
  resolution, and the Video/Options/Controllers menus align their
  values in one column.
- Shadows: the 1997 planar model shadow is off by default (id's own
  default; it had been on with a value borrowed from a different
  renderer), never draws on top of shadow mapping, and projects the
  right mesh for skeleton-animated models (it used to project a stale
  buffer from whatever MD2 model drew last, which was the source of the
  giant black fans and the black patches on monster skins). Shadow
  mapping turns off and back on in-session from the Video menu.
- misc_flare entities render (additive billboards with distance fade).
- Re-release fog renders in the GL renderer: worldspawn fog, trigger_fog
  volumes and target_fog transitions, with the global, height and sky
  terms and the client-side fades matching the reference exactly (the
  reference's own height-band placement quirk included, so mgu6m1 looks
  like it does in the re-release). Applied as a depth-buffer pass after
  the scene so world, models, sprites and particles all take the same
  fog; gl_fog toggles it. Requires the shader path (gl_shaders 1, the
  default); the software renderer has no fog.
- info_world_text renders in 3D (textured glyphs, billboard or fixed
  orientation, depth-tested or not) under both rulesets.
- Software renderer lights re-release maps (DECOUPLED_LM support);
  previously they rendered near-black. It also now loads the re-release's
  .tga skies (they never drew), sizes its per-frame surface/edge pools
  to the map instead of 1997 minimums (large maps silently lost
  thousands of faces per frame), handles 512px sky faces, and renders
  the underwater warp (was black).
- Oversized frames now reach the network channel's fragmentation path
  (mgu5m1/mgu5m2 rendered black before); a local classic session talks
  to its own client on the server's best protocol (Q2PRO 36) like the
  reference client does -- remote vanilla clients still get 34.

### Fixes
- The classic HUD auto-scales with the display like the re-release HUD
  (it drew at 1x everywhere, hence the tiny icons), the crosshair scales
  with it, and the re-release HUD font no longer smears (its
  non-power-of-two atlas was being resampled on upload, and its drop
  shadow drew white instead of black).
- With the re-release install nested inside the classic tree, every
  ruleset and map-set combination from New Game now loads the map set
  you chose (classic maps used to fail with "bad inline model number"
  after a re-release launch, and the re-release ruleset ignored the
  classic-maps choice), and objective text resolves instead of showing
  raw `$g_` keys.
- The sky honors the map's skyautorotate flag under both rulesets, and
  target_sky changes reach the renderer mid-level. The re-release base1
  sky no longer spins.
- Every shipped map boots to a live game under both rulesets (444 of 444
  map/ruleset pairs; 21 did not): model-less triggers crashed the classic
  server on five maps; crucified misc_insane threw under the re-release
  module on fourteen; a long start_items key was truncated; maps with no
  start entity now spawn at the origin as the re-release does; func_plat2
  START_ACTIVE honored.
- Re-release ruleset: every inline-model entity (doors, buttons, plats,
  trains, triggers, walls -- 11,289 across 211 shipped maps) had
  collapsed bounds because the game-module bridge never copied mins/maxs
  back after setmodel, and door/plat/train/turret spawn keys (lip,
  distance, height, ...) were ignored by a stale private spawn-temp.
  Doors now open where they should and triggers fire where they are.
- Demos recorded by this engine play back (inline models resolved before
  the collision map loaded; usercmds sent during playback with the wrong
  codec; loopback ring dropping the kex demo's serverdata block; large
  demo blocks destroyed while fragments drained); the retail re-release
  demo plays under the kex ruleset.
- Loopback-address check, R1Q2/Q2PRO 16-bit index gates, kex connect
  tail flag parsing; oversized inbound loopback packets no longer crash.
- Suite passes in a clean checkout's file order.

## v1.0.1 — 2026-09-01

### Video UX patch
- Every menu slider shows a live value readout (resolution scale marks
  "1.00x (native)"; brightness, sensitivity, volumes, texture quality
  all show real values).
- New "scale to fullscreen" toggle (vid_scale_fit, default on): output
  stretches to fill the display; off means centered 1:1 pixels.
- Fixed the corner-anchored small-image bug: fullscreen blits were
  computed against the requested mode size while the window silently
  resized to desktop-native; geometry now uses the real window size.
- Fullscreen semantics: the selected mode is the render resolution and
  output always fills the display — no physical mode switching.
- Video mode list shows aspect ratios on every entry and colloquial
  names where standard: "1920x1080 (1080p, 16:9)", "1920x1200 (16:10)".
- Settings persistence: the whole video cvar family (fullscreen mode
  included) survives restarts; gl_mode/sw_mode were registered without
  the archive flag in one path.

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
