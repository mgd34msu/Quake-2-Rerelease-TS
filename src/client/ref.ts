// ref.h -- the renderer module boundary. Mirrors game.ts's GameImports/
// GameExports pattern: refimport_t -> RefImports (functions the renderer
// calls back into the engine), refexport_t -> RefExports (functions the
// engine calls into the renderer).
//
// ref_gl/ is not ported per PORTING.md ("not ported (no OpenGL binding
// under bun); documented here"), so no module ever constructs a real
// RefExports today. The interfaces are still ported in full so client.ts's
// `re` extern and the client .c stubs that reference refdef_t/entity_t have
// a faithful typed surface to compile against.
//
// `struct model_s *` / `struct image_s *` are opaque pointers owned by the
// (unported) renderer -- forward-declared everywhere they appear, never
// dereferenced outside ref_gl. Mirrors q_shared.ts's trace_t.ent / game.ts's
// Edict.client forward-declaration idiom.
export type ModelS = unknown;
export type ImageS = unknown;

// Color-modulated pic draw. Added for the rerelease cgame API's
// SCR_DrawColorPic import (kexapi/game.ts's KexCgameImports), which has no
// counterpart in classic Q2's ref.h -- DrawPic/DrawStretchPic are always
// drawn full-white (uncolored). r/g/b/a are 0-255 like kexapi/game.ts's
// RgbaT (a structurally-identical shape kept separate here rather than
// imported, since ref.ts is a lower engine layer than kexapi/game.ts and
// must not depend on it).
export interface DrawColorT {
  r: number;
  g: number;
  b: number;
  a: number;
}

import { type Vec3, vec3 } from "../shared/math";
import type { CvarT } from "../shared/q_shared";

export const MAX_DLIGHTS = 32;
export const MAX_ENTITIES = 128;
export const MAX_PARTICLES = 4096;
export const MAX_LIGHTSTYLES = 256;

export const POWERSUIT_SCALE = 4.0;

export const SHELL_RED_COLOR = 0xf2;
export const SHELL_GREEN_COLOR = 0xd0;
export const SHELL_BLUE_COLOR = 0xf3;

export const SHELL_RG_COLOR = 0xdc;
export const SHELL_RB_COLOR = 0x68;
export const SHELL_BG_COLOR = 0x78;

export const SHELL_DOUBLE_COLOR = 0xdf; // 223
export const SHELL_HALF_DAM_COLOR = 0x90;
export const SHELL_CYAN_COLOR = 0x72;

export const SHELL_WHITE_COLOR = 0xd7;

export const API_VERSION = 3;

export class EntityT {
  model: ModelS | null = null;
  angles: Vec3 = vec3();

  // most recent data
  origin: Vec3 = vec3(); // also used as RF_BEAM's "from"
  frame = 0; // also used as RF_BEAM's diameter

  // previous data for lerping
  oldorigin: Vec3 = vec3(); // also used as RF_BEAM's "to"
  oldframe = 0;

  // misc
  backlerp = 0; // 0.0 = current, 1.0 = old
  skinnum = 0; // also used as RF_BEAM's palette index

  lightstyle = 0; // for flashing entities
  alpha = 0; // ignore if RF_TRANSLUCENT isn't set

  skin: ImageS | null = null; // NULL for inline skin
  flags = 0;

  // Additive fields for RF_FLARE rendering (misc_flare, kexgame/g_misc.ts's
  // SP_misc_flare). q2repro's entity_t carries both natively
  // (inc/refresh/refresh.h:63 `color_t rgba`, :68 `vec3_t scale`); classic
  // ref.h has neither, so every pre-existing caller leaves them at the
  // defaults below and nothing but the flare path reads them.
  //
  // `rgba` is the entity's tint, 0-255 per channel (DrawColorT's shape is
  // reused rather than re-declared -- same field names, same range). The C
  // is a color_t union written whole from `BigLong(s1->skinnum)`; the port
  // stores the unpacked bytes instead, since nothing here needs the u32
  // aliasing. Default is COLOR_WHITE (q2repro's `if (!s1->skinnum) ent.rgba
  // = COLOR_WHITE`).
  rgba: DrawColorT = { r: 255, g: 255, b: 255, a: 255 };
  // Per-axis model scale. 0 means "unscaled" exactly as in the C, which
  // reads it as `e->scale[0] ? e->scale[0] : 1.0f` (q2repro
  // src/refresh/main.c:347) -- so a zeroed entity keeps vanilla behavior.
  scale: Vec3 = vec3();
}

export const ENTITY_FLAGS = 68;

export class DlightT {
  origin: Vec3 = vec3();
  color: Vec3 = vec3();
  intensity = 0; // doubles as radius, matching original id Software dlight_t

  // Additive fields for task #25 (v1.1.0)'s CS_SHADOWLIGHTS-fed per-pixel
  // lighting (gl_shader.ts) -- q2repro's dlight_t splits `radius` (range,
  // this class's pre-existing `intensity` field above) from `intensity`
  // (brightness multiplier) and adds an optional spot cone; every classic
  // V_AddLight caller leaves these at their defaults (lightScale=1, no
  // cone), so the fixed-function path -- which never reads them -- is
  // unaffected either way.
  lightScale = 1;
  cone: { direction: Vec3; cosHalfAngle: number } | null = null;
  // v1.1.0 shadow maps: the entity's `shadowlightresolution`, in texels.
  // q2repro carries this field on cl_shadow_light_t and then drops it at the
  // dlight_t boundary (its dlight_t has no such member) because it has no
  // shadow-map target to size; this renderer does, so it survives the
  // handoff. 0 means the map's entity omitted the key -- gl_shadowmap.ts's
  // shadowMapResolution reads that as "use the default", not "no shadow".
  resolution = 0;

  // v1.1.1: true only for a CS_SHADOWLIGHTS-fed light (V_AddLightEx). Every
  // classic V_AddLight caller -- muzzle flashes, rockets, the blaster glow,
  // CL_RunDLights' whole transient pool -- leaves it false.
  //
  // Before omni shadow maps existed, `cone !== null` was an adequate stand-in
  // for "this is a shadow light": only V_AddLightEx ever set a cone. It stops
  // being adequate the moment CONELESS lights can be shadowed too, because a
  // muzzle flash is also a coneless light. Without this flag every rocket in
  // flight would allocate a six-face cube map and re-render it every frame,
  // and vanilla's unshadowed transient dlights would start casting shadows
  // they have never cast in any Quake 2.
  //
  // Declared OPTIONAL rather than initialized to false so that the several
  // DlightT-shaped object literals already in the tree stay assignable
  // without being rewritten; `undefined` and `false` mean the same thing to
  // every reader of this field, all of which test it for truthiness.
  isShadowLight?: boolean;
}

export class ParticleT {
  origin: Vec3 = vec3();
  color = 0;
  alpha = 0;
}

export class LightstyleT {
  rgb: Vec3 = vec3(); // 0.0 - 2.0
  white = 0; // highest of rgb
}

/*
Fog, as the renderer sees it. q2repro carries exactly these two structs on
its refdef (inc/refresh/refresh.h:108-109 `player_fog_t fog;
player_heightfog_t heightfog;`), declared in inc/shared/shared.h:1817-1830.
Values are already in renderer units: colors and the sky factor are 0..1
fractions, the two height distances are world Z.

The CLIENT owns the transition between two sets of these (see
src/client/cl_fog.ts); by the time they reach here they are one frame's
resolved values, never a start/target pair.
*/
export class FogGlobalT {
  color: Vec3 = vec3(); // 0..1
  density = 0;
  skyFactor = 0; // 0..1, applied as a flat mix on sky surfaces only
}

export class FogHeightPointT {
  color: Vec3 = vec3(); // 0..1
  dist = 0; // world Z
}

export class FogHeightT {
  start: FogHeightPointT = new FogHeightPointT();
  end: FogHeightPointT = new FogHeightPointT();
  density = 0;
  falloff = 0;
}

/*
One world-space text draw for the frame (info_world_text). q2repro holds
these renderer-side in its own debug_text_t freelist (src/refresh/debug.c:
42-55) because its server calls R_AddDebugText directly; this port routes
them through the refdef alongside entities and particles instead, so the
renderer keeps taking exactly one per-frame input struct.

`size` is already q2repro's `size * 8` world-unit character cell
(debug.c:376), and `oriented` means "angles were supplied" -- see
cl_worldtext.ts's makeWorldText for why that word reads backwards against
sv_debugdraw.ts's shape names.
*/
export class WorldTextT {
  origin: Vec3 = vec3();
  angles: Vec3 = vec3();
  oriented = false; // true: use `angles`; false: billboard toward the view
  text = "";
  size = 0; // world units per character cell
  color: Uint8Array = new Uint8Array(4); // rgba 0-255
  depthTest = true;
}

export class RefdefT {
  x = 0;
  y = 0;
  width = 0;
  height = 0; // in virtual screen coordinates
  fov_x = 0;
  fov_y = 0;
  vieworg: Vec3 = vec3();
  viewangles: Vec3 = vec3();
  blend: Float32Array = new Float32Array(4); // rgba 0-1 full screen blend
  time = 0; // time is used to auto animate
  rdflags = 0; // RDF_UNDERWATER, etc

  // refresh.h:108-109
  fog: FogGlobalT = new FogGlobalT();
  heightfog: FogHeightT = new FogHeightT();

  areabits: Uint8Array | null = null; // if not null, only areas with set bits will be drawn

  lightstyles: LightstyleT[] = []; // [MAX_LIGHTSTYLES]

  num_entities = 0;
  entities: EntityT[] = [];

  num_dlights = 0;
  dlights: DlightT[] = [];

  num_particles = 0;
  particles: ParticleT[] = [];

  num_worldtexts = 0;
  worldtexts: WorldTextT[] = [];
}

// these are the functions exported by the refresh module
export interface RefExports {
  api_version: number;

  Init(hinstance: unknown, wndproc: unknown): boolean;
  Shutdown(): void;

  BeginRegistration(map: string): void;
  RegisterModel(name: string): ModelS | null;
  RegisterSkin(name: string): ImageS | null;
  RegisterPic(name: string): ImageS | null;
  // Registers an already-in-memory RGBA8 pixel buffer under an exact name,
  // with no disk access and no filename-extension probing -- for callers
  // that already have rasterized pixels in hand (RegisterPic's whole
  // "resolve a filename to pixels" job doesn't apply). Added for
  // client/cgame/host.ts's TTF-backed kfont path (qcommon/ttf.ts's
  // buildFontAtlas rasterizes a font atlas straight into RGBA8 memory, no
  // file on disk to register a name against). GL: gl_image.ts's own
  // GL_LoadPic already accepts RGBA8 pixels + a bit depth directly.
  // Software: this renderer's whole pixel pipeline (r_draw.ts, r_surf.ts,
  // vid.colormap/d_8to24table) is palette-indexed 8-bit, so the
  // implementation quantizes via the SAME QuantizeRGBAToPalette path
  // r_image.ts's own LoadPNGQuantized/LoadJPGQuantized already use for the
  // rerelease's truecolor PNG/JPG UI assets, then feeds the same
  // module-private GL_LoadPic every other r_image.ts loader funnels
  // through. Returns null if `width`/`height` are non-positive (mirrors
  // RegisterPic's own "not found" null convention -- see gl_draw.ts's
  // Draw_FindPic/r_draw.ts's Draw_FindPic just below RegisterPic's own
  // wiring in both GetRefAPIs).
  RegisterRawPic(name: string, pixels: Uint8Array, width: number, height: number): ImageS | null;
  // q2repro src/refresh/sky.c's R_SetSky(name, rotate, autorotate, axis):
  // `autorotate` false makes `rotate` a FIXED rotation amount (degrees, not
  // degrees/sec) applied about `axis` every frame instead of a continuous
  // spin driven by r_newrefdef.time. Re-release worldspawn's skyautorotate
  // key (default 1) and target_sky both flow through this flag -- see
  // cl_view.ts's CL_SetSky.
  SetSky(name: string, rotate: number, autorotate: boolean, axis: Vec3): void;
  EndRegistration(): void;

  RenderFrame(fd: RefdefT): void;

  // q2repro src/refresh/main.c's R_SupportsPerPixelLighting -- task #25
  // (v1.1.0): true once the renderer's GL2+ shader path (gl_shader.ts)
  // initialized successfully, gating cl_fx.ts's CL_AddShadowLights (a
  // shadow light is otherwise pointless to evaluate: the fixed-function
  // path has nothing that consumes its per-pixel fields). No ref_gl-side
  // renderer existed when RefExports was first ported (this interface's
  // own header note is stale on that point -- see gl_rmain.ts's real
  // R_Init/R_Shutdown for the renderer that exists now), so every prior
  // RefExports member already had no real implementer either; this one is
  // new rather than retrofitted.
  SupportsPerPixelLighting(): boolean;

  DrawGetPicSize(name: string): { w: number; h: number }; // will return 0 0 if not found
  DrawPic(x: number, y: number, name: string): void;
  DrawStretchPic(x: number, y: number, w: number, h: number, name: string): void;
  // Like DrawStretchPic, but the pic is drawn tinted/modulated by `color`
  // instead of full-white. See DrawColorT's doc comment above for why this
  // exists (SCR_DrawColorPic has no classic-engine precedent).
  DrawColorPic(x: number, y: number, w: number, h: number, name: string, color: DrawColorT): void;
  // Like DrawColorPic, but samples a pixel-space sub-rectangle of the named
  // image's source texture instead of the whole thing (srcX/srcY/srcW/srcH,
  // in the SOURCE image's own pixel coordinates, top-down). Added for the
  // kfont FIDELITY RAZOR sweep (.orch/preferences.md rule 17): q2repro's
  // kfont glyphs are all packed into one shared atlas texture
  // (fonts/qconfont.png) with each glyph's rect given in atlas pixel
  // coordinates (kfont_char_t.x/y/w/h, src/refresh/draw.c's
  // draw_kfont_char) -- this is that atlas-subrect draw primitive, the one
  // this port's ref.ts didn't have before (DrawPic/DrawStretchPic/
  // DrawColorPic all draw the full source image). See gl_draw.ts's
  // Draw_StretchPicRegion (GL: texcoord subrect, mirrors Draw_ColorPic's
  // tinting) and r_draw.ts's Draw_StretchPicRegion (software: paletted
  // source-rect blit, mirrors Draw_ColorPic's remap+dither tinting) for the
  // two implementations.
  DrawStretchPicRegion(x: number, y: number, w: number, h: number, name: string, srcX: number, srcY: number, srcW: number, srcH: number, color: DrawColorT): void;
  DrawChar(x: number, y: number, c: number): void;
  DrawTileClear(x: number, y: number, w: number, h: number, name: string): void;
  DrawFill(x: number, y: number, w: number, h: number, c: number): void;
  DrawFadeScreen(): void;

  DrawStretchRaw(x: number, y: number, w: number, h: number, cols: number, rows: number, data: Uint8Array): void;

  CinematicSetPalette(palette: Uint8Array | null): void; // null = game palette

  // Animated-GIF frame selection for the 2D/UI Draw* calls below -- no
  // classic-engine precedent (same as DrawColorPic above). Set once per
  // draw-context switch, not per draw call: the caller (cl_scrn.ts's
  // SCR_UpdateScreen) calls this with cl.time-derived seconds right before
  // in-game HUD/2D draws and with cls.realtime-derived seconds right
  // before menu/console draws, matching Mike's design ruling in
  // qcommon/gif_beat.ts's own header comment (fixed 10Hz cadence off of
  // TIME, not tick count, so it's identical under a classic 10Hz server
  // and a KEX 40Hz one, and still works with no server connected at all).
  // GL: gl_draw.ts's Draw_Pic/Draw_StretchPic/Draw_ColorPic/
  // Draw_StretchPicRegion read this to pick which composited GIF frame's
  // texture to bind. Software: ref_soft/r_main.ts's implementation is a
  // documented no-op -- that renderer's Draw_Pic only ever has a single,
  // first-composited-frame texture to draw (see r_image.ts's own header
  // note on why animation isn't wired there).
  SetGifBeatSeconds(seconds: number): void;
  BeginFrame(camera_separation: number): void;
  EndFrame(): void;

  AppActivate(activate: boolean): void;
}

// these are the functions imported by the refresh module
export interface RefImports {
  Sys_Error(err_level: number, str: string): never;

  Cmd_AddCommand(name: string, cmd: (() => void) | null): void;
  Cmd_RemoveCommand(name: string): void;
  Cmd_Argc(): number;
  Cmd_Argv(i: number): string;
  Cmd_ExecuteText(exec_when: number, text: string): void;

  Con_Printf(print_level: number, str: string): void;

  FS_LoadFile(name: string): { length: number; data: Uint8Array | null }; // -1 length means the file does not exist
  FS_FreeFile(buf: Uint8Array): void;
  // The head of the shipped (non-homedir) copy of a file, for logical image
  // size recovery -- files.ts's FS_LoadShippedFile. Optional so the test
  // harnesses' minimal import tables keep compiling; a renderer without it
  // simply cannot see through a same-format drop-in replacement.
  FS_LoadShippedFile?(name: string, maxBytes: number): Uint8Array | null;

  FS_Gamedir(): string;

  Cvar_Get(name: string, value: string, flags: number): CvarT | null;
  Cvar_Set(name: string, value: string): CvarT | null;
  Cvar_SetValue(name: string, value: number): void;

  Vid_GetModeInfo(mode: number): { width: number; height: number } | null;
  Vid_MenuInit(): void;
  Vid_NewWindow(width: number, height: number): void;
}

// this is the only function actually exported at the linker level
export type GetRefAPIT = (imp: RefImports) => RefExports;
