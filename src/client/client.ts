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
  MAX_EDICTS,
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
import { type CsRemapT, CS_REMAP_OLD, CS_REMAP_RERELEASE, MAX_MODELS_WIDE, MAX_SOUNDS_WIDE, MAX_IMAGES_WIDE } from "../shared/cs_remap";

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
    this.clientinfo = Array.from({ length: MAX_CLIENTS }, () => new ClientinfoT());
    this.baseclientinfo = new ClientinfoT();
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

export const cl_entities: CentityT[] = Array.from({ length: MAX_EDICTS }, () => new CentityT());
export const cl_dlights: CdlightT[] = Array.from({ length: MAX_DLIGHTS }, () => new CdlightT());

// the cl_parse_entities must be large enough to hold UPDATE_BACKUP frames of
// entities, so that when a delta compressed message arrives from the
// server it can be un-deltad from the original
export const MAX_PARSE_ENTITIES = 1024;
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
