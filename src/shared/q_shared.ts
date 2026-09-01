/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from game/q_shared.h and game/q_shared.c (GNU GPL v2 or later).

q_shared.h -- included first by ALL program modules
*/

import type { Vec3 } from "./math";

// byte is `unsigned char` in C; kept as a documentation alias only, no runtime meaning.
export type Byte = number;

// angle indexes
export const PITCH = 0; // up / down
export const YAW = 1; // left / right
export const ROLL = 2; // fall over

export const MAX_STRING_CHARS = 1024; // max length of a string passed to Cmd_TokenizeString
export const MAX_STRING_TOKENS = 80; // max tokens resulting from Cmd_TokenizeString
export const MAX_TOKEN_CHARS = 128; // max length of an individual token

export const MAX_QPATH = 64; // max length of a quake game pathname
export const MAX_OSPATH = 128; // max length of a filesystem pathname

//
// per-level limits
//
export const MAX_CLIENTS = 256; // absolute limit
export const MAX_EDICTS = 1024; // must change protocol to increase more
export const MAX_LIGHTSTYLES = 256;
export const MAX_MODELS = 256; // these are sent over the net as bytes
export const MAX_SOUNDS = 256; // so they cannot be blindly increased
export const MAX_IMAGES = 256;
export const MAX_ITEMS = 256;
export const MAX_GENERAL = MAX_CLIENTS * 2; // general config strings

// game print flags
export const PRINT_LOW = 0; // pickup messages
export const PRINT_MEDIUM = 1; // death messages
export const PRINT_HIGH = 2; // critical messages
export const PRINT_CHAT = 3; // chat messages

export const ERR_FATAL = 0; // exit the entire game with a popup window
export const ERR_DROP = 1; // print to console and disconnect from game
export const ERR_DISCONNECT = 2; // don't kill server

export const PRINT_ALL = 0;
export const PRINT_DEVELOPER = 1; // only print when "developer 1"
export const PRINT_ALERT = 2;

// destination class for gi.multicast()
export enum MulticastT {
  MULTICAST_ALL,
  MULTICAST_PHS,
  MULTICAST_PVS,
  MULTICAST_ALL_R,
  MULTICAST_PHS_R,
  MULTICAST_PVS_R,
}

/*
==============================================================

MATHLIB constants (see math.ts for vec3(), the Vector helpers, and AngleVectors)

==============================================================
*/

export type VecT = number;
export type Fixed4T = number;
export type Fixed8T = number;
export type Fixed16T = number;

export const M_PI = 3.14159265358979323846; // matches value in gcc v2 math.h

export const nanmask = 255 << 23;

const nanBuf = new ArrayBuffer(4);
const nanFloat = new Float32Array(nanBuf);
const nanInt = new Int32Array(nanBuf);

// IS_NAN(x) macro
export function IS_NAN(x: number): boolean {
  nanFloat[0] = x;
  return (nanInt[0] & nanmask) === nanmask;
}

// portable path: `#define Q_ftol(f) ((long)(f))`; the x86 asm variant is dropped
// (see PORTING.md idiom map — take the portable little-endian C path).
export function Q_ftol(f: number): number {
  return Math.trunc(f);
}

//=============================================
// COLLISION DETECTION

// lower bits are stronger, and will eat weaker brushes completely
export const CONTENTS_SOLID = 1; // an eye is never valid in a solid
export const CONTENTS_WINDOW = 2; // translucent, but not watery
export const CONTENTS_AUX = 4;
export const CONTENTS_LAVA = 8;
export const CONTENTS_SLIME = 16;
export const CONTENTS_WATER = 32;
export const CONTENTS_MIST = 64;
export const LAST_VISIBLE_CONTENTS = 64;

// remaining contents are non-visible, and don't eat brushes
export const CONTENTS_AREAPORTAL = 0x8000;

export const CONTENTS_PLAYERCLIP = 0x10000;
export const CONTENTS_MONSTERCLIP = 0x20000;

// currents can be added to any other contents, and may be mixed
export const CONTENTS_CURRENT_0 = 0x40000;
export const CONTENTS_CURRENT_90 = 0x80000;
export const CONTENTS_CURRENT_180 = 0x100000;
export const CONTENTS_CURRENT_270 = 0x200000;
export const CONTENTS_CURRENT_UP = 0x400000;
export const CONTENTS_CURRENT_DOWN = 0x800000;

export const CONTENTS_ORIGIN = 0x1000000; // removed before bsping an entity

export const CONTENTS_MONSTER = 0x2000000; // should never be on a brush, only in game
export const CONTENTS_DEADMONSTER = 0x4000000;
export const CONTENTS_DETAIL = 0x8000000; // brushes to be added after vis leafs
export const CONTENTS_TRANSLUCENT = 0x10000000; // auto set if any surface has trans
export const CONTENTS_LADDER = 0x20000000;

export const SURF_LIGHT = 0x1; // value will hold the light strength
export const SURF_SLICK = 0x2; // effects game physics
export const SURF_SKY = 0x4; // don't draw, but add to skybox
export const SURF_WARP = 0x8; // turbulent water warp
export const SURF_TRANS33 = 0x10;
export const SURF_TRANS66 = 0x20;
export const SURF_FLOWING = 0x40; // scroll towards angle
export const SURF_NODRAW = 0x80; // don't bother referencing the texture

// content masks
export const MASK_ALL = -1;
export const MASK_SOLID = CONTENTS_SOLID | CONTENTS_WINDOW;
export const MASK_PLAYERSOLID = CONTENTS_SOLID | CONTENTS_PLAYERCLIP | CONTENTS_WINDOW | CONTENTS_MONSTER;
export const MASK_DEADSOLID = CONTENTS_SOLID | CONTENTS_PLAYERCLIP | CONTENTS_WINDOW;
export const MASK_MONSTERSOLID = CONTENTS_SOLID | CONTENTS_MONSTERCLIP | CONTENTS_WINDOW | CONTENTS_MONSTER;
export const MASK_WATER = CONTENTS_WATER | CONTENTS_LAVA | CONTENTS_SLIME;
export const MASK_OPAQUE = CONTENTS_SOLID | CONTENTS_SLIME | CONTENTS_LAVA;
export const MASK_SHOT = CONTENTS_SOLID | CONTENTS_MONSTER | CONTENTS_WINDOW | CONTENTS_DEADMONSTER;
export const MASK_CURRENT =
  CONTENTS_CURRENT_0 |
  CONTENTS_CURRENT_90 |
  CONTENTS_CURRENT_180 |
  CONTENTS_CURRENT_270 |
  CONTENTS_CURRENT_UP |
  CONTENTS_CURRENT_DOWN;

// gi.BoxEdicts() can return a list of either solid or trigger entities
export const AREA_SOLID = 1;
export const AREA_TRIGGERS = 2;

// plane_t structure. `pad[2]` and the CPLANE_* struct-offset constants are omitted:
// they exist only to support the dropped x86 asm implementation of BoxOnPlaneSide
// in q_shared.c and are not referenced by any other portable C code.
export class CplaneT {
  normal: Vec3 = new Float32Array(3);
  dist = 0;
  type = 0; // for fast side tests
  signbits = 0; // signx + (signy<<1) + (signz<<1)
}

export class CmodelT {
  mins: Vec3 = new Float32Array(3);
  maxs: Vec3 = new Float32Array(3);
  origin: Vec3 = new Float32Array(3); // for sounds or lights
  headnode = 0;
}

export class CsurfaceT {
  name = "";
  flags = 0;
  value = 0;
  // [Paril-KEX] q2repro's csurface_t.material (inc/shared/shared.h: `char
  // material[16]`) -- resolved from "textures/<name>.mat" by
  // cmodel.ts's CMod_LoadSurfaces (see that function's own comment; ported
  // from q2repro's src/common/bsp.c BSP_LoadMaterials, which does the same
  // resolution for the client's cl.bsp so retail's footstep/impact sounds
  // can key off it -- this port resolves it on the server-side collision
  // model instead, since that is what feeds the kex game import boundary's
  // trace surfaces, per this port's own material unit). Empty string when
  // unresolved (no .mat file, "default" material, or an invalid file
  // content), matching the C field's zeroed-buffer default.
  material = "";
}

// used internally due to name len probs //ZOID
export class MapsurfaceT {
  c: CsurfaceT = new CsurfaceT();
  rname = "";
}

// a trace is returned when a box is swept through the world.
// `ent`/`groundentity`/`touchents` reference `struct edict_s`, which is only
// forward-declared in q_shared.h; the concrete type lives in the future game
// module (src/game/g_local.ts). Typed `unknown` here to avoid a forward import.
export class TraceT {
  allsolid = false; // if true, plane is not valid
  startsolid = false; // if true, the initial point was in a solid area
  fraction = 0; // time completed, 1.0 = didn't hit anything
  endpos: Vec3 = new Float32Array(3); // final position
  plane: CplaneT = new CplaneT(); // surface normal at impact
  surface: CsurfaceT | null = null; // surface hit
  contents = 0; // contents on other side of surface hit
  ent: unknown = null; // not set by CM_*() functions
  // [Paril-KEX] second-best plane/surface hit when a trace segment crosses
  // two brush sides of the same brush at different entry fractions (q2repro
  // src/common/cmodel.c's CM_ClipBoxToBrush, clipplane[1]/leadside[1]).
  // surface2 is null unless a second side was actually crossed. Typed
  // optional (not just null-defaulted) so the many pre-existing hand-built
  // trace-result object literals across the codebase/test suite (predating
  // this field) don't all need updating -- every real CM_BoxTrace/
  // CM_TransformedBoxTrace result still always sets both via the class's
  // own field initializers below.
  plane2?: CplaneT = new CplaneT();
  surface2?: CsurfaceT | null = null;
}

// pmove_state_t is the information necessary for client side movement prediction
export enum PmTypeT {
  // can accelerate and turn
  PM_NORMAL,
  PM_SPECTATOR,
  // no acceleration or turning
  PM_DEAD,
  PM_GIB, // different bounding box
  PM_FREEZE,

  // -------------------------------------------------------------------------
  // [Paril-KEX] additions -- APPENDED, not interleaved
  // -------------------------------------------------------------------------
  // kexapi/game.ts's KexPmTypeT declares these two between PM_NORMAL and
  // PM_SPECTATOR (PM_NORMAL=0, PM_GRAPPLE=1, PM_NOCLIP=2, PM_SPECTATOR=3,
  // PM_DEAD=4, PM_GIB=5, PM_FREEZE=6). This enum CANNOT adopt that numbering:
  // pm_type travels as a raw byte on every protocol this engine speaks
  // (vanilla.ts/r1q2.ts/q2pro.ts/mvd.ts all `MSG_WriteByte(ps.pmove.pm_type)`),
  // so renumbering PM_SPECTATOR..PM_FREEZE would change protocol-34 bytes for
  // every classic-family game. Appending at 5/6 leaves all five classic
  // members on their historical wire values, which is why nothing in the
  // classic path -- codecs, qcommon/pmove.ts, the vanilla/ctf/xatrix/rogue
  // games -- changes at all: those games never produce these two values.
  //
  // The consequence of appending is that the kex source's ORDINAL tests
  // (`pm_type < PM_DEAD` meaning "alive", `pm_type <= PM_GRAPPLE` meaning
  // "normal or grappling") do not translate literally. Two engine-side sites
  // compare ordinally; grep `pm_type\s*[<>]` to find them:
  //   - client/cl_ents.ts's "alive and steering" check runs for BOTH families
  //     (it reads whatever pm_type the snapshot carried) and is rewritten
  //     below as PM_TypeIsAlive, an explicit membership test.
  //   - qcommon/pmove.ts's `pm.s.pm_type >= PM_DEAD` is vanilla's own line and
  //     is left exactly as vanilla wrote it, because that function is only
  //     ever reached with classic-family values: no classic game module
  //     (game/, ctf/, xatrix/, rogue/) produces 5 or 6, and a kex session's
  //     client predicts through the kex cgame's Pmove instead
  //     (client/cl_pred.ts's family dispatch), never this one.
  //
  // Wire note: protocol 1038 (protocol/q2repro.ts) writes/reads this value as
  // a plain byte, so 5/6 travel end to end with no codec change. Our 1038
  // pm_type byte numbering therefore does NOT match upstream rerelease's
  // (which would send GRAPPLE=1, SPECTATOR=3); it did not match before this
  // change either (we already sent SPECTATOR=1 where upstream sends 3). Making
  // the 1038 byte upstream-exact is a separate change that also has to fix
  // real-demo ingest (test/protocol_kexdemo.test.ts) and is left as a
  // follow-up rather than folded into a prediction unit.
  PM_GRAPPLE = 5, // [Paril-KEX] pull towards velocity, no gravity
  PM_NOCLIP = 6, // [Paril-KEX] noclip as a pm_type, not a movetype
}

/** True for the pm_types the player is still "alive and steering" in --
 *  q2repro's own `pm_type < PM_DEAD` test, written as an explicit membership
 *  test because this enum appends PM_GRAPPLE/PM_NOCLIP instead of
 *  interleaving them (see PmTypeT above). For every classic-family game the
 *  result is identical to the old `< PM_DEAD` comparison: PM_NORMAL and
 *  PM_SPECTATOR true, PM_DEAD/PM_GIB/PM_FREEZE false. */
export function PM_TypeIsAlive(t: PmTypeT): boolean {
  return t === PmTypeT.PM_NORMAL || t === PmTypeT.PM_SPECTATOR || t === PmTypeT.PM_GRAPPLE || t === PmTypeT.PM_NOCLIP;
}

// pmove->pm_flags
export const PMF_DUCKED = 1;
export const PMF_JUMP_HELD = 2;
export const PMF_ON_GROUND = 4;
export const PMF_TIME_WATERJUMP = 8; // pm_time is waterjump
export const PMF_TIME_LAND = 16; // pm_time is time before rejump
export const PMF_TIME_TELEPORT = 32; // pm_time is non-moving time
export const PMF_NO_PREDICTION = 64; // temporarily disables prediction (used for grappling hook)

// this structure needs to be communicated bit-accurate from the server to the
// client to guarantee that prediction stays in sync, so no floats are used.
export class PmoveStateT {
  pm_type: PmTypeT = PmTypeT.PM_NORMAL;
  origin: Int16Array = new Int16Array(3); // 12.3
  velocity: Int16Array = new Int16Array(3); // 12.3
  pm_flags = 0; // ducked, jump_held, etc
  // UNITS ARE FAMILY-DEPENDENT. Classic (protocol 34 / qcommon/pmove.ts):
  // each unit = 8 ms, and the value is a byte on the wire. Rerelease/kex
  // (protocol 1038 / kexgame/p_move.ts): PLAIN MILLISECONDS, compared
  // directly against cmd.msec (p_move.ts:1447-1452, values up to 2048), and
  // carried as a short by protocol/q2repro.ts's PS_M_TIME. Nothing in this
  // engine rescales the field in either direction -- each family's own pmove
  // reads it in its own units, so the client's prediction bridge
  // (client/cgame/host.ts) passes it through verbatim.
  pm_time = 0;
  gravity = 0;
  delta_angles: Int16Array = new Int16Array(3); // add to command angles to get view direction
  // [Paril-KEX] re-release eye height, shared/shared.h:1076 (`int8_t
  // viewheight; // view height, added to origin[2] + viewoffset[2], for
  // crouching`). The re-release game does NOT fold this into `viewoffset`
  // the way vanilla does -- q2repro's own server/entities.c:610-612 says so
  // in as many words ("Rerelease game doesn't include viewheight in
  // viewoffset, vanilla does") -- so it travels as its own wire field
  // (PS_RR_VIEWHEIGHT, protocol/q2repro.ts) and the client adds it to
  // refdef.vieworg itself (client/cl_ents.ts, per q2repro client/
  // entities.c:1601-1610). Stays 0 for every vanilla-family game, whose
  // viewoffset already carries the eye height, so no classic path changes.
  viewheight = 0; // int8_t

  // ---------------------------------------------------------------------
  // KEX-FAMILY FLOAT MIRROR (rerelease game.h:400-412's real pmove_state_t:
  // `vec3_t origin; vec3_t velocity;` -- genuine float, no fixed-point at
  // all; q2repro.c's 1038 wire format matches, transmitting full IEEE-754
  // floats for pm_origin/pm_velocity, q2proto_proto_q2repro.c:2081-2099).
  // `origin`/`velocity` above stay the vanilla/legacy family's 12.3
  // fixed-point Int16Array, untouched, for the classic wire (protocol 34)
  // and qcommon/pmove.ts's own bit-exact PM_SnapPosition-style quantization
  // (that algorithm's short-domain sign/nudge logic is load-bearing, not
  // just a storage width).
  //
  // `originF`/`velocityF` are the kex family's own authoritative carrier:
  // server/bindings/kex.ts's syncPlayerStateKexToEngine writes the kex
  // game's float pmove state here directly (no *8/round/clamp narrowing),
  // protocol/q2repro.ts's 1038 codec reads/writes these directly for the
  // wire (no more short-widen-then-narrow round trip), and
  // client/cgame/host.ts's kexPmoveStateViewFromClassic seeds the client's
  // predicted replay from these instead of widening the (deliberately
  // still-populated, for other family-generic consumers -- sv_ents.ts's PVS
  // origin calc, cl_ents.ts's interpolation teleport check and
  // non-predicting render path, CL_CheckPredictionError's debug compare)
  // Int16 shadow above. This is what eliminates the 12.3
  // quantize-requantize round trip that was destroying PM_StepSlideMove's
  // DIST_EPSILON floor clearance during client-side replay (.orch/
  // followups.md's "FLOAT PMOVE STATE END TO END" item). Float32Array
  // (not plain number[]) so assignment truncates to IEEE-754 single
  // precision exactly like the C `vec3_t`, matching q2proto's own encoding
  // bit-for-bit. Always zero for every vanilla-family game (nothing writes
  // them), matching viewheight's convention above.
  originF: Vec3 = new Float32Array(3);
  velocityF: Vec3 = new Float32Array(3);
}

//
// button bits
//
export const BUTTON_ATTACK = 1;
export const BUTTON_USE = 2;
export const BUTTON_ANY = 128; // any key whatsoever

// usercmd_t is sent to the server each client frame
export class UsercmdT {
  msec = 0;
  buttons = 0;
  angles: Int16Array = new Int16Array(3);
  forwardmove = 0;
  sidemove = 0;
  upmove = 0;
  impulse = 0; // remove?
  lightlevel = 0; // light level the player is standing on
}

export const MAXTOUCH = 32;

// trace/pointcontents are mandatory callbacks (always set by the caller before
// Pmove() runs); default no-op implementations stand in for "uninitialized"
// the way `null` stands in for an uninitialized pointer field elsewhere.
export class PmoveT {
  // state (in / out)
  s: PmoveStateT = new PmoveStateT();

  // command (in)
  cmd: UsercmdT = new UsercmdT();
  snapinitial = false; // if s has been changed outside pmove

  // results (out)
  numtouch = 0;
  touchents: Array<unknown> = new Array<unknown>(MAXTOUCH).fill(null);

  viewangles: Vec3 = new Float32Array(3); // clamped
  viewheight = 0;

  mins: Vec3 = new Float32Array(3);
  maxs: Vec3 = new Float32Array(3); // bounding box size

  groundentity: unknown = null;
  watertype = 0;
  waterlevel = 0;

  // callbacks to test the world
  trace: (start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3) => TraceT = () => new TraceT();
  pointcontents: (point: Vec3) => number = () => 0;
}

// entity_state_t->effects
export const EF_ROTATE = 0x00000001; // rotate (bonus items)
export const EF_GIB = 0x00000002; // leave a trail
export const EF_BLASTER = 0x00000008; // redlight + trail
export const EF_ROCKET = 0x00000010; // redlight + trail
export const EF_GRENADE = 0x00000020;
export const EF_HYPERBLASTER = 0x00000040;
export const EF_BFG = 0x00000080;
export const EF_COLOR_SHELL = 0x00000100;
export const EF_POWERSCREEN = 0x00000200;
export const EF_ANIM01 = 0x00000400; // automatically cycle between frames 0 and 1 at 2 hz
export const EF_ANIM23 = 0x00000800; // automatically cycle between frames 2 and 3 at 2 hz
export const EF_ANIM_ALL = 0x00001000; // automatically cycle through all frames at 2hz
export const EF_ANIM_ALLFAST = 0x00002000; // automatically cycle through all frames at 10hz
export const EF_FLIES = 0x00004000;
export const EF_QUAD = 0x00008000;
export const EF_PENT = 0x00010000;
export const EF_TELEPORTER = 0x00020000; // particle fountain
export const EF_FLAG1 = 0x00040000;
export const EF_FLAG2 = 0x00080000;
// RAFAEL
export const EF_IONRIPPER = 0x00100000;
export const EF_GREENGIB = 0x00200000;
export const EF_BLUEHYPERBLASTER = 0x00400000;
export const EF_SPINNINGLIGHTS = 0x00800000;
export const EF_PLASMA = 0x01000000;
export const EF_TRAP = 0x02000000;
//ROGUE
export const EF_TRACKER = 0x04000000;
export const EF_DOUBLE = 0x08000000;
export const EF_SPHERETRANS = 0x10000000;
export const EF_TAGTRAIL = 0x20000000;
export const EF_HALF_DAMAGE = 0x40000000;
export const EF_TRACKERTRAIL = 0x80000000;

// entity_state_t->renderfx flags
export const RF_MINLIGHT = 1; // allways have some light (viewmodel)
export const RF_VIEWERMODEL = 2; // don't draw through eyes, only mirrors
export const RF_WEAPONMODEL = 4; // only draw through eyes
export const RF_FULLBRIGHT = 8; // allways draw full intensity
export const RF_DEPTHHACK = 16; // for view weapon Z crunching
export const RF_TRANSLUCENT = 32;
export const RF_FRAMELERP = 64;
export const RF_BEAM = 128;
export const RF_CUSTOMSKIN = 256; // skin is an index in image_precache
export const RF_GLOW = 512; // pulse lighting for bonus items
export const RF_SHELL_RED = 1024;
export const RF_SHELL_GREEN = 2048;
export const RF_SHELL_BLUE = 4096;
//ROGUE
// [Paril-KEX] q2repro inc/shared/shared.h:1223 (`BIT(13), used by YQ2`) --
// CL_AddMuzzleFX (cl_tent.ts) sets this on the rerelease's muzzle-flash
// model explosions.
export const RF_NOSHADOW = 8192;
// [Sam-KEX] q2repro inc/shared/shared.h:1224 (`BIT(14), used by KEX`).
// setup_dynamic_light (kexgame/g_misc.ts) stamps this on every shadow-light
// entity, and the server's HAS_EFFECTS test (server.h:754, sv_ents.ts) keeps
// such an entity in the client's frame even though it has no model, no
// effects, no sound and no event -- without that clause the entity is culled
// and CL_AddShadowLights never finds it, so no shadow light ever reaches the
// renderer.
export const RF_CASTSHADOW = 16384;
export const RF_IR_VISIBLE = 0x00008000; // 32768
export const RF_SHELL_DOUBLE = 0x00010000; // 65536
export const RF_SHELL_HALF_DAM = 0x00020000;
export const RF_USE_DISGUISE = 0x00040000;
// [Paril-KEX]/[Sam-KEX] rerelease-only renderfx (rerelease game.h:599-601,
// q2repro inc/shared/shared.h:1235-1236). Both of the entities that set them
// -- SP_target_light (g_target.cpp:1532) and SP_misc_flare (g_misc.cpp:2136)
// -- also set `s.modelindex = 1`, so the client has to consume them before
// the model lookup or they resolve to the world model; see cl_ents.ts's
// CL_AddPacketEntities.
export const RF_CUSTOM_LIGHT = 0x00100000; // s.frame is radius, s.skinnum is packed RGB
export const RF_FLARE = 0x00200000;

// player_state_t->refdef flags
export const RDF_UNDERWATER = 1; // warp the screen as apropriate
export const RDF_NOWORLDMODEL = 2; // used for player configuration screen
//ROGUE
export const RDF_IRGOGGLES = 4;
export const RDF_UVGOGGLES = 8;

//
// muzzle flashes / player effects
//
export const MZ_BLASTER = 0;
export const MZ_MACHINEGUN = 1;
export const MZ_SHOTGUN = 2;
export const MZ_CHAINGUN1 = 3;
export const MZ_CHAINGUN2 = 4;
export const MZ_CHAINGUN3 = 5;
export const MZ_RAILGUN = 6;
export const MZ_ROCKET = 7;
export const MZ_GRENADE = 8;
export const MZ_LOGIN = 9;
export const MZ_LOGOUT = 10;
export const MZ_RESPAWN = 11;
export const MZ_BFG = 12;
export const MZ_SSHOTGUN = 13;
export const MZ_HYPERBLASTER = 14;
export const MZ_ITEMRESPAWN = 15;
// RAFAEL
export const MZ_IONRIPPER = 16;
export const MZ_BLUEHYPERBLASTER = 17;
export const MZ_PHALANX = 18;

// KEX (q2repro inc/shared/shared.h:1287-1289)
export const MZ_BFG2 = 19;
export const MZ_PHALANX2 = 20;

export const MZ_SILENCED = 128; // bit flag ORed with one of the above numbers
//ROGUE
export const MZ_ETF_RIFLE = 30;
export const MZ_UNUSED = 31; // vanilla name for this slot; q2repro's shared.h:1293 renames it MZ_PROX (KEX) -- same numeric value, both kept
export const MZ_PROX = 31; // KEX (q2repro inc/shared/shared.h:1293)
export const MZ_SHOTGUN2 = 32;
export const MZ_HEATBEAM = 33;
export const MZ_BLASTER2 = 34;
export const MZ_TRACKER = 35;
export const MZ_NUKE1 = 36;
export const MZ_NUKE2 = 37;
export const MZ_NUKE4 = 38;
export const MZ_NUKE8 = 39;

//
// monster muzzle flashes
//
export const MZ2_TANK_BLASTER_1 = 1;
export const MZ2_TANK_BLASTER_2 = 2;
export const MZ2_TANK_BLASTER_3 = 3;
export const MZ2_TANK_MACHINEGUN_1 = 4;
export const MZ2_TANK_MACHINEGUN_2 = 5;
export const MZ2_TANK_MACHINEGUN_3 = 6;
export const MZ2_TANK_MACHINEGUN_4 = 7;
export const MZ2_TANK_MACHINEGUN_5 = 8;
export const MZ2_TANK_MACHINEGUN_6 = 9;
export const MZ2_TANK_MACHINEGUN_7 = 10;
export const MZ2_TANK_MACHINEGUN_8 = 11;
export const MZ2_TANK_MACHINEGUN_9 = 12;
export const MZ2_TANK_MACHINEGUN_10 = 13;
export const MZ2_TANK_MACHINEGUN_11 = 14;
export const MZ2_TANK_MACHINEGUN_12 = 15;
export const MZ2_TANK_MACHINEGUN_13 = 16;
export const MZ2_TANK_MACHINEGUN_14 = 17;
export const MZ2_TANK_MACHINEGUN_15 = 18;
export const MZ2_TANK_MACHINEGUN_16 = 19;
export const MZ2_TANK_MACHINEGUN_17 = 20;
export const MZ2_TANK_MACHINEGUN_18 = 21;
export const MZ2_TANK_MACHINEGUN_19 = 22;
export const MZ2_TANK_ROCKET_1 = 23;
export const MZ2_TANK_ROCKET_2 = 24;
export const MZ2_TANK_ROCKET_3 = 25;
export const MZ2_INFANTRY_MACHINEGUN_1 = 26;
export const MZ2_INFANTRY_MACHINEGUN_2 = 27;
export const MZ2_INFANTRY_MACHINEGUN_3 = 28;
export const MZ2_INFANTRY_MACHINEGUN_4 = 29;
export const MZ2_INFANTRY_MACHINEGUN_5 = 30;
export const MZ2_INFANTRY_MACHINEGUN_6 = 31;
export const MZ2_INFANTRY_MACHINEGUN_7 = 32;
export const MZ2_INFANTRY_MACHINEGUN_8 = 33;
export const MZ2_INFANTRY_MACHINEGUN_9 = 34;
export const MZ2_INFANTRY_MACHINEGUN_10 = 35;
export const MZ2_INFANTRY_MACHINEGUN_11 = 36;
export const MZ2_INFANTRY_MACHINEGUN_12 = 37;
export const MZ2_INFANTRY_MACHINEGUN_13 = 38;
export const MZ2_SOLDIER_BLASTER_1 = 39;
export const MZ2_SOLDIER_BLASTER_2 = 40;
export const MZ2_SOLDIER_SHOTGUN_1 = 41;
export const MZ2_SOLDIER_SHOTGUN_2 = 42;
export const MZ2_SOLDIER_MACHINEGUN_1 = 43;
export const MZ2_SOLDIER_MACHINEGUN_2 = 44;
export const MZ2_GUNNER_MACHINEGUN_1 = 45;
export const MZ2_GUNNER_MACHINEGUN_2 = 46;
export const MZ2_GUNNER_MACHINEGUN_3 = 47;
export const MZ2_GUNNER_MACHINEGUN_4 = 48;
export const MZ2_GUNNER_MACHINEGUN_5 = 49;
export const MZ2_GUNNER_MACHINEGUN_6 = 50;
export const MZ2_GUNNER_MACHINEGUN_7 = 51;
export const MZ2_GUNNER_MACHINEGUN_8 = 52;
export const MZ2_GUNNER_GRENADE_1 = 53;
export const MZ2_GUNNER_GRENADE_2 = 54;
export const MZ2_GUNNER_GRENADE_3 = 55;
export const MZ2_GUNNER_GRENADE_4 = 56;
export const MZ2_CHICK_ROCKET_1 = 57;
export const MZ2_FLYER_BLASTER_1 = 58;
export const MZ2_FLYER_BLASTER_2 = 59;
export const MZ2_MEDIC_BLASTER_1 = 60;
export const MZ2_GLADIATOR_RAILGUN_1 = 61;
export const MZ2_HOVER_BLASTER_1 = 62;
export const MZ2_ACTOR_MACHINEGUN_1 = 63;
export const MZ2_SUPERTANK_MACHINEGUN_1 = 64;
export const MZ2_SUPERTANK_MACHINEGUN_2 = 65;
export const MZ2_SUPERTANK_MACHINEGUN_3 = 66;
export const MZ2_SUPERTANK_MACHINEGUN_4 = 67;
export const MZ2_SUPERTANK_MACHINEGUN_5 = 68;
export const MZ2_SUPERTANK_MACHINEGUN_6 = 69;
export const MZ2_SUPERTANK_ROCKET_1 = 70;
export const MZ2_SUPERTANK_ROCKET_2 = 71;
export const MZ2_SUPERTANK_ROCKET_3 = 72;
export const MZ2_BOSS2_MACHINEGUN_L1 = 73;
export const MZ2_BOSS2_MACHINEGUN_L2 = 74;
export const MZ2_BOSS2_MACHINEGUN_L3 = 75;
export const MZ2_BOSS2_MACHINEGUN_L4 = 76;
export const MZ2_BOSS2_MACHINEGUN_L5 = 77;
export const MZ2_BOSS2_ROCKET_1 = 78;
export const MZ2_BOSS2_ROCKET_2 = 79;
export const MZ2_BOSS2_ROCKET_3 = 80;
export const MZ2_BOSS2_ROCKET_4 = 81;
export const MZ2_FLOAT_BLASTER_1 = 82;
export const MZ2_SOLDIER_BLASTER_3 = 83;
export const MZ2_SOLDIER_SHOTGUN_3 = 84;
export const MZ2_SOLDIER_MACHINEGUN_3 = 85;
export const MZ2_SOLDIER_BLASTER_4 = 86;
export const MZ2_SOLDIER_SHOTGUN_4 = 87;
export const MZ2_SOLDIER_MACHINEGUN_4 = 88;
export const MZ2_SOLDIER_BLASTER_5 = 89;
export const MZ2_SOLDIER_SHOTGUN_5 = 90;
export const MZ2_SOLDIER_MACHINEGUN_5 = 91;
export const MZ2_SOLDIER_BLASTER_6 = 92;
export const MZ2_SOLDIER_SHOTGUN_6 = 93;
export const MZ2_SOLDIER_MACHINEGUN_6 = 94;
export const MZ2_SOLDIER_BLASTER_7 = 95;
export const MZ2_SOLDIER_SHOTGUN_7 = 96;
export const MZ2_SOLDIER_MACHINEGUN_7 = 97;
export const MZ2_SOLDIER_BLASTER_8 = 98;
export const MZ2_SOLDIER_SHOTGUN_8 = 99;
export const MZ2_SOLDIER_MACHINEGUN_8 = 100;
// --- Xian shit below ---
export const MZ2_MAKRON_BFG = 101;
export const MZ2_MAKRON_BLASTER_1 = 102;
export const MZ2_MAKRON_BLASTER_2 = 103;
export const MZ2_MAKRON_BLASTER_3 = 104;
export const MZ2_MAKRON_BLASTER_4 = 105;
export const MZ2_MAKRON_BLASTER_5 = 106;
export const MZ2_MAKRON_BLASTER_6 = 107;
export const MZ2_MAKRON_BLASTER_7 = 108;
export const MZ2_MAKRON_BLASTER_8 = 109;
export const MZ2_MAKRON_BLASTER_9 = 110;
export const MZ2_MAKRON_BLASTER_10 = 111;
export const MZ2_MAKRON_BLASTER_11 = 112;
export const MZ2_MAKRON_BLASTER_12 = 113;
export const MZ2_MAKRON_BLASTER_13 = 114;
export const MZ2_MAKRON_BLASTER_14 = 115;
export const MZ2_MAKRON_BLASTER_15 = 116;
export const MZ2_MAKRON_BLASTER_16 = 117;
export const MZ2_MAKRON_BLASTER_17 = 118;
export const MZ2_MAKRON_RAILGUN_1 = 119;
export const MZ2_JORG_MACHINEGUN_L1 = 120;
export const MZ2_JORG_MACHINEGUN_L2 = 121;
export const MZ2_JORG_MACHINEGUN_L3 = 122;
export const MZ2_JORG_MACHINEGUN_L4 = 123;
export const MZ2_JORG_MACHINEGUN_L5 = 124;
export const MZ2_JORG_MACHINEGUN_L6 = 125;
export const MZ2_JORG_MACHINEGUN_R1 = 126;
export const MZ2_JORG_MACHINEGUN_R2 = 127;
export const MZ2_JORG_MACHINEGUN_R3 = 128;
export const MZ2_JORG_MACHINEGUN_R4 = 129;
export const MZ2_JORG_MACHINEGUN_R5 = 130;
export const MZ2_JORG_MACHINEGUN_R6 = 131;
export const MZ2_JORG_BFG_1 = 132;
export const MZ2_BOSS2_MACHINEGUN_R1 = 133;
export const MZ2_BOSS2_MACHINEGUN_R2 = 134;
export const MZ2_BOSS2_MACHINEGUN_R3 = 135;
export const MZ2_BOSS2_MACHINEGUN_R4 = 136;
export const MZ2_BOSS2_MACHINEGUN_R5 = 137;
//ROGUE
export const MZ2_CARRIER_MACHINEGUN_L1 = 138;
export const MZ2_CARRIER_MACHINEGUN_R1 = 139;
export const MZ2_CARRIER_GRENADE = 140;
export const MZ2_TURRET_MACHINEGUN = 141;
export const MZ2_TURRET_ROCKET = 142;
export const MZ2_TURRET_BLASTER = 143;
export const MZ2_STALKER_BLASTER = 144;
export const MZ2_DAEDALUS_BLASTER = 145;
export const MZ2_MEDIC_BLASTER_2 = 146;
export const MZ2_CARRIER_RAILGUN = 147;
export const MZ2_WIDOW_DISRUPTOR = 148;
export const MZ2_WIDOW_BLASTER = 149;
export const MZ2_WIDOW_RAIL = 150;
export const MZ2_WIDOW_PLASMABEAM = 151; // PMM - not used
export const MZ2_CARRIER_MACHINEGUN_L2 = 152;
export const MZ2_CARRIER_MACHINEGUN_R2 = 153;
export const MZ2_WIDOW_RAIL_LEFT = 154;
export const MZ2_WIDOW_RAIL_RIGHT = 155;
export const MZ2_WIDOW_BLASTER_SWEEP1 = 156;
export const MZ2_WIDOW_BLASTER_SWEEP2 = 157;
export const MZ2_WIDOW_BLASTER_SWEEP3 = 158;
export const MZ2_WIDOW_BLASTER_SWEEP4 = 159;
export const MZ2_WIDOW_BLASTER_SWEEP5 = 160;
export const MZ2_WIDOW_BLASTER_SWEEP6 = 161;
export const MZ2_WIDOW_BLASTER_SWEEP7 = 162;
export const MZ2_WIDOW_BLASTER_SWEEP8 = 163;
export const MZ2_WIDOW_BLASTER_SWEEP9 = 164;
export const MZ2_WIDOW_BLASTER_100 = 165;
export const MZ2_WIDOW_BLASTER_90 = 166;
export const MZ2_WIDOW_BLASTER_80 = 167;
export const MZ2_WIDOW_BLASTER_70 = 168;
export const MZ2_WIDOW_BLASTER_60 = 169;
export const MZ2_WIDOW_BLASTER_50 = 170;
export const MZ2_WIDOW_BLASTER_40 = 171;
export const MZ2_WIDOW_BLASTER_30 = 172;
export const MZ2_WIDOW_BLASTER_20 = 173;
export const MZ2_WIDOW_BLASTER_10 = 174;
export const MZ2_WIDOW_BLASTER_0 = 175;
export const MZ2_WIDOW_BLASTER_10L = 176;
export const MZ2_WIDOW_BLASTER_20L = 177;
export const MZ2_WIDOW_BLASTER_30L = 178;
export const MZ2_WIDOW_BLASTER_40L = 179;
export const MZ2_WIDOW_BLASTER_50L = 180;
export const MZ2_WIDOW_BLASTER_60L = 181;
export const MZ2_WIDOW_BLASTER_70L = 182;
export const MZ2_WIDOW_RUN_1 = 183;
export const MZ2_WIDOW_RUN_2 = 184;
export const MZ2_WIDOW_RUN_3 = 185;
export const MZ2_WIDOW_RUN_4 = 186;
export const MZ2_WIDOW_RUN_5 = 187;
export const MZ2_WIDOW_RUN_6 = 188;
export const MZ2_WIDOW_RUN_7 = 189;
export const MZ2_WIDOW_RUN_8 = 190;
export const MZ2_CARRIER_ROCKET_1 = 191;
export const MZ2_CARRIER_ROCKET_2 = 192;
export const MZ2_CARRIER_ROCKET_3 = 193;
export const MZ2_CARRIER_ROCKET_4 = 194;
export const MZ2_WIDOW2_BEAMER_1 = 195;
export const MZ2_WIDOW2_BEAMER_2 = 196;
export const MZ2_WIDOW2_BEAMER_3 = 197;
export const MZ2_WIDOW2_BEAMER_4 = 198;
export const MZ2_WIDOW2_BEAMER_5 = 199;
export const MZ2_WIDOW2_BEAM_SWEEP_1 = 200;
export const MZ2_WIDOW2_BEAM_SWEEP_2 = 201;
export const MZ2_WIDOW2_BEAM_SWEEP_3 = 202;
export const MZ2_WIDOW2_BEAM_SWEEP_4 = 203;
export const MZ2_WIDOW2_BEAM_SWEEP_5 = 204;
export const MZ2_WIDOW2_BEAM_SWEEP_6 = 205;
export const MZ2_WIDOW2_BEAM_SWEEP_7 = 206;
export const MZ2_WIDOW2_BEAM_SWEEP_8 = 207;
export const MZ2_WIDOW2_BEAM_SWEEP_9 = 208;
export const MZ2_WIDOW2_BEAM_SWEEP_10 = 209;
export const MZ2_WIDOW2_BEAM_SWEEP_11 = 210;
// ROGUE

// `extern vec3_t monster_flash_offset[]` — the data table itself is defined in
// game/m_flash.c, a future unit; omitted here (see report).

// temp entity events
export enum TempEventT {
  TE_GUNSHOT,
  TE_BLOOD,
  TE_BLASTER,
  TE_RAILTRAIL,
  TE_SHOTGUN,
  TE_EXPLOSION1,
  TE_EXPLOSION2,
  TE_ROCKET_EXPLOSION,
  TE_GRENADE_EXPLOSION,
  TE_SPARKS,
  TE_SPLASH,
  TE_BUBBLETRAIL,
  TE_SCREEN_SPARKS,
  TE_SHIELD_SPARKS,
  TE_BULLET_SPARKS,
  TE_LASER_SPARKS,
  TE_PARASITE_ATTACK,
  TE_ROCKET_EXPLOSION_WATER,
  TE_GRENADE_EXPLOSION_WATER,
  TE_MEDIC_CABLE_ATTACK,
  TE_BFG_EXPLOSION,
  TE_BFG_BIGEXPLOSION,
  TE_BOSSTPORT, // used as '22' in a map, so DON'T RENUMBER!!!
  TE_BFG_LASER,
  TE_GRAPPLE_CABLE,
  TE_WELDING_SPARKS,
  TE_GREENBLOOD,
  TE_BLUEHYPERBLASTER,
  TE_PLASMA_EXPLOSION,
  TE_TUNNEL_SPARKS,
  //ROGUE
  TE_BLASTER2,
  TE_RAILTRAIL2,
  TE_FLAME,
  TE_LIGHTNING,
  TE_DEBUGTRAIL,
  TE_PLAIN_EXPLOSION,
  TE_FLASHLIGHT,
  TE_FORCEWALL,
  TE_HEATBEAM,
  TE_MONSTER_HEATBEAM,
  TE_STEAM,
  TE_BUBBLETRAIL2,
  TE_MOREBLOOD,
  TE_HEATBEAM_SPARKS,
  TE_HEATBEAM_STEAM,
  TE_CHAINFIST_SMOKE,
  TE_ELECTRIC_SPARKS,
  TE_TRACKER_EXPLOSION,
  TE_TELEPORT_EFFECT,
  TE_DBALL_GOAL,
  TE_WIDOWBEAMOUT,
  TE_NUKEBLAST,
  TE_WIDOWSPLASH,
  TE_EXPLOSION1_BIG,
  TE_EXPLOSION1_NP,
  TE_FLECHETTE,
  //ROGUE
}

export const SPLASH_UNKNOWN = 0;
export const SPLASH_SPARKS = 1;
export const SPLASH_BLUE_WATER = 2;
export const SPLASH_BROWN_WATER = 3;
export const SPLASH_SLIME = 4;
export const SPLASH_LAVA = 5;
export const SPLASH_BLOOD = 6;

// sound channels
// channel 0 never willingly overrides
// other channels (1-7) allways override a playing sound on that channel
export const CHAN_AUTO = 0;
export const CHAN_WEAPON = 1;
export const CHAN_VOICE = 2;
export const CHAN_ITEM = 3;
export const CHAN_BODY = 4;
// [Paril-KEX] q2repro inc/shared/shared.h:1405-1413 -- three more base
// channels added alongside the material-based footstep system (CHAN_AUX is
// unused by anything this port ports yet; CHAN_FOOTSTEP drives
// CL_PlayFootstepSfx in cl_tent.ts; CHAN_AUX3 was previously a literal `7`
// in cl_fx.ts's CL_ParseMuzzleFlash MZ_RAILGUN case pending this addition).
export const CHAN_AUX = 5;
export const CHAN_FOOTSTEP = 6;
export const CHAN_AUX3 = 7;
// modifier flags
export const CHAN_NO_PHS_ADD = 8; // send to all clients, not just ones in PHS (ATTN 0 will also do this)
export const CHAN_RELIABLE = 16; // send by reliable message, not datagram

// sound attenuation values
export const ATTN_NONE = 0; // full volume the entire level
export const ATTN_NORM = 1;
export const ATTN_IDLE = 2;
export const ATTN_STATIC = 3; // diminish very rapidly with distance

// player_state->stats[] indexes
export const STAT_HEALTH_ICON = 0;
export const STAT_HEALTH = 1;
export const STAT_AMMO_ICON = 2;
export const STAT_AMMO = 3;
export const STAT_ARMOR_ICON = 4;
export const STAT_ARMOR = 5;
export const STAT_SELECTED_ICON = 6;
export const STAT_PICKUP_ICON = 7;
export const STAT_PICKUP_STRING = 8;
export const STAT_TIMER_ICON = 9;
export const STAT_TIMER = 10;
export const STAT_HELPICON = 11;
export const STAT_SELECTED_ITEM = 12;
export const STAT_LAYOUTS = 13;
export const STAT_FRAGS = 14;
export const STAT_FLASHES = 15; // cleared each frame, 1 = health, 2 = armor
export const STAT_CHASE = 16;
export const STAT_SPECTATOR = 17;

export const MAX_STATS = 32; // the CLASSIC family's WIRE bound -- vanilla/r1q2/q2pro's
// playerstate delta codecs (qcommon/protocol/vanilla.ts, r1q2.ts, q2pro.ts) encode a
// single 32-bit statbits long over exactly this many stats and never carry more; this
// constant must stay 32 for those three codecs to keep matching their reference wire
// format. It is NOT the storage width of PlayerStateT.stats below -- see MAX_STATS_STORAGE.

// Storage width for PlayerStateT.stats: sized to the WIDEST family this port carries
// (the kex/rerelease family's kexapi/game.ts MAX_STATS=64, matching kexapi's
// KexPlayerStateT.stats exactly) so the engine can hold a full kex playerstate without
// truncating the upper 32 slots -- STAT_WEAPONS_OWNED_1/2 (32/33), STAT_AMMO_INFO_START..
// (34+), STAT_ACTIVE_WHEEL_WEAPON (47), STAT_ACTIVE_WEAPON (53); see
// src/kexgame/p_hud.ts's `PlayerStatT` enum for the full kex-family layout. NOT the
// CLASSIC wire bound above: vanilla/r1q2/q2pro still only read/write slots 0-31
// (MAX_STATS), matching their own 32-bit statbits long -- slots 32-63 simply never
// round-trip over a classic connection, same as the real engines they mirror. The
// rerelease/q2repro-family wire codec (qcommon/protocol/q2repro.ts) reads/writes all
// MAX_STATS_STORAGE slots (a 64-bit statbits mask, matching q2proto_proto_q2repro.c's
// EPS_STATS handling -- see that file's own header for the exact wire format).
export const MAX_STATS_STORAGE = 64;

// dmflags->value flags
export const DF_NO_HEALTH = 0x00000001; // 1
export const DF_NO_ITEMS = 0x00000002; // 2
export const DF_WEAPONS_STAY = 0x00000004; // 4
export const DF_NO_FALLING = 0x00000008; // 8
export const DF_INSTANT_ITEMS = 0x00000010; // 16
export const DF_SAME_LEVEL = 0x00000020; // 32
export const DF_SKINTEAMS = 0x00000040; // 64
export const DF_MODELTEAMS = 0x00000080; // 128
export const DF_NO_FRIENDLY_FIRE = 0x00000100; // 256
export const DF_SPAWN_FARTHEST = 0x00000200; // 512
export const DF_FORCE_RESPAWN = 0x00000400; // 1024
export const DF_NO_ARMOR = 0x00000800; // 2048
export const DF_ALLOW_EXIT = 0x00001000; // 4096
export const DF_INFINITE_AMMO = 0x00002000; // 8192
export const DF_QUAD_DROP = 0x00004000; // 16384
export const DF_FIXED_FOV = 0x00008000; // 32768
// RAFAEL
export const DF_QUADFIRE_DROP = 0x00010000; // 65536
//ROGUE
export const DF_NO_MINES = 0x00020000;
export const DF_NO_STACK_DOUBLE = 0x00040000;
export const DF_NO_NUKES = 0x00080000;
export const DF_NO_SPHERES = 0x00100000;

export const ROGUE_VERSION_ID = 1278;
export const ROGUE_VERSION_STRING = "08/21/1998 Beta 2 for Ensemble";

/*
==========================================================
  ELEMENTS COMMUNICATED ACROSS THE NET
==========================================================
*/

export function ANGLE2SHORT(x: number): number {
  return Math.trunc((x * 65536) / 360) & 65535;
}

export function SHORT2ANGLE(x: number): number {
  return x * (360.0 / 65536);
}

//
// config strings are a general means of communication from
// the server to all connected clients.
// Each config string can be at most MAX_QPATH characters.
//
export const CS_NAME = 0;
export const CS_CDTRACK = 1;
export const CS_SKY = 2;
export const CS_SKYAXIS = 3; // %f %f %f format
export const CS_SKYROTATE = 4;
export const CS_STATUSBAR = 5; // display program string

export const CS_AIRACCEL = 29; // air acceleration control
export const CS_MAXCLIENTS = 30;
export const CS_MAPCHECKSUM = 31; // for catching cheater maps

export const CS_MODELS = 32;
export const CS_SOUNDS = CS_MODELS + MAX_MODELS;
export const CS_IMAGES = CS_SOUNDS + MAX_SOUNDS;
export const CS_LIGHTS = CS_IMAGES + MAX_IMAGES;
export const CS_ITEMS = CS_LIGHTS + MAX_LIGHTSTYLES;
export const CS_PLAYERSKINS = CS_ITEMS + MAX_ITEMS;
export const CS_GENERAL = CS_PLAYERSKINS + MAX_CLIENTS;
export const MAX_CONFIGSTRINGS = CS_GENERAL + MAX_GENERAL;

//==============================================

// entity_state_t->event values
export enum EntityEventT {
  EV_NONE,
  EV_ITEM_RESPAWN,
  EV_FOOTSTEP,
  EV_FALLSHORT,
  EV_FALL,
  EV_FALLFAR,
  EV_PLAYER_TELEPORT,
  EV_OTHER_TELEPORT,
  // KEX (q2repro inc/shared/shared.h:1711-1714) -- material-based footstep
  // system additions: a non-viewing entity's own footstep (played quieter,
  // ATTN_IDLE, gated on the extended/kex protocol family) and the
  // dedicated ladder-climb step sound.
  EV_OTHER_FOOTSTEP,
  EV_LADDER_STEP,
}

// entity_state_t is the information conveyed from the server in an update
// message about entities that the client will need to render in some way.
export class EntityStateT {
  number = 0; // edict index

  origin: Vec3 = new Float32Array(3);
  angles: Vec3 = new Float32Array(3);
  old_origin: Vec3 = new Float32Array(3); // for lerping
  modelindex = 0;
  modelindex2 = 0;
  modelindex3 = 0;
  modelindex4 = 0; // weapons, CTF flags, etc
  frame = 0;
  skinnum = 0;
  effects = 0; // unsigned int in C; callers keep this in range with `>>> 0`
  renderfx = 0;
  solid = 0; // for client side prediction, 8*(bits 0-4) is x/y radius
  sound = 0; // for looping sounds, to guarantee shutoff
  event = 0; // impulse events -- muzzle flashes, footsteps, etc

  // KEX additions (q2repro inc/shared/shared.h:1736-1772). Additive and
  // behavior-neutral for now: nothing sets these to non-zero, and nothing
  // transmits them over the wire yet (sv_ents.ts delta logic, sizebuf.ts,
  // and cl_ents.ts parsing are untouched -- see phase2-design.md).
  alpha = 0; // [Paril-KEX] alpha scalar; 0 = default (EF_TRANSLUCENT -> 0.3, else 1.0)
  scale = 0; // [Paril-KEX] model scale scalar; 0 = default
  instance_bits = 0; // [Paril-KEX] server-managed per-player visibility mask; do not set directly
  loop_volume = 0; // [Paril-KEX] looping sound volume; 0 = default (1.0)
  loop_attenuation = 0; // [Paril-KEX] looping sound attenuation; 0 = default (3.0), -1 = none
  owner = 0; // [Paril-KEX] for client-side owner collision skipping
  old_frame = 0; // [Paril-KEX] for custom interpolation

  // DESIGN DEVIATION: KEX's effects_t is a uint64 (shared.h). Converting
  // `effects` itself to bigint would invade the frozen legacy game trees and
  // the hot bitop paths that read/write it as a plain number. Instead this
  // port splits the value: `effects` stays the low 32 bits (legacy contract
  // untouched), and `morefx` holds the high 32 bits (KEX-only). The kex
  // binding composes/splits the uint64 at the API boundary. Precedent:
  // Q2PRO's extended protocol uses the same effects/morefx split.
  morefx = 0;
}

//==============================================

// player_state_t is the information needed in addition to pmove_state_t to
// render a view. There will only be 10 player_state_t sent each second.
export class PlayerStateT {
  pmove: PmoveStateT = new PmoveStateT(); // for prediction

  // these fields do not need to be communicated bit-precise
  viewangles: Vec3 = new Float32Array(3); // for fixed views
  viewoffset: Vec3 = new Float32Array(3); // add to pmovestate->origin
  kick_angles: Vec3 = new Float32Array(3); // add to view direction to get render angles

  gunangles: Vec3 = new Float32Array(3);
  gunoffset: Vec3 = new Float32Array(3);
  gunindex = 0;
  gunskin = 0; // KEX addition (q2repro shared.h:1780-1815)
  gunframe = 0;
  gunrate = 0; // KEX addition

  // rgba full screen effect. Named `blend` here (matches this port's
  // established naming); KEX renames this field `screen_blend` -- the kex
  // binding maps blend <-> screen_blend at the boundary. Do not rename.
  blend: Float32Array = new Float32Array(4);
  // KEX addition: separate damage-flash blend, same vec4 representation as `blend`.
  damage_blend: Float32Array = new Float32Array(4);

  fov = 0; // horizontal field of view

  rdflags = 0; // refdef flags

  stats: Int16Array = new Int16Array(MAX_STATS_STORAGE); // fast status bar updates; 64-wide, see MAX_STATS_STORAGE

  team_id = 0; // KEX addition: team identifier
}

// ==================
// PGM
export const VIDREF_GL = 1;
export const VIDREF_SOFT = 2;
export const VIDREF_OTHER = 3;

// `extern int vidref_val` — set by the future client/video module; omitted here.
// PGM
// ==================

/*
==========================================================
CVARS (console variables)
==========================================================
*/

export const CVAR_ARCHIVE = 1; // set to cause it to be saved to vars.rc
export const CVAR_USERINFO = 2; // added to userinfo  when changed
export const CVAR_SERVERINFO = 4; // added to serverinfo when changed
export const CVAR_NOSET = 8; // don't allow change from console at all, but can be set from the command line
export const CVAR_LATCH = 16; // save changes until server restart

// q2repro's extended cvar flags (inc/common/cvar.h BIT(5)..BIT(15)). Never
// ported before this cvar-parity pass; several C-side registrations require
// them (CVAR_CHEAT, CVAR_PRIVATE, CVAR_ROM in particular). Enforcement of
// each flag's *behavior* (e.g. CVAR_CHEAT blocking changes while connected,
// CVAR_ROM blocking all changes) is q2repro's more advanced Cvar_Set/Cvar_Get
// than what src/qcommon/cvar.ts currently ports (that file is still the
// vanilla q2 3.21 cvar.c) -- see test/cvar_parity.test.ts and the audit
// report for which flags are enforced today vs. carried as inert metadata.
export const CVAR_CHEAT = 32; // BIT(5) -- can't be changed when connected
export const CVAR_PRIVATE = 64; // BIT(6) -- never macro expanded or saved to config
export const CVAR_ROM = 128; // BIT(7) -- can't be changed even from cmdline
export const CVAR_MODIFIED = 256; // BIT(8) -- modified by user (set internally by Cvar_Set, never passed to Cvar_Get)
export const CVAR_CUSTOM = 512; // BIT(9) -- created by user
export const CVAR_WEAK = 1024; // BIT(10) -- doesn't have value
export const CVAR_GAME = 2048; // BIT(11) -- created by game library
export const CVAR_NOARCHIVE = 4096; // BIT(12) -- never saved to config
export const CVAR_FILES = 8192; // BIT(13) -- r_reload when changed
export const CVAR_REFRESH = 16384; // BIT(14) -- vid_restart when changed
export const CVAR_SOUND = 32768; // BIT(15) -- snd_restart when changed

// nothing outside the Cvar_*() functions should modify these fields!
// Cvar_Get/Cvar_Set/etc. themselves belong to src/qcommon/cvar.ts (a future unit).
export class CvarT {
  name = "";
  string = "";
  // q2repro inc/common/cvar.h/src/common/cvar.c's `default_string` -- the
  // value the cvar was first Cvar_Get'd with, kept separately from `string`
  // (the live, settable value) for the whole cvar's lifetime. q2repro uses
  // it for \cvar_restart, `cvarlist`'s "modified from default" marker, and
  // config-writing's "skip unmodified cvars" pass; this port had never
  // ported it (still vanilla q2 3.21 cvar.c shape) until the cvar-parity
  // audit added it here, set once in Cvar_Get (src/qcommon/cvar.ts), never
  // written again by Cvar_Set/Cvar_ForceSet/Cvar_FullSet.
  default_string = "";
  latched_string: string | null = null; // for CVAR_LATCH vars
  flags = 0;
  modified = false; // set each time the cvar is changed
  value = 0;
  next: CvarT | null = null;
}

// directory searching
export const SFF_ARCH = 0x01;
export const SFF_HIDDEN = 0x02;
export const SFF_RDONLY = 0x04;
export const SFF_SUBDIR = 0x08;
export const SFF_SYSTEM = 0x10;

// Sys_Milliseconds, Sys_Mkdir, Hunk_Begin/Alloc/Free/End, Sys_FindFirst/Next/Close,
// Sys_Error → src/platform/sys.ts (future unit). `extern int curtime` likewise.
// Com_Printf → src/qcommon/common.ts (future unit). Omitted here per brief.

/*
============================================================================
BYTE ORDER FUNCTIONS
============================================================================

The C original detects host endianness at runtime in Swap_Init() and installs
function pointers accordingly. This port only targets little-endian hosts
(x86/ARM under bun), so the choice is fixed at compile time instead of at
runtime: Little* collapse to identity, Big* always swap, and Swap_Init is a
no-op kept only so call sites compile unchanged.
*/

export let bigendien = false;

export function ShortSwap(l: number): number {
  const b1 = l & 255;
  const b2 = (l >> 8) & 255;
  return (b1 << 8) + b2;
}

export function ShortNoSwap(l: number): number {
  return l;
}

export function LongSwap(l: number): number {
  const b1 = l & 255;
  const b2 = (l >> 8) & 255;
  const b3 = (l >> 16) & 255;
  const b4 = (l >> 24) & 255;
  return ((b1 << 24) + (b2 << 16) + (b3 << 8) + b4) | 0;
}

export function LongNoSwap(l: number): number {
  return l;
}

const swapBuf = new ArrayBuffer(4);
const swapFloat = new Float32Array(swapBuf);
const swapBytes = new Uint8Array(swapBuf);

export function FloatSwap(f: number): number {
  swapFloat[0] = f;
  const b0 = swapBytes[0];
  const b1 = swapBytes[1];
  const b2 = swapBytes[2];
  const b3 = swapBytes[3];
  swapBytes[0] = b3;
  swapBytes[1] = b2;
  swapBytes[2] = b1;
  swapBytes[3] = b0;
  return swapFloat[0];
}

export function FloatNoSwap(f: number): number {
  return f;
}

export function BigShort(l: number): number {
  return ShortSwap(l);
}

export function LittleShort(l: number): number {
  return ShortNoSwap(l);
}

export function BigLong(l: number): number {
  return LongSwap(l);
}

export function LittleLong(l: number): number {
  return LongNoSwap(l);
}

export function BigFloat(f: number): number {
  return FloatSwap(f);
}

export function LittleFloat(f: number): number {
  return FloatNoSwap(f);
}

export function Swap_Init(): void {
  // no-op: endianness is fixed at module load (see comment above)
}

/*
============
va

does a varargs printf into a temp buffer, so I don't need to have
varargs versions of all text functions.
============
*/
export function va(format: string, ...args: Array<string | number>): string {
  return Com_sprintf(format, ...args);
}

/*
============================================================================
LIBRARY REPLACEMENT FUNCTIONS
============================================================================
*/

// portable path (non-WIN32): delegates to libc strcasecmp semantics
export function Q_stricmp(s1: string, s2: string): number {
  const a = s1.toLowerCase();
  const b = s2.toLowerCase();
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function Q_strncasecmp(s1: string, s2: string, n: number): number {
  let i = 0;
  let remaining = n;
  for (;;) {
    let c1 = i < s1.length ? s1.charCodeAt(i) : 0;
    let c2 = i < s2.length ? s2.charCodeAt(i) : 0;
    i++;

    if (remaining === 0) return 0; // strings are equal until end point
    remaining--;

    if (c1 !== c2) {
      if (c1 >= 97 && c1 <= 122) c1 -= 32; // 'a'-'A'
      if (c2 >= 97 && c2 <= 122) c2 -= 32;
      if (c1 !== c2) return -1; // strings not equal
    }

    if (c1 === 0) return 0; // strings are equal
  }
}

export function Q_strcasecmp(s1: string, s2: string): number {
  return Q_strncasecmp(s1, s2, 99999);
}

/*
Com_sprintf(dest, size, fmt, ...) → Com_sprintf(fmt, ...args): string. The
dest/size out-buffer and its overflow warning (which called the omitted
Com_Printf) are dropped: JS strings aren't fixed buffers, so there is no
overflow to warn about. Supports %s %d %i %u %f %g %c %x %X %% with
'-'/'0' flags, width, and precision, matching what the codebase uses.
*/
export function Com_sprintf(fmt: string, ...args: Array<string | number>): string {
  let out = "";
  let argIndex = 0;
  let i = 0;
  const n = fmt.length;

  while (i < n) {
    const ch = fmt[i];
    if (ch !== "%") {
      out += ch;
      i++;
      continue;
    }
    i++; // consume '%'
    if (fmt[i] === "%") {
      out += "%";
      i++;
      continue;
    }

    let flagMinus = false;
    let flagZero = false;
    while (fmt[i] === "-" || fmt[i] === "0" || fmt[i] === "+" || fmt[i] === " ") {
      if (fmt[i] === "-") flagMinus = true;
      if (fmt[i] === "0") flagZero = true;
      i++;
    }

    let width = 0;
    let hasWidth = false;
    while (fmt[i] >= "0" && fmt[i] <= "9") {
      hasWidth = true;
      width = width * 10 + (fmt.charCodeAt(i) - 48);
      i++;
    }

    let precision = -1;
    if (fmt[i] === ".") {
      i++;
      precision = 0;
      while (fmt[i] >= "0" && fmt[i] <= "9") {
        precision = precision * 10 + (fmt.charCodeAt(i) - 48);
        i++;
      }
    }

    const conv = fmt[i];
    i++;
    const arg = args[argIndex++];
    let piece: string;

    switch (conv) {
      case "d":
      case "i": {
        const v = typeof arg === "number" ? Math.trunc(arg) : Number.parseInt(String(arg), 10);
        piece = String(v);
        break;
      }
      case "u": {
        const v = (typeof arg === "number" ? Math.trunc(arg) : Number(arg)) >>> 0;
        piece = String(v);
        break;
      }
      case "x": {
        const v = (typeof arg === "number" ? Math.trunc(arg) : Number(arg)) >>> 0;
        piece = v.toString(16);
        break;
      }
      case "X": {
        const v = (typeof arg === "number" ? Math.trunc(arg) : Number(arg)) >>> 0;
        piece = v.toString(16).toUpperCase();
        break;
      }
      case "f": {
        const v = typeof arg === "number" ? arg : Number(arg);
        piece = v.toFixed(precision === -1 ? 6 : precision);
        break;
      }
      case "g": {
        const v = typeof arg === "number" ? arg : Number(arg);
        piece = String(v);
        break;
      }
      case "c": {
        piece = typeof arg === "number" ? String.fromCharCode(arg) : (String(arg)[0] ?? "");
        break;
      }
      case "s": {
        piece = typeof arg === "string" ? arg : String(arg);
        if (precision !== -1) piece = piece.slice(0, precision);
        break;
      }
      default: {
        piece = "";
      }
    }

    if (hasWidth && piece.length < width) {
      const pad = (flagZero && !flagMinus ? "0" : " ").repeat(width - piece.length);
      piece = flagMinus ? piece + pad : pad + piece;
    }
    out += piece;
  }

  return out;
}

export let paged_total = 0;

/*
===============
Com_PageInMemory
===============
*/
export function Com_PageInMemory(buffer: Uint8Array, size: number): void {
  for (let i = size - 1; i > 0; i -= 4096) {
    paged_total += buffer[i];
  }
}

/*
=====================================================================
  INFO STRINGS
=====================================================================
*/

export const MAX_INFO_KEY = 64;
export const MAX_INFO_VALUE = 64;
export const MAX_INFO_STRING = 512;

/*
===============
Info_ValueForKey

Searches the string for the given
key and returns the associated value, or an empty string.
===============
*/
export function Info_ValueForKey(s: string, key: string): string {
  let i = s[0] === "\\" ? 1 : 0;

  for (;;) {
    let pkey = "";
    while (s[i] !== "\\") {
      if (i >= s.length) return "";
      pkey += s[i];
      i++;
    }
    i++;

    let value = "";
    while (s[i] !== "\\" && i < s.length) {
      value += s[i];
      i++;
    }

    if (key === pkey) return value;

    if (i >= s.length) return "";
    i++;
  }
}

// Returns the modified string with the key/value pair removed (the C original
// mutates `s` in place via strcpy; JS strings are immutable).
export function Info_RemoveKey(s: string, key: string): string {
  if (key.includes("\\")) {
    // Com_Printf("Can't use a key with a \\\n") dropped — see report
    return s;
  }

  let i = 0;
  for (;;) {
    const start = i;
    if (s[i] === "\\") i++;

    let pkey = "";
    while (s[i] !== "\\") {
      if (i >= s.length) return s;
      pkey += s[i];
      i++;
    }
    i++;

    while (s[i] !== "\\" && i < s.length) {
      i++;
    }

    if (key === pkey) {
      return s.slice(0, start) + s.slice(i); // remove this part
    }

    if (i >= s.length) return s;
  }
}

/*
==================
Info_Validate

Some characters are illegal in info strings because they
can mess up the server's parsing
==================
*/
export function Info_Validate(s: string): boolean {
  if (s.includes('"')) return false;
  if (s.includes(";")) return false;
  return true;
}

// Returns the modified info string (the C original mutates `s` in place).
export function Info_SetValueForKey(s: string, key: string, value: string): string {
  if (key.includes("\\") || value.includes("\\")) {
    // Com_Printf("Can't use keys or values with a \\\n") dropped — see report
    return s;
  }

  if (key.includes(";")) {
    // Com_Printf("Can't use keys or values with a semicolon\n") dropped
    return s;
  }

  if (key.includes('"') || value.includes('"')) {
    // Com_Printf("Can't use keys or values with a \"\n") dropped
    return s;
  }

  if (key.length > MAX_INFO_KEY - 1 || value.length > MAX_INFO_KEY - 1) {
    // Com_Printf("Keys and values must be < 64 characters.\n") dropped
    return s;
  }

  const result = Info_RemoveKey(s, key);
  if (value.length === 0) return result;

  const newi = Com_sprintf("\\%s\\%s", key, value);

  if (newi.length + result.length > MAX_INFO_STRING) {
    // Com_Printf("Info string length exceeded\n") dropped
    return result;
  }

  // only copy ascii values
  let appended = "";
  for (let i = 0; i < newi.length; i++) {
    const c = newi.charCodeAt(i) & 127; // strip high bits
    if (c >= 32 && c < 127) appended += String.fromCharCode(c);
  }
  return result + appended;
}
