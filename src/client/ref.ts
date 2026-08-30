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
}

export const ENTITY_FLAGS = 68;

export class DlightT {
  origin: Vec3 = vec3();
  color: Vec3 = vec3();
  intensity = 0;
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

  areabits: Uint8Array | null = null; // if not null, only areas with set bits will be drawn

  lightstyles: LightstyleT[] = []; // [MAX_LIGHTSTYLES]

  num_entities = 0;
  entities: EntityT[] = [];

  num_dlights = 0;
  dlights: DlightT[] = [];

  num_particles = 0;
  particles: ParticleT[] = [];
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
  SetSky(name: string, rotate: number, axis: Vec3): void;
  EndRegistration(): void;

  RenderFrame(fd: RefdefT): void;

  DrawGetPicSize(name: string): { w: number; h: number }; // will return 0 0 if not found
  DrawPic(x: number, y: number, name: string): void;
  DrawStretchPic(x: number, y: number, w: number, h: number, name: string): void;
  DrawChar(x: number, y: number, c: number): void;
  DrawTileClear(x: number, y: number, w: number, h: number, name: string): void;
  DrawFill(x: number, y: number, w: number, h: number, c: number): void;
  DrawFadeScreen(): void;

  DrawStretchRaw(x: number, y: number, w: number, h: number, cols: number, rows: number, data: Uint8Array): void;

  CinematicSetPalette(palette: Uint8Array | null): void; // null = game palette
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
