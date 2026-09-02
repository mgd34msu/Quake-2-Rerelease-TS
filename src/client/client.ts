// client.h -- primary header for client. Includes ref.h/vid.h/screen.h/
// sound.h/input.h/keys.h/console.h/cdaudio.h in C; those are ported as
// sibling modules in this directory and imported here where client.h's own
// types reference them.
//
// Naming collision ruling (reported per this unit's brief): C has TWO
// distinct types both spelled `client_state_t` -- server.h's is an enum
// (cs_free/cs_zombie/cs_connected/cs_spawned, already ported as
// server.ts's `ClientStateT`), client.h's is this file's large per-level
// struct (global `cl`). To keep both unambiguous project-wide, this unit's
// client-side types take a `Cl`-prefixed name (mirroring the CL_ function
// prefix used throughout the client module, which server-side code has no
// equivalent of):
//   - client_state_t (struct, global `cl`)   -> ClStateT
//   - client_static_t (struct, global `cls`) -> ClStaticT
//   - connstate_t (enum)                     -> ConnstateT
//   - keydest_t (enum)                       -> KeydestT
//   - dltype_t (enum)                        -> DltypeT
// `client_t` (server.h's per-connection struct) is unaffected -- it stays
// server.ts's ClientT, a different C type entirely.
//
// Every extern global client.h declares (cl, cls, cl_entities, cl_dlights,
// cl_parse_entities, cl_weaponmodels, num_cl_weaponmodels, in_mlook,
// in_klook, in_strafe, in_speed, gun_frame, gun_model, svc_strings, re, and
// the cl_* cvars) lives in this header module, even where the C global's
// storage is actually defined in a specific .c file (e.g. gun_frame/
// gun_model are defined in cl_view.c, in_mlook/in_klook/in_strafe/in_speed
// in cl_input.c) -- matching this codebase's existing precedent of server.ts
// hosting `sv`/`svs` directly. Function prototypes this header declares are
// NOT ported here; they're exported from the pending stub of whichever
// client/*.c file actually defines them (confirmed by grep, not by this
// header's own file-grouping comments, several of which are stale --
// reported per function below).

import { type Vec3, vec3 } from "../shared/math";
import {
  MAX_QPATH,
  MAX_CLIENTS,
  MAX_ITEMS,
  CmodelT,
  EntityStateT,
  PlayerStateT,
  UsercmdT,
  type CvarT,
} from "../shared/q_shared";
import { MAX_MAP_AREAS } from "../qcommon/qfiles";
import { UPDATE_BACKUP } from "../qcommon/qcommon";
import { NetchanT } from "../qcommon/net_chan";
import { type ModelS, type ImageS, type RefExports, RefdefT, MAX_DLIGHTS } from "./ref";
import type { SfxT } from "./snd_loc";
import type { ProtocolCodec } from "../qcommon/protocol/codec";
import { VANILLA_CODEC } from "../qcommon/protocol/vanilla";
import {
  type CsRemapT,
  CS_REMAP_OLD,
  CS_REMAP_RERELEASE,
  MAX_EDICTS_WIDE,
  MAX_MODELS_WIDE,
  MAX_SOUNDS_WIDE,
  MAX_IMAGES_WIDE,
  MAX_SHADOW_LIGHTS_WIDE,
} from "../shared/cs_remap";

//=============================================================================

export class FrameT {
  valid = false; // cleared if delta parsing was invalid
  serverframe = 0;
  servertime = 0; // server time the message is valid for (in msec)
  deltaframe = 0;
  areabits: Uint8Array = new Uint8Array(MAX_MAP_AREAS / 8); // portalarea visibility bits
  playerstate: PlayerStateT = new PlayerStateT();
  num_entities = 0;
  parse_entities = 0; // non-masked index into cl_parse_entities array
}

// q2repro src/client/client.h's cl_shadow_light_t -- one CS_SHADOWLIGHTS-fed
// light definition, task #25 (v1.1.0). Placed in client.ts (not ref.ts)
// matching q2repro's own placement (client.h, not ref.h): this is
// client-side scene state re-evaluated every frame in CL_AddShadowLights
// (cl_fx.ts) against the entity it's attached to, before being handed to
// V_AddLightEx (cl_view.ts) which turns it into an r_dlights entry the
// renderer actually consumes. No `lighttype` field: like the original,
// coneangle===0 means point, non-zero means spot (see
// CL_ParseShadowLightConfigstring's `isCone` handling in cl_fx.ts).
export class ShadowLightT {
  origin: Vec3 = vec3();
  radius = 0;
  resolution = 0;
  intensity = 0;
  fade_start = 0;
  fade_end = 0;
  lightstyle = -1;
  coneangle = 0; // spot if non-zero
  conedirection: Vec3 = vec3();
  color: Vec3 = vec3(1, 1, 1); // unpacked 0..1; alpha/skinnum sign bit not modeled, unused downstream
}

// client_state_t.shadowdefs[MAX_SHADOW_LIGHTS] (client.h)
export class ShadowLightDefT {
  number = 0; // owning entity's s.number; 0 = unset slot
  light: ShadowLightT = new ShadowLightT();
}

export class CentityT {
  baseline: EntityStateT = new EntityStateT(); // delta from this if not from a previous frame
  current: EntityStateT = new EntityStateT();
  prev: EntityStateT = new EntityStateT(); // will always be valid, but might just be a copy of current

  serverframe = 0; // if not current, this ent isn't in the frame

  trailcount = 0; // for diminishing grenade trails
  lerp_origin: Vec3 = vec3(); // for trails (variable hz)

  fly_stoptime = 0;
}

export const MAX_CLIENTWEAPONMODELS = 20; // PGM -- upped from 16 to fit the chainfist vwep

export class ClientinfoT {
  name = ""; // MAX_QPATH
  cinfo = ""; // MAX_QPATH
  skin: ImageS | null = null;
  icon: ImageS | null = null;
  iconname = ""; // MAX_QPATH
  model: ModelS | null = null;
  weaponmodel: (ModelS | null)[] = new Array(MAX_CLIENTWEAPONMODELS).fill(null);
}

export const cl_weaponmodels: string[] = new Array(MAX_CLIENTWEAPONMODELS).fill(""); // MAX_QPATH each
export let num_cl_weaponmodels = 0;
export function setNumClWeaponmodels(v: number): void {
  num_cl_weaponmodels = v;
}

export const CMD_BACKUP = 64; // allow a lot of command backups for very fast systems

// ---------------------------------------------------------------------------
// Weapon-wheel/carousel state -- q2repro's src/client/client.h:157-207,
// 404-447 (cl_wheel_icon_t, cl_wheel_weapon_t, cl_wheel_ammo_t,
// cl_wheel_powerup_t, cl_wheel_state_t, cl_wheel_slot_t, and the client_
// state_t.wheel_data/carousel/wheel members). Real logic lives in
// src/client/cl_wheel.ts (wheel.c's port); these are just the plain-data
// shapes + the `cl.wheel_data`/`cl.carousel`/`cl.wheel` fields themselves,
// placed here (not in cl_wheel.ts) so `ClStateT.clear()` below can reset
// them the same field-by-field way it resets every other `cl.*` member --
// matching client.h's "the client_state_t structure is wiped completely at
// every server map change" comment on the struct itself. Plain interfaces
// (not classes) throughout: no runtime hoisting concerns, and every field
// is a number/string/boolean/array -- no nested class identity to preserve.
// ---------------------------------------------------------------------------

// cl_wheel_icon_t (client.h:157-161). `wheel`/`selected` are DRAW-TIME PIC
// PATHS in this port, not qhandle_t handles: RefExports draws pics by name
// (ref.ts's DrawPic/DrawStretchPic/DrawColorPic all take a `name: string`,
// there is no "resolve to a handle up front" step for 2D pics anywhere else
// in this port -- see host.ts's kfont/SCR_DrawBind code for the identical
// convention). `main` (the plain non-wheel icon, used as CL_LoadWheelIcons'
// own fallback-of-last-resort) is just the raw CS_IMAGES configstring text
// for the icon, no "wheel/" prefix -- see cl_wheel.ts's loadWheelIcon.
export interface WheelIconT {
  main: string;
  wheel: string;
  selected: string;
}

// cl_wheel_weapon_t (client.h:163-172).
export interface WheelWeaponT {
  item_index: number;
  icons: WheelIconT;
  ammo_index: number; // -1 == no ammo requirement
  min_ammo: number;
  sort_id: number;
  quantity_warn: number;
  is_powerup: boolean;
  can_drop: boolean;
}

// cl_wheel_ammo_t (client.h:174-177).
export interface WheelAmmoT {
  item_index: number;
  icons: WheelIconT;
}

// cl_wheel_powerup_t (client.h:179-186).
export interface WheelPowerupT {
  item_index: number;
  icons: WheelIconT;
  sort_id: number;
  ammo_index: number;
  is_toggle: boolean;
  can_drop: boolean;
}

// client_state_t.wheel_data (client.h:404-414): the static per-item tables
// parsed from the CS_WHEEL_WEAPONS/CS_WHEEL_AMMO/CS_WHEEL_POWERUPS
// configstring blocks (cs_remap.ts's csr.wheelweapons/wheelammo/
// wheelpowerups). cl_wheel.ts's own file header documents where the parse
// happens (lazily, from cl.configstrings -- see that file for why there is
// no CL_ParseConfigString-time hook in this port).
export interface WheelDataT {
  weapons: WheelWeaponT[];
  num_weapons: number;
  ammo: WheelAmmoT[];
  num_ammo: number;
  powerups: WheelPowerupT[];
  num_powerups: number;
}

export function newWheelDataT(): WheelDataT {
  return { weapons: [], num_weapons: 0, ammo: [], num_ammo: 0, powerups: [], num_powerups: 0 };
}

// cl_wheel_state_t (client.h:188-192).
export enum WheelStateT {
  WHEEL_CLOSED = 0, // release holster
  WHEEL_CLOSING = 1, // do not draw or process, but keep holster held
  WHEEL_OPEN = 2, // draw & process + holster
}

// client_state_t.carousel's anonymous slot struct (client.h:422-426).
export interface CarouselSlotT {
  has_ammo: boolean;
  data_id: number;
  item_index: number;
}

// client_state_t.carousel (client.h:417-428).
export interface CarouselT {
  state: WheelStateT;
  close_time: number; // cls.realtime-scale timestamp (com_localTime3 in the C source)
  selected: number; // item_index of the selected slot, -1 == none
  slots: CarouselSlotT[];
  num_slots: number;
}

export function newCarouselT(): CarouselT {
  return { state: WheelStateT.WHEEL_CLOSED, close_time: 0, selected: -1, slots: [], num_slots: 0 };
}

// cl_wheel_slot_t (client.h:194-207). `dir` is a plain 2-tuple (this port's
// Vec2-shaped state elsewhere uses plain number[] too -- no shared Vec2
// class exists the way shared/math.ts's Vec3 does).
export interface WheelSlotT {
  has_item: boolean;
  is_powerup: boolean;
  has_ammo: boolean;
  data_id: number;
  item_index: number;
  sort_id: number;
  icons: WheelIconT | null;
  // cached per-frame data (wheel.c's CL_Wheel_Update)
  angle: number;
  dir: [number, number];
  dot: number;
}

// client_state_t.wheel (client.h:430-447).
export interface WheelT {
  state: WheelStateT;
  position: [number, number];
  distance: number;
  dir: [number, number];
  is_powerup_wheel: boolean;
  timer: number;
  timescale: number;
  selected: number; // slot INDEX (not item_index -- matches wheel.c's own convention), -1 == none
  deselect_time: number;
  slots: WheelSlotT[];
  num_slots: number;
  slice_deg: number;
  slice_sin: number;
}

export function newWheelT(): WheelT {
  return {
    state: WheelStateT.WHEEL_CLOSED,
    position: [0, 0],
    distance: 0,
    dir: [0, 0],
    is_powerup_wheel: false,
    timer: 0,
    timescale: 1,
    selected: -1,
    deselect_time: 0,
    slots: [],
    num_slots: 0,
    slice_deg: 0,
    slice_sin: 0,
  };
}

// client_state_t.weapon.muzzle (q2repro client.h:386-397): first-person
// view-weapon muzzle-flash MODEL state. Written by CL_AddWeaponMuzzleFX
// (q2repro tent.c:428-448) for the LOCAL player's shots only; consumed by
// CL_AddViewWeapon (q2repro entities.c:1320-1349) to append a short-lived
// flash model to the view-weapon's V_AddEntity pass.
//
// DEVIATION (minimal-state ruling): the C's outer `weapon` struct also
// carries frame/last_frame/server_time -- the KEX view-model gunframe-lerp
// fields (entities.c:1272-1286) that replace the classic ps.gunframe lerp
// with a servertime-based one gated on ps.gunrate. This port's
// CL_AddViewWeapon (cl_ents.ts) still lerps the classic way directly from
// ps.gunframe/ops.gunframe, so those fields have no consumer here; adding
// them is a separate follow-up (needs PlayerStateT.gunrate, out of this
// unit's territory), not silently dropped.
export interface WeaponMuzzleT {
  model: ModelS | null; // qhandle_t; 0 in C == null here
  time: number; // cl.frame.servertime-scale (mirrors cl_tent.ts's cl.servertime->cl.frame.servertime mapping); compared against cl.time on read, same idiom as cl_tent.ts's ex_mflash 50ms gate
  roll: number;
  scale: number;
  offset: Vec3;
}

export interface ClWeaponT {
  muzzle: WeaponMuzzleT;
}

export function newClWeaponT(): ClWeaponT {
  return { muzzle: { model: null, time: 0, roll: 0, scale: 0, offset: vec3() } };
}

//
// the client_state_t structure is wiped completely at every server map
// change -- ported as ClStateT (see naming ruling above)
//
export class ClStateT {
  timeoutcount = 0;

  timedemo_frames = 0;
  timedemo_start = 0;

  refresh_prepped = false; // false if on new level or new ref dll
  sound_prepped = false; // ambient sounds can start
  force_refdef = false; // vid has changed, so we can't use a paused refdef

  parse_entities = 0; // index (not anded off) into cl_parse_entities[]

  cmd: UsercmdT = new UsercmdT();
  cmds: UsercmdT[] = Array.from({ length: CMD_BACKUP }, () => new UsercmdT()); // each message will send several old cmds
  cmd_time: Int32Array = new Int32Array(CMD_BACKUP); // time sent, for calculating pings
  predicted_origins: Int16Array[] = Array.from({ length: CMD_BACKUP }, () => new Int16Array(3)); // for debug comparing against server

  predicted_step = 0; // for stair up smoothing
  predicted_step_time = 0; // unsigned

  predicted_origin: Vec3 = vec3(); // generated by CL_PredictMovement
  predicted_angles: Vec3 = vec3();
  prediction_error: Vec3 = vec3();

  // [Paril-KEX] re-release eye-height smoothing -- q2repro client/client.h:
  // 255-257 (`int8_t current_viewheight; int8_t prev_viewheight; int
  // viewheight_change_time;`). The re-release keeps eye height out of
  // `viewoffset` and ships it as ps.pmove.viewheight instead, so the client
  // adds it to refdef.vieworg itself, easing crouch/stand transitions over
  // 100ms (entities.c:1528-1536 records the change, :1601-1610 applies it).
  // All three stay 0 on vanilla-family servers, which never set the field.
  current_viewheight = 0; // int8_t
  prev_viewheight = 0; // int8_t
  viewheight_change_time = 0; // cl.time when a viewheight change was noticed

  frame: FrameT = new FrameT(); // received from server
  surpressCount = 0; // number of messages rate supressed
  frames: FrameT[] = Array.from({ length: UPDATE_BACKUP }, () => new FrameT());

  // the client maintains its own idea of view angles, which are sent to
  // the server each frame. It is cleared to 0 upon entering each level.
  // the server sends a delta each frame which is added to the locally
  // tracked view angles to account for standing on rotating objects, and
  // teleport direction changes
  viewangles: Vec3 = vec3();

  time = 0; // this is the time value that the client is rendering at, always <= cls.realtime
  lerpfrac = 0; // between oldframe and frame

  refdef: RefdefT = new RefdefT();

  v_forward: Vec3 = vec3();
  v_right: Vec3 = vec3();
  v_up: Vec3 = vec3(); // set when refdef.angles is set

  //
  // transient data from server
  //
  layout = ""; // general 2D overlay, char[1024]
  inventory: Int32Array = new Int32Array(MAX_ITEMS);

  //
  // non-gameserver information
  // FIXME: move this cinematic stuff into the cin_t structure
  //
  cinematic_file: number | null = null; // FILE*
  cinematictime = 0; // cls.realtime for first cinematic frame
  cinematicframe = 0;
  cinematicpalette: Uint8Array = new Uint8Array(768);
  cinematicpalette_active = false;

  //
  // server state information
  //
  attractloop = false; // running the attract loop, any key will menu
  servercount = 0; // server identification for prespawns
  gamedir = ""; // MAX_QPATH
  playernum = 0;

  // Sized at the widest known family's configstring count (CS_REMAP_RERELEASE
  // .end / MAX_*_WIDE from cs_remap.ts), not this connection's cls.csr: this
  // mirrors server.ts's identical sv.configstrings sizing rationale (see that
  // file's comment) -- a client that connects to a classic (protocol 34)
  // server after having connected to a kex one (or vice versa) must never
  // carry over an undersized array from the previous connection's family.
  // Index math everywhere else uses cls.csr.*, never these arrays' raw
  // .length. [MAX_CONFIGSTRINGS_WIDE][CS_MAX_STRING_LENGTH_WIDE]
  configstrings: string[] = new Array(CS_REMAP_RERELEASE.end).fill("");

  //
  // locally derived information from server state
  //
  model_draw: (ModelS | null)[] = new Array(MAX_MODELS_WIDE).fill(null);
  model_clip: (CmodelT | null)[] = new Array(MAX_MODELS_WIDE).fill(null);

  sound_precache: (SfxT | null)[] = new Array(MAX_SOUNDS_WIDE).fill(null);
  image_precache: (ImageS | null)[] = new Array(MAX_IMAGES_WIDE).fill(null);

  clientinfo: ClientinfoT[] = Array.from({ length: MAX_CLIENTS }, () => new ClientinfoT());
  baseclientinfo: ClientinfoT = new ClientinfoT();

  // client_state_t.shadowdefs[MAX_SHADOW_LIGHTS] -- task #25 (v1.1.0).
  // Sized at the wide family's limit for the same reason `configstrings`
  // above is (a client that reconnects under a different family must never
  // carry over an undersized array).
  shadowdefs: ShadowLightDefT[] = Array.from({ length: MAX_SHADOW_LIGHTS_WIDE }, () => new ShadowLightDefT());

  // client_state_t.wheel_data/carousel/wheel (client.h:404-447) -- see the
  // WheelDataT/CarouselT/WheelT doc comments above this class.
  wheel_data: WheelDataT = newWheelDataT();
  carousel: CarouselT = newCarouselT();
  wheel: WheelT = newWheelT();

  // client_state_t.weapon (client.h:386-397) -- see WeaponMuzzleT/ClWeaponT
  // doc comments above for what's ported and what's cut.
  weapon: ClWeaponT = newClWeaponT();

  // client_state_t.weapon_lock_time (client.h, set by CL_Carousel_Input --
  // wheel.c:202) -- briefly suppresses +attack right after a carousel weapon
  // switch. `cl.time`-scale (paused-game-aware), NOT cls.realtime-scale like
  // carousel.close_time/wheel timers above -- matches wheel.c's own use of
  // `cl.time` (not com_localTime3) for this one field.
  weapon_lock_time = 0;

  // mirrors `memset(&cl, 0, sizeof(client_state_t))` (CL_ClearState)
  clear(): void {
    this.timeoutcount = 0;
    this.timedemo_frames = 0;
    this.timedemo_start = 0;
    this.refresh_prepped = false;
    this.sound_prepped = false;
    this.force_refdef = false;
    this.parse_entities = 0;
    this.cmd = new UsercmdT();
    this.cmds = Array.from({ length: CMD_BACKUP }, () => new UsercmdT());
    this.cmd_time = new Int32Array(CMD_BACKUP);
    this.predicted_origins = Array.from({ length: CMD_BACKUP }, () => new Int16Array(3));
    this.predicted_step = 0;
    this.predicted_step_time = 0;
    this.current_viewheight = 0;
    this.prev_viewheight = 0;
    this.viewheight_change_time = 0;
    this.predicted_origin = vec3();
    this.predicted_angles = vec3();
    this.prediction_error = vec3();
    this.frame = new FrameT();
    this.surpressCount = 0;
    this.frames = Array.from({ length: UPDATE_BACKUP }, () => new FrameT());
    this.viewangles = vec3();
    this.time = 0;
    this.lerpfrac = 0;
    this.refdef = new RefdefT();
    this.v_forward = vec3();
    this.v_right = vec3();
    this.v_up = vec3();
    this.layout = "";
    this.inventory = new Int32Array(MAX_ITEMS);
    this.cinematic_file = null;
    this.cinematictime = 0;
    this.cinematicframe = 0;
    this.cinematicpalette = new Uint8Array(768);
    this.cinematicpalette_active = false;
    this.attractloop = false;
    this.servercount = 0;
    this.gamedir = "";
    this.playernum = 0;
    this.configstrings = new Array(CS_REMAP_RERELEASE.end).fill("");
    this.model_draw = new Array(MAX_MODELS_WIDE).fill(null);
    this.model_clip = new Array(MAX_MODELS_WIDE).fill(null);
    this.sound_precache = new Array(MAX_SOUNDS_WIDE).fill(null);
    this.image_precache = new Array(MAX_IMAGES_WIDE).fill(null);
    this.shadowdefs = Array.from({ length: MAX_SHADOW_LIGHTS_WIDE }, () => new ShadowLightDefT());
    this.clientinfo = Array.from({ length: MAX_CLIENTS }, () => new ClientinfoT());
    this.baseclientinfo = new ClientinfoT();
    this.wheel_data = newWheelDataT();
    this.carousel = newCarouselT();
    this.wheel = newWheelT();
    this.weapon = newClWeaponT();
    this.weapon_lock_time = 0;
  }
}

export const cl: ClStateT = new ClStateT();

/*
==================================================================
the client_static_t structure is persistant through an arbitrary number
of server connections -- ported as ClStaticT (see naming ruling above)
==================================================================
*/

export enum ConnstateT {
  ca_uninitialized,
  ca_disconnected, // not talking to a server
  ca_connecting, // sending request packets to the server
  ca_connected, // netchan_t established, waiting for svc_serverdata
  ca_active, // game views should be displayed
}

export enum DltypeT {
  dl_none,
  dl_model,
  dl_sound,
  dl_skin,
  dl_single,
} // download type

export enum KeydestT {
  key_game,
  key_console,
  key_message,
  key_menu,
}

export class ClStaticT {
  state: ConnstateT = ConnstateT.ca_uninitialized;
  key_dest: KeydestT = KeydestT.key_game;

  framecount = 0;
  realtime = 0; // always increasing, no clamping, etc
  frametime = 0; // seconds since last frame

  // screen rendering information
  disable_screen = 0; // showing loading plaque between levels or changing rendering dlls; if time gets > 30 seconds ahead, break it
  disable_servercount = 0; // when we receive a frame and cl.servercount > cls.disable_servercount, clear disable_screen

  // connection information
  servername = ""; // name of server from original connect, MAX_OSPATH
  connect_time = 0; // for connection retransmits

  quakePort = 0; // a 16 bit value that allows quake servers to work around address translating routers
  netchan: NetchanT = new NetchanT();
  serverProtocol = 0; // in case we are doing some kind of version hack

  // ARCHITECTURE.md "Protocol layer" / .orch/phase5-design.md step 1: the
  // active wire-encoding codec (qcommon/protocol/codec.ts's ProtocolCodec).
  // Lives on ClStaticT (survives level changes, like serverProtocol just
  // above) rather than ClStateT, mirroring server.ts's svs.codec placement
  // and the same server-wide-not-per-client simplification documented there.
  codec: ProtocolCodec = VANILLA_CODEC;

  // The active configstring-index layout (shared/cs_remap.ts's CsRemapT),
  // selected alongside `codec` at CL_ParseServerData time (cl_parse.ts) --
  // mirrors server.ts's svs.csr placement/lifecycle exactly, including
  // resetting to CS_REMAP_OLD in clear() below (server.ts's own comment:
  // "every csr.end/csr.models/etc bound momentarily wrong" between clears).
  csr: CsRemapT = CS_REMAP_OLD;

  // Which GAME MODULE the connected server is running, as distinct from which
  // configstring layout/wire protocol it speaks (`csr`/`codec` above).
  //
  // These used to be the same question -- the wide layout only ever meant the
  // rerelease module -- and two client decisions were keyed off `csr ===
  // CS_REMAP_RERELEASE` because of it: which monster_flash_offset table
  // CL_ParseMuzzleFlash2 resolves flash numbers through (cl_fx.ts), and which
  // cgame/HUD is activated (cl_parse.ts's CG_SetActiveCgameKind). The engine
  // now also runs the CLASSIC module over the wide layout when a map needs
  // more configstring slots than the classic family has (server-side:
  // sv_init.ts's SV_WidenConfigstringSpace), so that inference no longer
  // holds and both decisions read this field instead. Set by
  // CL_ParseServerData from the protocol number, which is the only signal
  // available before those decisions have to be made -- see qcommon.ts's
  // PROTOCOL_VERSION_RERELEASE_CLASSIC doc comment for why the fact travels
  // as a protocol number.
  //
  // Bounds/limits questions keep reading `csr`: those genuinely are about the
  // layout, and a widened classic session has the wide layout's bounds.
  gameFamily: "classic" | "kex" = "classic";

  challenge = 0; // from the server to use for connecting

  download: number | null = null; // FILE* -- file transfer from server
  downloadtempname = ""; // MAX_OSPATH
  downloadname = ""; // MAX_OSPATH
  downloadnumber = 0;
  downloadtype: DltypeT = DltypeT.dl_none;
  downloadpercent = 0;

  // demo recording info must be here, so it isn't cleared on level change
  demorecording = false;
  demowaiting = false; // don't record until a non-delta message is received
  demofile: number | null = null;

  // KEX demo playback unit (.orch/RESUME.md): true while messages are being
  // pumped from a demo file/buffer rather than a live network connection
  // (src/client/cl_demo.ts). There is no vanilla-v3.19 precedent for this
  // field -- the original client never played demos back itself (see
  // cl_demo.ts's own file header); this mirrors q2repro's own
  // cls.demo.playback flag (demo.c), narrowed to the one thing this port's
  // own callers actually need to know.
  demoplayback = false;

  // mirrors `memset(&cls, 0, sizeof(cls))` less the demo-recording block
  // (CL_Disconnect/CL_ClearState never clear demo state mid-connection)
  clear(): void {
    this.state = ConnstateT.ca_uninitialized;
    this.key_dest = KeydestT.key_game;
    this.framecount = 0;
    this.realtime = 0;
    this.frametime = 0;
    this.disable_screen = 0;
    this.disable_servercount = 0;
    this.servername = "";
    this.connect_time = 0;
    this.quakePort = 0;
    this.netchan = new NetchanT();
    this.serverProtocol = 0;
    this.codec = VANILLA_CODEC;
    this.csr = CS_REMAP_OLD;
    this.gameFamily = "classic";
    this.challenge = 0;
    this.download = null;
    this.downloadtempname = "";
    this.downloadname = "";
    this.downloadnumber = 0;
    this.downloadtype = DltypeT.dl_none;
    this.downloadpercent = 0;
    this.demorecording = false;
    this.demowaiting = false;
    this.demofile = null;
    this.demoplayback = false;
  }
}

export const cls: ClStaticT = new ClStaticT();

//=============================================================================

//
// cvars -- grouped into one mutable holder (mirrors server.ts's
// svClientHolder/sv_game.ts's geHolder pattern) rather than 33 individual
// setter functions, since client.ts owns far more cvars than server.ts's
// handful -- reported deviation from server.ts's per-cvar setter style.
//
export const clCvars: {
  cl_stereo_separation: CvarT | null;
  cl_stereo: CvarT | null;
  cl_gun: CvarT | null;
  cl_add_blend: CvarT | null;
  cl_add_lights: CvarT | null;
  cl_add_particles: CvarT | null;
  cl_add_entities: CvarT | null;
  cl_predict: CvarT | null;
  cl_footsteps: CvarT | null;
  // q2repro src/client/tent.c:1735: `cl_muzzleflashes = Cvar_Get(...)` --
  // gates CL_AddMuzzleFX/CL_AddWeaponMuzzleFX (cl_tent.ts), the rerelease's
  // real muzzle-flash MODEL rendering. Was registered bare (return value
  // discarded) in cl_main.ts pending this consumer; now wired.
  cl_muzzleflashes: CvarT | null;
  cl_noskins: CvarT | null;
  cl_autoskins: CvarT | null;
  cl_upspeed: CvarT | null;
  cl_forwardspeed: CvarT | null;
  cl_sidespeed: CvarT | null;
  cl_yawspeed: CvarT | null;
  cl_pitchspeed: CvarT | null;
  cl_run: CvarT | null;
  cl_anglespeedkey: CvarT | null;
  cl_shownet: CvarT | null;
  cl_showmiss: CvarT | null;
  cl_showclamp: CvarT | null;
  lookspring: CvarT | null;
  lookstrafe: CvarT | null;
  sensitivity: CvarT | null;
  m_pitch: CvarT | null;
  m_yaw: CvarT | null;
  m_forward: CvarT | null;
  m_side: CvarT | null;
  freelook: CvarT | null;
  cl_lightlevel: CvarT | null; // FIXME HACK
  cl_paused: CvarT | null;
  cl_timedemo: CvarT | null;
  cl_vwep: CvarT | null;
  // v1.0.0 wire cluster (task board #23): which protocol number
  // CL_SendConnectPacket requests. Defaults to PROTOCOL_VERSION (34) --
  // matches every existing user's current connect behavior byte-for-byte
  // (the protocol-34 golden suite's "untouched-green" requirement extends to
  // DEFAULT runtime behavior, not just the test suite); set to 35 or 36 to
  // join an R1Q2- or Q2PRO-only community server. Mirrors real Q2PRO
  // clients' own user-facing "protocol" cvar for the identical purpose.
  cl_protocol: CvarT | null;

  // q2repro src/client/effects.c: `cl_shadowlights = Cvar_Get("cl_shadowlights",
  // "1", 0);` -- task #25 (v1.1.0), gates CL_AddShadowLights (cl_fx.ts).
  cl_shadowlights: CvarT | null;
} = {
  cl_stereo_separation: null,
  cl_stereo: null,
  cl_gun: null,
  cl_add_blend: null,
  cl_add_lights: null,
  cl_add_particles: null,
  cl_add_entities: null,
  cl_predict: null,
  cl_footsteps: null,
  cl_muzzleflashes: null,
  cl_noskins: null,
  cl_autoskins: null,
  cl_upspeed: null,
  cl_forwardspeed: null,
  cl_sidespeed: null,
  cl_yawspeed: null,
  cl_pitchspeed: null,
  cl_run: null,
  cl_anglespeedkey: null,
  cl_shownet: null,
  cl_showmiss: null,
  cl_showclamp: null,
  lookspring: null,
  lookstrafe: null,
  sensitivity: null,
  m_pitch: null,
  m_yaw: null,
  m_forward: null,
  m_side: null,
  freelook: null,
  cl_lightlevel: null,
  cl_paused: null,
  cl_timedemo: null,
  cl_vwep: null,
  cl_protocol: null,
  cl_shadowlights: null,
};

export class CdlightT {
  key = 0; // so entities can reuse same entry
  color: Vec3 = vec3();
  origin: Vec3 = vec3();
  radius = 0;
  die = 0; // stop lighting after this time
  decay = 0; // drop this each second
  minlight = 0; // don't add when contributing less
}

// client-side wide-arrays widening unit (v1.0.0 queue item, .orch/followups.md
// "CLIENT-SIDE WIDE ARRAYS"): q2repro's client.h declares `centity_t
// cl_entities[MAX_EDICTS]` where MAX_EDICTS is ALWAYS the wide 8192 constant
// (inc/shared/shared.h:90, unconditional -- the classic family's narrow 1024
// only exists as MAX_EDICTS_OLD, a separate constant q2repro's own client
// array declarations never use). This mirrors that: cl_entities is allocated
// at the wide ceiling unconditionally, the same way this file's model_draw/
// model_clip/sound_precache/image_precache/configstrings below already are;
// per-connection code bound-checks writes against the ACTIVE family's
// cls.csr.max_edicts (narrower under classic/protocol 34, matching q2repro's
// own runtime `cl.csr.max_edicts` checks in parse.c/entities.c/newfx.c), not
// this array's own length. Previously sized off q_shared.ts's MAX_EDICTS
// (1024, the classic-only constant) -- a real kex-family bug, since a
// baseline or delta for an entity number 1024..8191 indexed past the end of
// a plain 1024-length array, reading back `undefined` and crashing the very
// next `.baseline`/`.current` property access.
export const cl_entities: CentityT[] = Array.from({ length: MAX_EDICTS_WIDE }, () => new CentityT());
export const cl_dlights: CdlightT[] = Array.from({ length: MAX_DLIGHTS }, () => new CdlightT());

// the cl_parse_entities must be large enough to hold UPDATE_BACKUP frames of
// entities, so that when a delta compressed message arrives from the
// server it can be un-deltad from the original
//
// q2repro's inc/common/protocol.h:114-117: MAX_PACKET_ENTITIES_OLD=128 (classic
// wire cap) vs MAX_PACKET_ENTITIES=512 (wide, unconditional compile-time
// constant -- like MAX_EDICTS above, q2repro's client.h always allocates
// against the wide one: `entity_state_t entityStates[MAX_PARSE_ENTITIES]`,
// MAX_PARSE_ENTITIES = MAX_PACKET_ENTITIES * UPDATE_BACKUP = 512*16 = 8192).
// Previously hardcoded to 1024 -- too small to hold even one full wide-family
// frame's worth of packet entities (512) replicated across UPDATE_BACKUP(16)
// history slots without the ring wrapping mid-frame and un-deltaing against
// the wrong entity_state_t.
export const MAX_PACKET_ENTITIES_WIDE = 512;
export const MAX_PARSE_ENTITIES = MAX_PACKET_ENTITIES_WIDE * UPDATE_BACKUP;
export const cl_parse_entities: EntityStateT[] = Array.from({ length: MAX_PARSE_ENTITIES }, () => new EntityStateT());

//=============================================================================

// net_from/net_message live in qcommon/net_chan.ts (their true owning
// module per PORTING.md); re-exported here since client.h externs them for
// every client/*.c file.
export { net_from, net_message } from "../qcommon/net_chan";

//ROGUE
export class ClSustainT {
  id = 0;
  type = 0;
  endtime = 0;
  nextthink = 0;
  thinkinterval = 0;
  org: Vec3 = vec3();
  dir: Vec3 = vec3();
  color = 0;
  count = 0;
  magnitude = 0;
  think: ((self: ClSustainT) => void) | null = null;
}

export const MAX_SUSTAINS = 32;

//=================================================

// PGM
export class CparticleT {
  next: CparticleT | null = null;

  time = 0;

  org: Vec3 = vec3();
  vel: Vec3 = vec3();
  accel: Vec3 = vec3();
  color = 0;
  colorvel = 0;
  alpha = 0;
  alphavel = 0;
}

export const PARTICLE_GRAVITY = 40;
export const BLASTER_PARTICLE_COLOR = 0xe0;
// PMM
export const INSTANT_PARTICLE = -10000.0;

//=================================================

export class KbuttonT {
  down: Int32Array = new Int32Array(2); // key nums holding it down
  downtime = 0; // unsigned -- msec timestamp
  msec = 0; // unsigned -- msec down this frame
  state = 0;
}

// Declared extern in client.h under the "cl_input" section; actually
// defined in cl_input.c (confirmed by grep). Kept here per this header
// module's ownership of every client.h extern (see file banner).
export const in_mlook: KbuttonT = new KbuttonT();
export const in_klook: KbuttonT = new KbuttonT();
export const in_strafe: KbuttonT = new KbuttonT();
export const in_speed: KbuttonT = new KbuttonT();

//
// cl_view.c
//
// Declared extern in client.h under the "cl_view.c" section and confirmed
// (by grep) to be defined there.
export let gun_frame = 0;
export let gun_model: ModelS | null = null;
export function setGunFrame(v: number): void {
  gun_frame = v;
}
export function setGunModel(v: ModelS | null): void {
  gun_model = v;
}

//
// cl_parse.c
//
export const svc_strings: string[] = new Array(256).fill("");

//
// cl_main
//
// interface to the refresh dll -- unusable until a real RefExports is
// constructed (ref_gl is not ported per PORTING.md), but typed so the
// client .c stubs compile against a faithful surface.
export let re: RefExports | null = null;
export function setRe(v: RefExports | null): void {
  re = v;
}

// MAX_QPATH re-exported purely so callers documenting client_state_t's
// char-array field sizes (name/cinfo/iconname/gamedir/servername/etc.)
// have a single source of truth without a second import elsewhere.
export const CLIENT_STRING_MAX_LEN = MAX_QPATH;
