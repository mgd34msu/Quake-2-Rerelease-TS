// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// game.h -- game API stuff (2023 Quake II re-release / "KEX" engine)
// Ported from quake2-rerelease-dll/rerelease/game.h (2,317 lines, C++17).
//
// TYPES-ONLY PORT: this module contains enums, constants, struct-as-interface
// shapes, function-pointer-typedefs-as-function-types, and the four API
// tables (game_import_t/game_export_t/cgame_import_t/cgame_export_t). No
// behavior or implementations are ported here -- that is a future unit's job
// (analogous to how src/game/game.ts is the pure-types 3.21 API and
// src/game/g_*.ts hold the behavior).
//
// ============================================================================
// NAMING
// ============================================================================
// C "_t"-suffixed struct/enum names become PascalCase+"T" TS names
// (cvar_t -> CvarT, trace_t -> TraceT). Where the natural PascalCase name
// would collide with an already-ported type of the same C name but a
// DIFFERENT shape (either from src/shared/q_shared.ts's vanilla 3.20 port, or
// from src/game/game.ts's 3.21 port), the new kex-specific type is prefixed
// "Kex" instead of overwriting/aliasing the older one: KexGameImports,
// KexGameExports, KexCgameImports, KexCgameExports, KexTraceT, KexCsurfaceT,
// KexPmoveStateT, KexUsercmdT, KexTouchListT, KexPmoveT, KexEntityStateT,
// KexPlayerStateT, KexPmTypeT, KexMulticastT, KexEntityEventT, KexTempEventT,
// KexEdictT, KexGclientT. Names with no pre-existing counterpart anywhere in
// the codebase (PathRequest, PathInfo, GoalReturnCode, ShadowLightDataT,
// SvEntityT, RgbaT, ...) keep their natural name, no "Kex" prefix.
//
// ============================================================================
// TYPE REUSE VS. REDEFINITION (src/shared/q_shared.ts, src/shared/math.ts)
// ============================================================================
// - vec3_t / gvec3_t (GAME_INCLUDE branch: gvec3_t = vec3_t) -> reuse `Vec3`
//   (Float32Array) from src/shared/math.ts. No redefinition.
// - cplane_t -> reuse `CplaneT` from q_shared.ts: field-for-field identical
//   (normal, dist, type, signbits); the C struct's trailing `pad[2]` is
//   asm-alignment padding with no TS relevance and q_shared.ts's CplaneT
//   already omits it, so the reuse is exact.
// - byte (uint8_t alias) -> reuse `Byte` (= number) from q_shared.ts.
// - cvar_t -> reuse `CvarT` from q_shared.ts PER THE PORTING BRIEF, even
//   though the shapes are not perfectly identical: kex's cvar_t has an
//   `integer: int32_t` field the existing CvarT lacks, and kex's
//   `modified_count: int32_t` (a change counter, paired with the free
//   function `Cvar_WasModified`) is represented in the existing CvarT as a
//   boolean `modified` flag instead. Fixing this mismatch means editing
//   q_shared.ts, which is out of scope here (that's a phase 2 job, per the
//   same convention src/game/game.ts documents for its own reused types).
//   `Cvar_WasModified()` itself is a real function body (behavior), not a
//   type, and is intentionally not ported.
// - trace_t, csurface_t, entity_state_t, player_state_t, pmove_state_t,
//   usercmd_t, pmove_t, multicast_t, pmtype_t, entity_event_t, temp_event_t
//   all DIFFER from their vanilla q_shared.ts counterparts (extra fields,
//   different field types/widths, or a different member set) and are
//   redefined here from scratch with "Kex" names; see the per-type comments
//   below for exactly what differs.
//
// ============================================================================
// POINTER / REFERENCE MAPPING (applies uniformly across this file)
// ============================================================================
// - `T&` and `const T&` (by-reference, always present) -> `T`.
// - `T*` and `const T*` (by-pointer, may be absent) -> `T | null`, EXCEPT:
//   - `char*` / `const char*` used as ordinary string parameters or as
//     getters that always return a valid internal buffer -> plain `string`
//     (matches src/game/game.ts's existing convention, e.g. `configstring`,
//     `argv`).
//   - `char*` / `const char*` struct FIELDS that model an optional/possibly-
//     unset native pointer (e.g. sv_entity_t.classname) -> `string | null`.
//   - `char*` return values that represent a freshly-allocated / ownership-
//     transferred buffer (game.h's `TagMalloc`'d `WriteGameJson` etc., which
//     may return null on failure) -> `string | null`; by contrast a
//     `const char*` getter returning a pointer to a stable internal buffer
//     (e.g. `get_configstring`) -> plain `string`.
//   - `void*` (opaque, e.g. TagMalloc/GetExtension) -> `unknown`.
// - Pointer-to-primitive OUT parameters (`size_t *out_size`, `int *w`,
//   `bool *is_team`, `const char **msg`) have no TS by-reference equivalent;
//   they are modeled as a single-element mutable "box" tuple, e.g.
//   `outSize: [number]`, `isTeam: [boolean]`, `msg: [string]`. This
//   convention is used at every such site in this file and is documented
//   once here rather than repeated per-site.
// - `T**` used as a caller-supplied output ARRAY (e.g. `edict_t **list` for
//   gi.BoxEdicts, `edict_t **ignore`) -> `(T | null)[]`.
//
// ============================================================================
// MAKE_ENUM_BITFLAGS / bit_v<n> -> "const object + number|bigint type"
// ============================================================================
// The C++ `MAKE_ENUM_BITFLAGS(T)` macro generates `operator|`, `&`, `^`, `~`,
// `|=`, `&=`, `^=` overloads for an enum type so it can be used as a bitmask
// with type safety. TypeScript has no operator overloading and does not need
// any: its native `|`, `&`, `^`, `~` operators already work directly on
// `number` (and, since ES2020, on `bigint`). So every enum the C++ wraps in
// MAKE_ENUM_BITFLAGS(...) is ported here as a plain object of named bit
// constants plus a type alias with the SAME name bound to `number` (or
// `bigint` -- see below), e.g.:
//
//   export const ContentsT = { CONTENTS_SOLID: bit(0), ... } as const;
//   export type ContentsT = number;
//
// This is legal TypeScript: a `const` value declaration and a `type`
// declaration of the same name coexist in separate namespaces. Combining
// members is then just `ContentsT.CONTENTS_SOLID | ContentsT.CONTENTS_WATER`.
//
// The C++ `bit_v<n>` variable template (`constexpr bit_t<n> bit_v = 1ull <<
// n`) is inlined at each use site via two small local helpers, `bit(n)` and
// `bitBig(n)` (defined below, not exported -- they exist purely to compute
// these tables, mirroring the C++ template's role). `bit(n)` uses `2 ** n`
// rather than `1 << n`: JS's `<<` operates on 32-bit SIGNED integers, so
// `1 << 31` evaluates to -2147483648, whereas the C++ uint32_t value for that
// same bit is the positive 2147483648. `2 ** n` gives the correct unsigned
// magnitude for every bit position used below (up to bit 31).
//
// BIT-WIDTH AUDIT -- every enum passed to MAKE_ENUM_BITFLAGS, its C++
// underlying type, and the chosen TS representation (see also the summary
// posted in the porting report):
//   print_type_t            (no explicit type, defaults int32)   -> number
//   cvar_flags_t             : uint32_t                          -> number
//   contents_t               : uint32_t                          -> number
//   surfflags_t              : uint32_t                          -> number
//   pmflags_t                : uint16_t                          -> number
//   button_t                 : uint8_t                           -> number
//   refdef_flags_t           : uint8_t                           -> number
//   effects_t                : uint64_t                          -> BIGINT
//   renderfx_t               : uint32_t                          -> number
//   player_muzzle_t          : uint8_t                           -> number
//   soundchan_t              : uint8_t                           -> number
//   svc_fog_data_t::bits_t   : uint16_t                          -> number
//   svflags_t                : uint32_t                          -> number
//   layout_flags_t           : int16_t                           -> number
//   PathFlags                : uint32_t                          -> number
//   fs_search_flags_t        (no explicit type, defaults int32)  -> number
//   BoxEdictsResult_t        (enum class, no explicit type,
//                             defaults int32)                    -> number
//   sv_ent_flags_t           : uint64_t                          -> BIGINT
//   server_flags_t           (no explicit type, defaults int32)  -> number
// Only `effects_t` and `sv_ent_flags_t` are declared `: uint64_t` in the
// C++ source, so only `EffectsT` and `SvEntFlagsT` use `bigint` here; every
// other bitflag enum's declared or defaulted width is 32 bits or less and is
// represented as `number`. Plain (non-bitflag) 64-bit fields that are not
// enums at all (e.g. `PathRequest::PathArray::count`, an `int64_t`;
// `CL_ClientTime()`'s `uint64_t` return; `fs_handle_t`) are represented as
// `number` for consistency with the rest of this codebase's integer
// handling (which never uses `bigint` for plain integer widths) -- the
// bigint requirement in the porting brief applies specifically to bitflag
// enums whose *enum* underlying type is 64-bit.
//
// ============================================================================
// OTHER DEVIATIONS (C++ constructs with no direct TS analogue)
// ============================================================================
// - `union player_skinnum_t` (a raw int32 unioned with a 4-field bitfield
//   struct) has no TS equivalent for either unions or bitfields; ported as a
//   flat interface with every field present (see KexPlayerSkinnumT below).
// - `CS_SIZE()` and `CS_REMAP()` are `constexpr` C++ FUNCTIONS with real
//   branching logic (not simple constant expressions), and
//   `configstring_remap_t` is data they return -- the struct is ported
//   (`ConfigstringRemapT`), the two functions are not (they are behavior,
//   out of scope for a types-only port).
// - The various `static_assert(...)` compile-time checks throughout game.h
//   have no runtime or type-level equivalent and are omitted.
// - `CHECK_INTEGRITY` / `CHECK_GCLIENT_INTEGRITY` / `CHECK_EDICT_INTEGRITY`
//   macros exist only to `static_assert` that the GAME_INCLUDE and non-
//   GAME_INCLUDE views of gclient_t/edict_t agree on layout; since this port
//   only models one (GAME_INCLUDE) view per type, these are omitted.
// - C++ default member initializers (e.g. `PathRequest::moveDist = 0.0f`)
//   have no TS interface equivalent (interfaces carry no values); defaults
//   are preserved only as comments.
// - `Q2GAME_API` (an `extern "C" __declspec(dllexport/dllimport)` macro) is
//   a native linkage annotation with no TypeScript meaning and is omitted.
// - `mutable` (on `PathRequest::PathArray::array`) is a C++ const-correctness
//   keyword with no TS meaning and is omitted (the field is just typed
//   `Vec3[] | null`).

import type { Byte, CplaneT, CvarT } from "../shared/q_shared";
import type { Vec3 } from "../shared/math";

// gvec4_t = std::array<float, 4> (GAME_INCLUDE branch). No 4-vector alias
// exists anywhere in this codebase yet, so a minimal local one is defined
// here rather than reusing/extending Vec3.
export type Vec4 = Float32Array;

// Computes 2**n for the bitflag tables below -- see the bit_v<n> discussion
// in the file header. Not exported: this is purely local plumbing, the same
// role the C++ `bit_v` variable template plays in game.h itself.
const bit = (n: number): number => 2 ** n;
const bitBig = (n: number): bigint => 1n << BigInt(n);

//===============================================================

export const MAX_SPLIT_PLAYERS = 8;

export interface RgbaT {
  r: Byte;
  g: Byte;
  b: Byte;
  a: Byte;
}

export interface Vec2T {
  x: number;
  y: number;
}

export const rgba_red: RgbaT = { r: 255, g: 0, b: 0, a: 255 };
export const rgba_blue: RgbaT = { r: 0, g: 0, b: 255, a: 255 };
export const rgba_green: RgbaT = { r: 0, g: 255, b: 0, a: 255 };
export const rgba_yellow: RgbaT = { r: 255, g: 255, b: 0, a: 255 };
export const rgba_white: RgbaT = { r: 255, g: 255, b: 255, a: 255 };
export const rgba_black: RgbaT = { r: 0, g: 0, b: 0, a: 255 };
export const rgba_cyan: RgbaT = { r: 0, g: 255, b: 255, a: 255 };
export const rgba_magenta: RgbaT = { r: 255, g: 0, b: 255, a: 255 };
export const rgba_orange: RgbaT = { r: 116, g: 61, b: 50, a: 255 };

export const MAX_NETNAME = 32;

export const STEPSIZE = 18.0;

// game.h -- game dll information visible to server
// PARIL_NEW_API - value likely not used by any other Q2-esque engine in the wild
export const GAME_API_VERSION = 2023;
export const CGAME_API_VERSION = 2022;

export const MAX_STRING_CHARS = 1024; // max length of a string passed to Cmd_TokenizeString
export const MAX_STRING_TOKENS = 80; // max tokens resulting from Cmd_TokenizeString
export const MAX_TOKEN_CHARS = 512; // max length of an individual token

export const MAX_QPATH = 64; // max length of a quake game pathname
export const MAX_OSPATH = 128; // max length of a filesystem pathname

//
// per-level limits
//
export const MAX_CLIENTS = 256; // absolute limit
export const MAX_EDICTS = 8192; // upper limit, due to svc_sound encoding as 15 bits
export const MAX_LIGHTSTYLES = 256;
export const MAX_MODELS = 8192; // these are sent over the net as shorts
export const MAX_SOUNDS = 2048; // so they cannot be blindly increased
export const MAX_IMAGES = 512;
export const MAX_ITEMS = 256;
export const MAX_GENERAL = MAX_CLIENTS * 2; // general config strings

// [Sam-KEX]
export const MAX_SHADOW_LIGHTS = 256;

// game print flags
export const PrintTypeT = {
  PRINT_LOW: 0, // pickup messages
  PRINT_MEDIUM: 1, // death messages
  PRINT_HIGH: 2, // critical messages
  PRINT_CHAT: 3, // chat messages
  PRINT_TYPEWRITER: 4, // centerprint but typed out one char at a time
  PRINT_CENTER: 5, // centerprint without a separate function (loc variants only)
  PRINT_TTS: 6, // PRINT_HIGH but will speak for players with narration on

  PRINT_BROADCAST: bit(3), // Bitflag, add to message to broadcast print to all clients.
  PRINT_NO_NOTIFY: bit(4), // Bitflag, don't put on notify
} as const;
export type PrintTypeT = number;

// [Paril-KEX] max number of arguments (not including the base) for
// localization prints
export const MAX_LOCALIZATION_ARGS = 8;

// destination class for gi.multicast(). DIFFERS from q_shared.ts's
// `MulticastT`: the vanilla enum has 6 members (3 plain + 3 "_R" reliable
// variants) because reliability was encoded in the enum value; the kex
// gi.multicast() signature instead takes a separate `reliable: boolean`
// parameter, so this enum only needs the 3 plain destinations.
export enum KexMulticastT {
  MULTICAST_ALL,
  MULTICAST_PHS,
  MULTICAST_PVS,
}

/*
==========================================================

CVARS (console variables)

==========================================================
*/

export const CvarFlagsT = {
  CVAR_NOFLAGS: 0,
  CVAR_ARCHIVE: bit(0), // set to cause it to be saved to config
  CVAR_USERINFO: bit(1), // added to userinfo  when changed
  CVAR_SERVERINFO: bit(2), // added to serverinfo when changed
  CVAR_NOSET: bit(3), // don't allow change from console at all,
  // but can be set from the command line
  CVAR_LATCH: bit(4), // save changes until server restart
  CVAR_USER_PROFILE: bit(5), // like CVAR_USERINFO but not sent to server
} as const;
export type CvarFlagsT = number;

// `Cvar_WasModified(const cvar_t*, int32_t&)` is a real function body
// (behavior), not a type; intentionally not ported here. See the file
// header for why `cvar_t` itself reuses the existing `CvarT`.

/*
==============================================================

COLLISION DETECTION

==============================================================
*/

// lower bits are stronger, and will eat weaker brushes completely
export const ContentsT = {
  CONTENTS_NONE: 0,
  CONTENTS_SOLID: bit(0), // an eye is never valid in a solid
  CONTENTS_WINDOW: bit(1), // translucent, but not watery
  CONTENTS_AUX: bit(2),
  CONTENTS_LAVA: bit(3),
  CONTENTS_SLIME: bit(4),
  CONTENTS_WATER: bit(5),
  CONTENTS_MIST: bit(6),

  // remaining contents are non-visible, and don't eat brushes

  CONTENTS_NO_WATERJUMP: bit(13), // [Paril-KEX] this brush cannot be waterjumped out of
  CONTENTS_PROJECTILECLIP: bit(14), // [Paril-KEX] projectiles will collide with this

  CONTENTS_AREAPORTAL: bit(15),

  CONTENTS_PLAYERCLIP: bit(16),
  CONTENTS_MONSTERCLIP: bit(17),

  // currents can be added to any other contents, and may be mixed
  CONTENTS_CURRENT_0: bit(18),
  CONTENTS_CURRENT_90: bit(19),
  CONTENTS_CURRENT_180: bit(20),
  CONTENTS_CURRENT_270: bit(21),
  CONTENTS_CURRENT_UP: bit(22),
  CONTENTS_CURRENT_DOWN: bit(23),

  CONTENTS_ORIGIN: bit(24), // removed before bsping an entity

  CONTENTS_MONSTER: bit(25), // should never be on a brush, only in game
  CONTENTS_DEADMONSTER: bit(26),

  CONTENTS_DETAIL: bit(27), // brushes to be added after vis leafs
  CONTENTS_TRANSLUCENT: bit(28), // auto set if any surface has trans
  CONTENTS_LADDER: bit(29),

  CONTENTS_PLAYER: bit(30), // [Paril-KEX] should never be on a brush, only in game; player
  CONTENTS_PROJECTILE: bit(31), // [Paril-KEX] should never be on a brush, only in game; projectiles.
  // used to solve deadmonster collision issues.
} as const;
export type ContentsT = number;

export const LAST_VISIBLE_CONTENTS: ContentsT = ContentsT.CONTENTS_MIST;

export const SurfflagsT = {
  SURF_NONE: 0,
  SURF_LIGHT: bit(0), // value will hold the light strength
  SURF_SLICK: bit(1), // effects game physics
  SURF_SKY: bit(2), // don't draw, but add to skybox
  SURF_WARP: bit(3), // turbulent water warp
  SURF_TRANS33: bit(4),
  SURF_TRANS66: bit(5),
  SURF_FLOWING: bit(6), // scroll towards angle
  SURF_NODRAW: bit(7), // don't bother referencing the texture
  SURF_ALPHATEST: bit(25), // [Paril-KEX] alpha test using widely supported flag
  SURF_N64_UV: bit(28), // [Sam-KEX] Stretches texture UVs
  SURF_N64_SCROLL_X: bit(29), // [Sam-KEX] Texture scroll X-axis
  SURF_N64_SCROLL_Y: bit(30), // [Sam-KEX] Texture scroll Y-axis
  SURF_N64_SCROLL_FLIP: bit(31), // [Sam-KEX] Flip direction of texture scroll
} as const;
export type SurfflagsT = number;

// content masks
export const MASK_ALL: ContentsT = 0xffffffff; // static_cast<contents_t>(-1)
export const MASK_SOLID: ContentsT = ContentsT.CONTENTS_SOLID | ContentsT.CONTENTS_WINDOW;
export const MASK_PLAYERSOLID: ContentsT =
  ContentsT.CONTENTS_SOLID | ContentsT.CONTENTS_PLAYERCLIP | ContentsT.CONTENTS_WINDOW | ContentsT.CONTENTS_MONSTER | ContentsT.CONTENTS_PLAYER;
export const MASK_DEADSOLID: ContentsT = ContentsT.CONTENTS_SOLID | ContentsT.CONTENTS_PLAYERCLIP | ContentsT.CONTENTS_WINDOW;
export const MASK_MONSTERSOLID: ContentsT =
  ContentsT.CONTENTS_SOLID | ContentsT.CONTENTS_MONSTERCLIP | ContentsT.CONTENTS_WINDOW | ContentsT.CONTENTS_MONSTER | ContentsT.CONTENTS_PLAYER;
export const MASK_WATER: ContentsT = ContentsT.CONTENTS_WATER | ContentsT.CONTENTS_LAVA | ContentsT.CONTENTS_SLIME;
export const MASK_OPAQUE: ContentsT = ContentsT.CONTENTS_SOLID | ContentsT.CONTENTS_SLIME | ContentsT.CONTENTS_LAVA;
export const MASK_SHOT: ContentsT =
  ContentsT.CONTENTS_SOLID | ContentsT.CONTENTS_MONSTER | ContentsT.CONTENTS_PLAYER | ContentsT.CONTENTS_WINDOW | ContentsT.CONTENTS_DEADMONSTER;
export const MASK_CURRENT: ContentsT =
  ContentsT.CONTENTS_CURRENT_0 |
  ContentsT.CONTENTS_CURRENT_90 |
  ContentsT.CONTENTS_CURRENT_180 |
  ContentsT.CONTENTS_CURRENT_270 |
  ContentsT.CONTENTS_CURRENT_UP |
  ContentsT.CONTENTS_CURRENT_DOWN;
export const MASK_BLOCK_SIGHT: ContentsT =
  ContentsT.CONTENTS_SOLID | ContentsT.CONTENTS_LAVA | ContentsT.CONTENTS_SLIME | ContentsT.CONTENTS_MONSTER | ContentsT.CONTENTS_PLAYER;
export const MASK_NAV_SOLID: ContentsT = ContentsT.CONTENTS_SOLID | ContentsT.CONTENTS_PLAYERCLIP | ContentsT.CONTENTS_WINDOW;
export const MASK_LADDER_NAV_SOLID: ContentsT = ContentsT.CONTENTS_SOLID | ContentsT.CONTENTS_WINDOW;
export const MASK_WALK_NAV_SOLID: ContentsT =
  ContentsT.CONTENTS_SOLID | ContentsT.CONTENTS_PLAYERCLIP | ContentsT.CONTENTS_WINDOW | ContentsT.CONTENTS_MONSTERCLIP;
export const MASK_PROJECTILE: ContentsT = MASK_SHOT | ContentsT.CONTENTS_PROJECTILECLIP;

// gi.BoxEdicts() can return a list of either solid or trigger entities
// FIXME: eliminate AREA_ distinction?
export enum SolidityAreaT {
  AREA_SOLID = 1,
  AREA_TRIGGERS = 2,
}

// cplane_t is reused as-is via `CplaneT` (see file header) -- no redefinition.

// [Paril-KEX]
export const MAX_MATERIAL_NAME = 16;

// DIFFERS from q_shared.ts's `CsurfaceT`: kex adds `id` (a stable per-texinfo
// identifier) and `material` (a material name string).
export interface KexCsurfaceT {
  name: string; // char[32]
  flags: SurfflagsT;
  value: number;

  // [Paril-KEX]
  id: number; // unique texinfo ID, offset by 1 (0 is 'null')
  material: string; // char[MAX_MATERIAL_NAME]
}

// a trace is returned when a box is swept through the world.
// DIFFERS from q_shared.ts's `TraceT`: kex adds `plane2`/`surface2` (the
// second-best surface hit) and types `ent` as the kex edict stub rather than
// `unknown`.
export interface KexTraceT {
  allsolid: boolean; // if true, plane is not valid
  startsolid: boolean; // if true, the initial point was in a solid area
  fraction: number; // time completed, 1.0 = didn't hit anything
  endpos: Vec3; // final position
  plane: CplaneT; // surface normal at impact
  surface: KexCsurfaceT | null; // surface hit
  contents: ContentsT; // contents on other side of surface hit
  ent: KexEdictT | null; // not set by CM_*() functions

  // [Paril-KEX] the second-best surface hit from a trace
  plane2: CplaneT; // second surface normal at impact
  surface2: KexCsurfaceT | null; // second surface hit
}

// pmove_state_t is the information necessary for client side movement
// prediction. DIFFERS from q_shared.ts's `PmoveStateT`: kex adds
// PM_GRAPPLE/PM_NOCLIP move types, uses float (not fixed 12.3 int16) origin
// and velocity, and types pm_flags/pm_time/gravity/viewheight explicitly.
export enum KexPmTypeT {
  // can accelerate and turn
  PM_NORMAL,
  PM_GRAPPLE, // [Paril-KEX] pull towards velocity, no gravity
  PM_NOCLIP,
  PM_SPECTATOR, // [Paril-KEX] clip against walls, but not entities
  // no acceleration or turning
  PM_DEAD,
  PM_GIB, // different bounding box
  PM_FREEZE,
}

// pmove->pm_flags
export const PmflagsT = {
  PMF_NONE: 0,
  PMF_DUCKED: bit(0),
  PMF_JUMP_HELD: bit(1),
  PMF_ON_GROUND: bit(2),
  PMF_TIME_WATERJUMP: bit(3), // pm_time is waterjump
  PMF_TIME_LAND: bit(4), // pm_time is time before rejump
  PMF_TIME_TELEPORT: bit(5), // pm_time is non-moving time
  PMF_NO_POSITIONAL_PREDICTION: bit(6), // temporarily disables positional prediction (used for grappling hook)
  PMF_ON_LADDER: bit(7), // signal to game that we are on a ladder
  PMF_NO_ANGULAR_PREDICTION: bit(8), // temporary disables angular prediction
  PMF_IGNORE_PLAYER_COLLISION: bit(9), // don't collide with other players
  PMF_TIME_TRICK: bit(10), // pm_time is trick jump time
} as const;
export type PmflagsT = number;

// this structure needs to be communicated bit-accurate
// from the server to the client to guarantee that
// prediction stays in sync.
// if any part of the game code modifies this struct, it
// will result in a prediction error of some degree.
export interface KexPmoveStateT {
  pm_type: KexPmTypeT;

  origin: Vec3;
  velocity: Vec3;
  pm_flags: PmflagsT; // ducked, jump_held, etc
  pm_time: number; // uint16_t
  gravity: number; // int16_t
  delta_angles: Vec3; // add to command angles to get view direction
  // changed by spawns, rotating objects, and teleporters
  viewheight: number; // int8_t; view height, added to origin[2] + viewoffset[2], for crouching
}

//
// button bits
//
export const ButtonT = {
  BUTTON_NONE: 0,
  BUTTON_ATTACK: bit(0),
  BUTTON_USE: bit(1),
  BUTTON_HOLSTER: bit(2), // [Paril-KEX]
  BUTTON_JUMP: bit(3),
  BUTTON_CROUCH: bit(4),
  BUTTON_ANY: bit(7), // any key whatsoever
} as const;
export type ButtonT = number;

// usercmd_t is sent to the server each client frame. DIFFERS from
// q_shared.ts's `UsercmdT`: kex uses a float `angles`/`forwardmove`/
// `sidemove` (not fixed-point int16) and adds `server_frame`; it drops
// `upmove`, `impulse`, `lightlevel`.
export interface KexUsercmdT {
  msec: Byte;
  buttons: ButtonT;
  angles: Vec3;
  forwardmove: number;
  sidemove: number;
  server_frame: number; // uint32_t; for integrity, etc
}

export enum WaterLevelT {
  WATER_NONE,
  WATER_FEET,
  WATER_WAIST,
  WATER_UNDER,
}

// player_state_t->refdef flags
export const RefdefFlagsT = {
  RDF_NONE: 0,
  RDF_UNDERWATER: bit(0), // warp the screen as appropriate
  RDF_NOWORLDMODEL: bit(1), // used for player configuration screen

  // ROGUE
  RDF_IRGOGGLES: bit(2),
  RDF_UVGOGGLES: bit(3),
  // ROGUE

  RDF_NO_WEAPON_LERP: bit(4),
} as const;
export type RefdefFlagsT = number;

export const MAXTOUCH = 32;

export interface KexTouchListT {
  num: number;
  traces: KexTraceT[]; // length MAXTOUCH
}

export interface KexPmoveT {
  // state (in / out)
  s: KexPmoveStateT;

  // command (in)
  cmd: KexUsercmdT;
  snapinitial: boolean; // if s has been changed outside pmove

  // results (out)
  touch: KexTouchListT;

  viewangles: Vec3; // clamped

  mins: Vec3;
  maxs: Vec3; // bounding box size

  groundentity: KexEdictT | null;
  groundplane: CplaneT;
  watertype: ContentsT;
  waterlevel: WaterLevelT;

  player: KexEdictT | null; // opaque handle

  // clip against world & entities
  trace(start: Vec3, mins: Vec3 | null, maxs: Vec3 | null, end: Vec3, passent: KexEdictT | null, contentmask: ContentsT): KexTraceT;
  // [Paril-KEX] clip against world only
  clip(start: Vec3, mins: Vec3 | null, maxs: Vec3 | null, end: Vec3, contentmask: ContentsT): KexTraceT;

  pointcontents(point: Vec3): ContentsT;

  // [KEX] variables (in)
  viewoffset: Vec3; // last viewoffset (for accurate calculation of blending)

  // [KEX] results (out)
  screen_blend: Vec4;
  rdflags: RefdefFlagsT; // merged with rdflags from server
  jump_sound: boolean; // play jump sound
  step_clip: boolean; // we clipped on top of an object from below
  impact_delta: number; // impact delta, for falling damage
}

// entity_state_t->effects
// Effects are things handled on the client side (lights, particles, frame animations)
// that happen constantly on the given entity.
// An entity that has effects will be sent to the client
// even if it has a zero index model.
//
// `effects_t : uint64_t` -- BIGINT (see bit-width audit in the file header;
// EF_GRENADE_LIGHT is bit 37, which does not fit in 32 bits regardless).
export const EffectsT = {
  EF_NONE: 0n, // no effects
  EF_ROTATE: bitBig(0), // rotate (bonus items)
  EF_GIB: bitBig(1), // leave a trail
  EF_BOB: bitBig(2), // bob (bonus items)
  EF_BLASTER: bitBig(3), // redlight + trail
  EF_ROCKET: bitBig(4), // redlight + trail
  EF_GRENADE: bitBig(5),
  EF_HYPERBLASTER: bitBig(6),
  EF_BFG: bitBig(7),
  EF_COLOR_SHELL: bitBig(8),
  EF_POWERSCREEN: bitBig(9),
  EF_ANIM01: bitBig(10), // automatically cycle between frames 0 and 1 at 2 hz
  EF_ANIM23: bitBig(11), // automatically cycle between frames 2 and 3 at 2 hz
  EF_ANIM_ALL: bitBig(12), // automatically cycle through all frames at 2hz
  EF_ANIM_ALLFAST: bitBig(13), // automatically cycle through all frames at 10hz
  EF_FLIES: bitBig(14),
  EF_QUAD: bitBig(15),
  EF_PENT: bitBig(16),
  EF_TELEPORTER: bitBig(17), // particle fountain
  EF_FLAG1: bitBig(18),
  EF_FLAG2: bitBig(19),
  // RAFAEL
  EF_IONRIPPER: bitBig(20),
  EF_GREENGIB: bitBig(21),
  EF_BLUEHYPERBLASTER: bitBig(22),
  EF_SPINNINGLIGHTS: bitBig(23),
  EF_PLASMA: bitBig(24),
  EF_TRAP: bitBig(25),

  // ROGUE
  EF_TRACKER: bitBig(26),
  EF_DOUBLE: bitBig(27),
  EF_SPHERETRANS: bitBig(28),
  EF_TAGTRAIL: bitBig(29),
  EF_HALF_DAMAGE: bitBig(30),
  EF_TRACKERTRAIL: bitBig(31),
  // ROGUE

  EF_DUALFIRE: bitBig(32), // [KEX] dualfire damage color shell
  EF_HOLOGRAM: bitBig(33), // [Paril-KEX] N64 hologram
  EF_FLASHLIGHT: bitBig(34), // [Paril-KEX] project flashlight, only for players
  EF_BARREL_EXPLODING: bitBig(35),
  EF_TELEPORTER2: bitBig(36), // [Paril-KEX] n64 teleporter
  EF_GRENADE_LIGHT: bitBig(37),
} as const;
export type EffectsT = bigint;

export const EF_FIREBALL: EffectsT = EffectsT.EF_ROCKET | EffectsT.EF_GIB;

// entity_state_t->renderfx flags
export const RenderfxT = {
  RF_NONE: 0,
  RF_MINLIGHT: bit(0), // always have some light (viewmodel)
  RF_VIEWERMODEL: bit(1), // don't draw through eyes, only mirrors
  RF_WEAPONMODEL: bit(2), // only draw through eyes
  RF_FULLBRIGHT: bit(3), // always draw full intensity
  RF_DEPTHHACK: bit(4), // for view weapon Z crunching
  RF_TRANSLUCENT: bit(5),
  RF_NO_ORIGIN_LERP: bit(6), // no interpolation for origins
  RF_BEAM: bit(7),
  RF_CUSTOMSKIN: bit(8), // [Paril-KEX] implemented; set skinnum (or frame for RF_FLARE) to specify
  // an image in CS_IMAGES to use as skin.
  RF_GLOW: bit(9), // pulse lighting for bonus items
  RF_SHELL_RED: bit(10),
  RF_SHELL_GREEN: bit(11),
  RF_SHELL_BLUE: bit(12),
  RF_NOSHADOW: bit(13),
  RF_CASTSHADOW: bit(14), // [Sam-KEX]

  // ROGUE
  RF_IR_VISIBLE: bit(15),
  RF_SHELL_DOUBLE: bit(16),
  RF_SHELL_HALF_DAM: bit(17),
  RF_USE_DISGUISE: bit(18),
  // ROGUE

  RF_SHELL_LITE_GREEN: bit(19),
  RF_CUSTOM_LIGHT: bit(20), // [Paril-KEX] custom point dlight that is designed to strobe/be turned off; s.frame is radius, s.skinnum is color
  RF_FLARE: bit(21), // [Sam-KEX]
  RF_OLD_FRAME_LERP: bit(22), // [Paril-KEX] force model to lerp from oldframe in entity state; otherwise it uses last frame client received
  RF_DOT_SHADOW: bit(23), // [Paril-KEX] draw blobby shadow
  RF_LOW_PRIORITY: bit(24), // [Paril-KEX] low priority object; if we can't be added to the scene, don't bother replacing entities,
  // and we can be replaced if anything non-low-priority needs room
  RF_NO_LOD: bit(25), // [Paril-KEX] never LOD
  RF_NO_STEREO: bit(2), // [Paril-KEX] === RF_WEAPONMODEL; this is a bit dumb, but, for looping noises if this is set there's no stereo
  RF_STAIR_STEP: bit(26), // [Paril-KEX] re-tuned, now used to handle stair steps for monsters

  RF_FLARE_LOCK_ANGLE: bit(0), // === RF_MINLIGHT
} as const;
export type RenderfxT = number;

export const RF_BEAM_LIGHTNING: RenderfxT = RenderfxT.RF_BEAM | RenderfxT.RF_GLOW; // [Paril-KEX] make a lightning bolt instead of a laser

//
// muzzle flashes / player effects
//
export const PlayerMuzzleT = {
  MZ_BLASTER: 0,
  MZ_MACHINEGUN: 1,
  MZ_SHOTGUN: 2,
  MZ_CHAINGUN1: 3,
  MZ_CHAINGUN2: 4,
  MZ_CHAINGUN3: 5,
  MZ_RAILGUN: 6,
  MZ_ROCKET: 7,
  MZ_GRENADE: 8,
  MZ_LOGIN: 9,
  MZ_LOGOUT: 10,
  MZ_RESPAWN: 11,
  MZ_BFG: 12,
  MZ_SSHOTGUN: 13,
  MZ_HYPERBLASTER: 14,
  MZ_ITEMRESPAWN: 15,
  // RAFAEL
  MZ_IONRIPPER: 16,
  MZ_BLUEHYPERBLASTER: 17,
  MZ_PHALANX: 18,
  MZ_BFG2: 19,
  MZ_PHALANX2: 20,

  // ROGUE
  MZ_ETF_RIFLE: 30,
  MZ_PROX: 31, // [Paril-KEX]
  MZ_ETF_RIFLE_2: 32, // [Paril-KEX] unused, so using it for the other barrel
  MZ_HEATBEAM: 33,
  MZ_BLASTER2: 34,
  MZ_TRACKER: 35,
  MZ_NUKE1: 36,
  MZ_NUKE2: 37,
  MZ_NUKE4: 38,
  MZ_NUKE8: 39,
  // ROGUE

  MZ_SILENCED: bit(7), // bit flag ORed with one of the above numbers
  MZ_NONE: 0, // "no" bitflags
} as const;
export type PlayerMuzzleT = number;

//
// monster muzzle flashes
// NOTE: this needs to match the m_flash table!
//
export enum MonsterMuzzleflashIdT {
  MZ2_UNUSED_0,

  MZ2_TANK_BLASTER_1,
  MZ2_TANK_BLASTER_2,
  MZ2_TANK_BLASTER_3,
  MZ2_TANK_MACHINEGUN_1,
  MZ2_TANK_MACHINEGUN_2,
  MZ2_TANK_MACHINEGUN_3,
  MZ2_TANK_MACHINEGUN_4,
  MZ2_TANK_MACHINEGUN_5,
  MZ2_TANK_MACHINEGUN_6,
  MZ2_TANK_MACHINEGUN_7,
  MZ2_TANK_MACHINEGUN_8,
  MZ2_TANK_MACHINEGUN_9,
  MZ2_TANK_MACHINEGUN_10,
  MZ2_TANK_MACHINEGUN_11,
  MZ2_TANK_MACHINEGUN_12,
  MZ2_TANK_MACHINEGUN_13,
  MZ2_TANK_MACHINEGUN_14,
  MZ2_TANK_MACHINEGUN_15,
  MZ2_TANK_MACHINEGUN_16,
  MZ2_TANK_MACHINEGUN_17,
  MZ2_TANK_MACHINEGUN_18,
  MZ2_TANK_MACHINEGUN_19,
  MZ2_TANK_ROCKET_1,
  MZ2_TANK_ROCKET_2,
  MZ2_TANK_ROCKET_3,

  MZ2_INFANTRY_MACHINEGUN_1,
  MZ2_INFANTRY_MACHINEGUN_2,
  MZ2_INFANTRY_MACHINEGUN_3,
  MZ2_INFANTRY_MACHINEGUN_4,
  MZ2_INFANTRY_MACHINEGUN_5,
  MZ2_INFANTRY_MACHINEGUN_6,
  MZ2_INFANTRY_MACHINEGUN_7,
  MZ2_INFANTRY_MACHINEGUN_8,
  MZ2_INFANTRY_MACHINEGUN_9,
  MZ2_INFANTRY_MACHINEGUN_10,
  MZ2_INFANTRY_MACHINEGUN_11,
  MZ2_INFANTRY_MACHINEGUN_12,
  MZ2_INFANTRY_MACHINEGUN_13,

  MZ2_SOLDIER_BLASTER_1,
  MZ2_SOLDIER_BLASTER_2,
  MZ2_SOLDIER_SHOTGUN_1,
  MZ2_SOLDIER_SHOTGUN_2,
  MZ2_SOLDIER_MACHINEGUN_1,
  MZ2_SOLDIER_MACHINEGUN_2,

  MZ2_GUNNER_MACHINEGUN_1,
  MZ2_GUNNER_MACHINEGUN_2,
  MZ2_GUNNER_MACHINEGUN_3,
  MZ2_GUNNER_MACHINEGUN_4,
  MZ2_GUNNER_MACHINEGUN_5,
  MZ2_GUNNER_MACHINEGUN_6,
  MZ2_GUNNER_MACHINEGUN_7,
  MZ2_GUNNER_MACHINEGUN_8,
  MZ2_GUNNER_GRENADE_1,
  MZ2_GUNNER_GRENADE_2,
  MZ2_GUNNER_GRENADE_3,
  MZ2_GUNNER_GRENADE_4,

  MZ2_CHICK_ROCKET_1,

  MZ2_FLYER_BLASTER_1,
  MZ2_FLYER_BLASTER_2,

  MZ2_MEDIC_BLASTER_1,

  MZ2_GLADIATOR_RAILGUN_1,

  MZ2_HOVER_BLASTER_1,

  MZ2_ACTOR_MACHINEGUN_1,

  MZ2_SUPERTANK_MACHINEGUN_1,
  MZ2_SUPERTANK_MACHINEGUN_2,
  MZ2_SUPERTANK_MACHINEGUN_3,
  MZ2_SUPERTANK_MACHINEGUN_4,
  MZ2_SUPERTANK_MACHINEGUN_5,
  MZ2_SUPERTANK_MACHINEGUN_6,
  MZ2_SUPERTANK_ROCKET_1,
  MZ2_SUPERTANK_ROCKET_2,
  MZ2_SUPERTANK_ROCKET_3,

  MZ2_BOSS2_MACHINEGUN_L1,
  MZ2_BOSS2_MACHINEGUN_L2,
  MZ2_BOSS2_MACHINEGUN_L3,
  MZ2_BOSS2_MACHINEGUN_L4,
  MZ2_BOSS2_MACHINEGUN_L5,
  MZ2_BOSS2_ROCKET_1,
  MZ2_BOSS2_ROCKET_2,
  MZ2_BOSS2_ROCKET_3,
  MZ2_BOSS2_ROCKET_4,

  MZ2_FLOAT_BLASTER_1,

  MZ2_SOLDIER_BLASTER_3,
  MZ2_SOLDIER_SHOTGUN_3,
  MZ2_SOLDIER_MACHINEGUN_3,
  MZ2_SOLDIER_BLASTER_4,
  MZ2_SOLDIER_SHOTGUN_4,
  MZ2_SOLDIER_MACHINEGUN_4,
  MZ2_SOLDIER_BLASTER_5,
  MZ2_SOLDIER_SHOTGUN_5,
  MZ2_SOLDIER_MACHINEGUN_5,
  MZ2_SOLDIER_BLASTER_6,
  MZ2_SOLDIER_SHOTGUN_6,
  MZ2_SOLDIER_MACHINEGUN_6,
  MZ2_SOLDIER_BLASTER_7,
  MZ2_SOLDIER_SHOTGUN_7,
  MZ2_SOLDIER_MACHINEGUN_7,
  MZ2_SOLDIER_BLASTER_8,
  MZ2_SOLDIER_SHOTGUN_8,
  MZ2_SOLDIER_MACHINEGUN_8,

  // --- Xian shit below ---
  MZ2_MAKRON_BFG,
  MZ2_MAKRON_BLASTER_1,
  MZ2_MAKRON_BLASTER_2,
  MZ2_MAKRON_BLASTER_3,
  MZ2_MAKRON_BLASTER_4,
  MZ2_MAKRON_BLASTER_5,
  MZ2_MAKRON_BLASTER_6,
  MZ2_MAKRON_BLASTER_7,
  MZ2_MAKRON_BLASTER_8,
  MZ2_MAKRON_BLASTER_9,
  MZ2_MAKRON_BLASTER_10,
  MZ2_MAKRON_BLASTER_11,
  MZ2_MAKRON_BLASTER_12,
  MZ2_MAKRON_BLASTER_13,
  MZ2_MAKRON_BLASTER_14,
  MZ2_MAKRON_BLASTER_15,
  MZ2_MAKRON_BLASTER_16,
  MZ2_MAKRON_BLASTER_17,
  MZ2_MAKRON_RAILGUN_1,
  MZ2_JORG_MACHINEGUN_L1,
  MZ2_JORG_MACHINEGUN_L2,
  MZ2_JORG_MACHINEGUN_L3,
  MZ2_JORG_MACHINEGUN_L4,
  MZ2_JORG_MACHINEGUN_L5,
  MZ2_JORG_MACHINEGUN_L6,
  MZ2_JORG_MACHINEGUN_R1,
  MZ2_JORG_MACHINEGUN_R2,
  MZ2_JORG_MACHINEGUN_R3,
  MZ2_JORG_MACHINEGUN_R4,
  MZ2_JORG_MACHINEGUN_R5,
  MZ2_JORG_MACHINEGUN_R6,
  MZ2_JORG_BFG_1,
  MZ2_BOSS2_MACHINEGUN_R1,
  MZ2_BOSS2_MACHINEGUN_R2,
  MZ2_BOSS2_MACHINEGUN_R3,
  MZ2_BOSS2_MACHINEGUN_R4,
  MZ2_BOSS2_MACHINEGUN_R5,

  // ROGUE
  MZ2_CARRIER_MACHINEGUN_L1,
  MZ2_CARRIER_MACHINEGUN_R1,
  MZ2_CARRIER_GRENADE,
  MZ2_TURRET_MACHINEGUN,
  MZ2_TURRET_ROCKET,
  MZ2_TURRET_BLASTER,
  MZ2_STALKER_BLASTER,
  MZ2_DAEDALUS_BLASTER,
  MZ2_MEDIC_BLASTER_2,
  MZ2_CARRIER_RAILGUN,
  MZ2_WIDOW_DISRUPTOR,
  MZ2_WIDOW_BLASTER,
  MZ2_WIDOW_RAIL,
  MZ2_WIDOW_PLASMABEAM, // PMM - not used
  MZ2_CARRIER_MACHINEGUN_L2,
  MZ2_CARRIER_MACHINEGUN_R2,
  MZ2_WIDOW_RAIL_LEFT,
  MZ2_WIDOW_RAIL_RIGHT,
  MZ2_WIDOW_BLASTER_SWEEP1,
  MZ2_WIDOW_BLASTER_SWEEP2,
  MZ2_WIDOW_BLASTER_SWEEP3,
  MZ2_WIDOW_BLASTER_SWEEP4,
  MZ2_WIDOW_BLASTER_SWEEP5,
  MZ2_WIDOW_BLASTER_SWEEP6,
  MZ2_WIDOW_BLASTER_SWEEP7,
  MZ2_WIDOW_BLASTER_SWEEP8,
  MZ2_WIDOW_BLASTER_SWEEP9,
  MZ2_WIDOW_BLASTER_100,
  MZ2_WIDOW_BLASTER_90,
  MZ2_WIDOW_BLASTER_80,
  MZ2_WIDOW_BLASTER_70,
  MZ2_WIDOW_BLASTER_60,
  MZ2_WIDOW_BLASTER_50,
  MZ2_WIDOW_BLASTER_40,
  MZ2_WIDOW_BLASTER_30,
  MZ2_WIDOW_BLASTER_20,
  MZ2_WIDOW_BLASTER_10,
  MZ2_WIDOW_BLASTER_0,
  MZ2_WIDOW_BLASTER_10L,
  MZ2_WIDOW_BLASTER_20L,
  MZ2_WIDOW_BLASTER_30L,
  MZ2_WIDOW_BLASTER_40L,
  MZ2_WIDOW_BLASTER_50L,
  MZ2_WIDOW_BLASTER_60L,
  MZ2_WIDOW_BLASTER_70L,
  MZ2_WIDOW_RUN_1,
  MZ2_WIDOW_RUN_2,
  MZ2_WIDOW_RUN_3,
  MZ2_WIDOW_RUN_4,
  MZ2_WIDOW_RUN_5,
  MZ2_WIDOW_RUN_6,
  MZ2_WIDOW_RUN_7,
  MZ2_WIDOW_RUN_8,
  MZ2_CARRIER_ROCKET_1,
  MZ2_CARRIER_ROCKET_2,
  MZ2_CARRIER_ROCKET_3,
  MZ2_CARRIER_ROCKET_4,
  MZ2_WIDOW2_BEAMER_1,
  MZ2_WIDOW2_BEAMER_2,
  MZ2_WIDOW2_BEAMER_3,
  MZ2_WIDOW2_BEAMER_4,
  MZ2_WIDOW2_BEAMER_5,
  MZ2_WIDOW2_BEAM_SWEEP_1,
  MZ2_WIDOW2_BEAM_SWEEP_2,
  MZ2_WIDOW2_BEAM_SWEEP_3,
  MZ2_WIDOW2_BEAM_SWEEP_4,
  MZ2_WIDOW2_BEAM_SWEEP_5,
  MZ2_WIDOW2_BEAM_SWEEP_6,
  MZ2_WIDOW2_BEAM_SWEEP_7,
  MZ2_WIDOW2_BEAM_SWEEP_8,
  MZ2_WIDOW2_BEAM_SWEEP_9,
  MZ2_WIDOW2_BEAM_SWEEP_10,
  MZ2_WIDOW2_BEAM_SWEEP_11,
  // ROGUE

  // [Paril-KEX]
  MZ2_SOLDIER_RIPPER_1,
  MZ2_SOLDIER_RIPPER_2,
  MZ2_SOLDIER_RIPPER_3,
  MZ2_SOLDIER_RIPPER_4,
  MZ2_SOLDIER_RIPPER_5,
  MZ2_SOLDIER_RIPPER_6,
  MZ2_SOLDIER_RIPPER_7,
  MZ2_SOLDIER_RIPPER_8,

  MZ2_SOLDIER_HYPERGUN_1,
  MZ2_SOLDIER_HYPERGUN_2,
  MZ2_SOLDIER_HYPERGUN_3,
  MZ2_SOLDIER_HYPERGUN_4,
  MZ2_SOLDIER_HYPERGUN_5,
  MZ2_SOLDIER_HYPERGUN_6,
  MZ2_SOLDIER_HYPERGUN_7,
  MZ2_SOLDIER_HYPERGUN_8,
  MZ2_GUARDIAN_BLASTER,
  MZ2_ARACHNID_RAIL1,
  MZ2_ARACHNID_RAIL2,
  MZ2_ARACHNID_RAIL_UP1,
  MZ2_ARACHNID_RAIL_UP2,

  MZ2_INFANTRY_MACHINEGUN_14, // run-attack
  MZ2_INFANTRY_MACHINEGUN_15, // run-attack
  MZ2_INFANTRY_MACHINEGUN_16, // run-attack
  MZ2_INFANTRY_MACHINEGUN_17, // run-attack
  MZ2_INFANTRY_MACHINEGUN_18, // run-attack
  MZ2_INFANTRY_MACHINEGUN_19, // run-attack
  MZ2_INFANTRY_MACHINEGUN_20, // run-attack
  MZ2_INFANTRY_MACHINEGUN_21, // run-attack

  MZ2_GUNCMDR_CHAINGUN_1, // straight
  MZ2_GUNCMDR_CHAINGUN_2, // dodging

  MZ2_GUNCMDR_GRENADE_MORTAR_1,
  MZ2_GUNCMDR_GRENADE_MORTAR_2,
  MZ2_GUNCMDR_GRENADE_MORTAR_3,
  MZ2_GUNCMDR_GRENADE_FRONT_1,
  MZ2_GUNCMDR_GRENADE_FRONT_2,
  MZ2_GUNCMDR_GRENADE_FRONT_3,
  MZ2_GUNCMDR_GRENADE_CROUCH_1,
  MZ2_GUNCMDR_GRENADE_CROUCH_2,
  MZ2_GUNCMDR_GRENADE_CROUCH_3,

  // prone
  MZ2_SOLDIER_BLASTER_9,
  MZ2_SOLDIER_SHOTGUN_9,
  MZ2_SOLDIER_MACHINEGUN_9,
  MZ2_SOLDIER_RIPPER_9,
  MZ2_SOLDIER_HYPERGUN_9,

  // alternate frontwards grenades
  MZ2_GUNNER_GRENADE2_1,
  MZ2_GUNNER_GRENADE2_2,
  MZ2_GUNNER_GRENADE2_3,
  MZ2_GUNNER_GRENADE2_4,

  MZ2_INFANTRY_MACHINEGUN_22,

  // supertonk
  MZ2_SUPERTANK_GRENADE_1,
  MZ2_SUPERTANK_GRENADE_2,

  // hover & daedalus other side
  MZ2_HOVER_BLASTER_2,
  MZ2_DAEDALUS_BLASTER_2,

  // medic (commander) sweeps
  MZ2_MEDIC_HYPERBLASTER1_1,
  MZ2_MEDIC_HYPERBLASTER1_2,
  MZ2_MEDIC_HYPERBLASTER1_3,
  MZ2_MEDIC_HYPERBLASTER1_4,
  MZ2_MEDIC_HYPERBLASTER1_5,
  MZ2_MEDIC_HYPERBLASTER1_6,
  MZ2_MEDIC_HYPERBLASTER1_7,
  MZ2_MEDIC_HYPERBLASTER1_8,
  MZ2_MEDIC_HYPERBLASTER1_9,
  MZ2_MEDIC_HYPERBLASTER1_10,
  MZ2_MEDIC_HYPERBLASTER1_11,
  MZ2_MEDIC_HYPERBLASTER1_12,

  MZ2_MEDIC_HYPERBLASTER2_1,
  MZ2_MEDIC_HYPERBLASTER2_2,
  MZ2_MEDIC_HYPERBLASTER2_3,
  MZ2_MEDIC_HYPERBLASTER2_4,
  MZ2_MEDIC_HYPERBLASTER2_5,
  MZ2_MEDIC_HYPERBLASTER2_6,
  MZ2_MEDIC_HYPERBLASTER2_7,
  MZ2_MEDIC_HYPERBLASTER2_8,
  MZ2_MEDIC_HYPERBLASTER2_9,
  MZ2_MEDIC_HYPERBLASTER2_10,
  MZ2_MEDIC_HYPERBLASTER2_11,
  MZ2_MEDIC_HYPERBLASTER2_12,

  // only used for compile time checks
  MZ2_LAST,
}

// temp entity events
//
// Temp entity events are for things that happen
// at a location seperate from any existing entity.
// Temporary entity messages are explicitly constructed
// and broadcast.
//
// DIFFERS from q_shared.ts's `TempEventT`: kex adds/reorders several members
// (TE_BLUEHYPERBLASTER_DUMMY, TE_PLASMA_EXPLOSION, TE_TUNNEL_SPARKS, and the
// whole [Paril-KEX] tail from TE_BLUEHYPERBLASTER through TE_EXPLOSION2_NL).
export enum KexTempEventT {
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
  TE_BLUEHYPERBLASTER_DUMMY, // [Paril-KEX] leaving for compatibility, do not use; use TE_BLUEHYPERBLASTER
  TE_PLASMA_EXPLOSION,
  TE_TUNNEL_SPARKS,
  // ROGUE
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
  // ROGUE

  // [Paril-KEX]
  TE_BLUEHYPERBLASTER,
  TE_BFG_ZAP,
  TE_BERSERK_SLAM,
  TE_GRAPPLE_CABLE_2,
  TE_POWER_SPLASH,
  TE_LIGHTNING_BEAM,
  TE_EXPLOSION1_NL,
  TE_EXPLOSION2_NL,
}

export enum SplashColorT {
  SPLASH_UNKNOWN = 0,
  SPLASH_SPARKS = 1,
  SPLASH_BLUE_WATER = 2,
  SPLASH_BROWN_WATER = 3,
  SPLASH_SLIME = 4,
  SPLASH_LAVA = 5,
  SPLASH_BLOOD = 6,

  // [Paril-KEX] N64 electric sparks that go zap
  SPLASH_ELECTRIC = 7,
}

// sound channels
// channel 0 never willingly overrides
// other channels (1-7) always override a playing sound on that channel
export const SoundchanT = {
  CHAN_AUTO: 0,
  CHAN_WEAPON: 1,
  CHAN_VOICE: 2,
  CHAN_ITEM: 3,
  CHAN_BODY: 4,
  CHAN_AUX: 5,
  CHAN_FOOTSTEP: 6,
  CHAN_AUX3: 7,

  // modifier flags
  CHAN_NO_PHS_ADD: bit(3), // send to all clients, not just ones in PHS (ATTN 0 will also do this)
  CHAN_RELIABLE: bit(4), // send by reliable message, not datagram
  CHAN_FORCE_POS: bit(5), // always use position sent in packet
} as const;
export type SoundchanT = number;

// sound attenuation values
export const ATTN_LOOP_NONE = -1; // full volume the entire level, for loop only
export const ATTN_NONE = 0; // full volume the entire level, for sounds only
export const ATTN_NORM = 1;
export const ATTN_IDLE = 2;
export const ATTN_STATIC = 3; // diminish very rapidly with distance

// total stat count. DIFFERS from q_shared.ts's `MAX_STATS` (32): the kex
// protocol widened this to 64.
export const MAX_STATS = 64;

//=============================================
// INFO STRINGS
//
// NB: the Q2 protocol does not dictate the type
// of strings being used, so it's kind of a crapshoot.
// Kex's protocol assumes info strings are always UTF8.
//=============================================

//
// key / value info strings
//
export const MAX_INFO_KEY = 64;
export const MAX_INFO_VALUE = 256;
export const MAX_INFO_STRING = 2048;

// CONFIG STRINGS

// bound by number of things we can fit in two stats
export const MAX_WHEEL_ITEMS = 32;

// CS_WHEEL_xxx are special configstrings that
// map individual weapon and ammo ids to each other, separated by a pipe |
// the format for CS_WHEEL_WEAPONS is:
// <CS_ITEMS INDEX>|<CS_IMAGES INDEX>|<CS_WHEEL_AMMO INDEX>|<min ammo>|<on powerup wheel>|<sort id>|<warn quantity>|<droppable>
// if the weapon does not take ammo, the index will be -1
// the format for CS_WHEEL_AMMO is:
// <CS_ITEMS INDEX>|<CS_IMAGES INDEX>
// the indices here are not related to the IT_ or AMMO_
// indices, and are just as they appear in the configstrings.
// the format for CS_WHEEL_POWERUP is:
// <CS_ITEMS INDEX>|<CS_IMAGES INDEX>|<USE ON/OFF INSTEAD OF COUNT>|<SORT_ID>|<DROPPABLE>|<AMMO, IF APPLICABLE>

export enum GameStyleT {
  GAME_STYLE_PVE,
  GAME_STYLE_FFA,
  GAME_STYLE_TDM,
}

//
// config strings are a general means of communication from
// the server to all connected clients.
// Each config string can be at most CS_MAX_STRING_LENGTH characters.
//
// (unnamed C enum; ported as flat constants computed from the MAX_* limits
// above, matching q_shared.ts's own convention for its CS_* block.)
export const CS_NAME = 0;
export const CS_CDTRACK = 1;
export const CS_SKY = 2;
export const CS_SKYAXIS = 3; // %f %f %f format
export const CS_SKYROTATE = 4;
export const CS_STATUSBAR = 5; // display program string

export const CS_AIRACCEL = 59; // air acceleration control
export const CS_MAXCLIENTS = 60;
export const CS_MAPCHECKSUM = 61; // for catching cheater maps

export const CS_MODELS = 62;
export const CS_SOUNDS = CS_MODELS + MAX_MODELS;
export const CS_IMAGES = CS_SOUNDS + MAX_SOUNDS;
export const CS_LIGHTS = CS_IMAGES + MAX_IMAGES;
export const CS_SHADOWLIGHTS = CS_LIGHTS + MAX_LIGHTSTYLES; // [Sam-KEX]
export const CS_ITEMS = CS_SHADOWLIGHTS + MAX_SHADOW_LIGHTS;
export const CS_PLAYERSKINS = CS_ITEMS + MAX_ITEMS;
export const CS_GENERAL = CS_PLAYERSKINS + MAX_CLIENTS;
export const CS_WHEEL_WEAPONS = CS_GENERAL + MAX_GENERAL; // [Paril-KEX] see MAX_WHEEL_ITEMS
export const CS_WHEEL_AMMO = CS_WHEEL_WEAPONS + MAX_WHEEL_ITEMS; // [Paril-KEX] see MAX_WHEEL_ITEMS
export const CS_WHEEL_POWERUPS = CS_WHEEL_AMMO + MAX_WHEEL_ITEMS; // [Paril-KEX] see MAX_WHEEL_ITEMS
export const CS_CD_LOOP_COUNT = CS_WHEEL_POWERUPS + MAX_WHEEL_ITEMS; // [Paril-KEX] override default loop count
export const CS_GAME_STYLE = CS_CD_LOOP_COUNT + 1; // [Paril-KEX] see game_style_t
export const MAX_CONFIGSTRINGS = CS_GAME_STYLE + 1;

// [Sam-KEX] New define for max config string length
export const CS_MAX_STRING_LENGTH = 96;
export const CS_MAX_STRING_LENGTH_OLD = 64;

// `CS_SIZE(int32_t)` is a real constexpr FUNCTION with branching logic (not
// a type or simple constant); intentionally not ported (see file header).

export const MAX_MODELS_OLD = 256;
export const MAX_SOUNDS_OLD = 256;
export const MAX_IMAGES_OLD = 256;

export const CS_NAME_OLD = 0;
export const CS_CDTRACK_OLD = 1;
export const CS_SKY_OLD = 2;
export const CS_SKYAXIS_OLD = 3; // %f %f %f format
export const CS_SKYROTATE_OLD = 4;
export const CS_STATUSBAR_OLD = 5; // display program string

export const CS_AIRACCEL_OLD = 29; // air acceleration control
export const CS_MAXCLIENTS_OLD = 30;
export const CS_MAPCHECKSUM_OLD = 31; // for catching cheater maps

export const CS_MODELS_OLD = 32;
export const CS_SOUNDS_OLD = CS_MODELS_OLD + MAX_MODELS_OLD;
export const CS_IMAGES_OLD = CS_SOUNDS_OLD + MAX_SOUNDS_OLD;
export const CS_LIGHTS_OLD = CS_IMAGES_OLD + MAX_IMAGES_OLD;
export const CS_ITEMS_OLD = CS_LIGHTS_OLD + MAX_LIGHTSTYLES;
export const CS_PLAYERSKINS_OLD = CS_ITEMS_OLD + MAX_ITEMS;
export const CS_GENERAL_OLD = CS_PLAYERSKINS_OLD + MAX_CLIENTS;
export const MAX_CONFIGSTRINGS_OLD = CS_GENERAL_OLD + MAX_GENERAL;

// remaps old configstring IDs to new ones for old DLL & demo support.
// `CS_REMAP(int32_t)` (the function that produces these) is behavior, not a
// type, and is intentionally not ported -- see file header.
export interface ConfigstringRemapT {
  // start position in the configstring list to write into
  start: number;
  // max length to write into; [start+length-1] should always be set to '\0'
  length: number;
}

//==============================================

// entity_state_t->event values. DIFFERS from q_shared.ts's `EntityEventT`:
// kex adds EV_OTHER_FOOTSTEP and EV_LADDER_STEP.
export enum KexEntityEventT {
  EV_NONE,
  EV_ITEM_RESPAWN,
  EV_FOOTSTEP,
  EV_FALLSHORT,
  EV_FALL,
  EV_FALLFAR,
  EV_PLAYER_TELEPORT,
  EV_OTHER_TELEPORT,

  // [Paril-KEX]
  EV_OTHER_FOOTSTEP,
  EV_LADDER_STEP,
}

// [Paril-KEX] player s.skinnum's encode additional data.
// C++ `union player_skinnum_t` unions a raw int32 with a 4-field bitfield
// struct; TS has neither unions nor bitfields, so this is ported as a flat
// interface exposing both the raw packed value and the individual logical
// fields (see file header "OTHER DEVIATIONS").
export interface KexPlayerSkinnumT {
  skinnum: number; // int32_t; raw packed value
  client_num: Byte; // client index
  vwep_index: Byte; // vwep index
  viewheight: number; // int8_t
  team_index: Byte; // 4 bits: team #; note that teams are 1-indexed here, with 0 meaning no team
  // (spectators in CTF would be 0, for instance)
  poi_icon: Byte; // 4 bits: poi icon; 0 default friendly, 1 dead, others unused
}

// entity_state_t is the information conveyed from the server
// in an update message about entities that the client will
// need to render in some way.
//
// DIFFERS extensively from q_shared.ts's `EntityStateT`: kex's `effects` is
// 64-bit (bigint), and kex adds alpha/scale/instance_bits/loop_volume/
// loop_attenuation/owner/old_frame.
export interface KexEntityStateT {
  number: number; // uint32_t; edict index

  origin: Vec3;
  angles: Vec3;
  old_origin: Vec3; // for lerping
  modelindex: number;
  modelindex2: number;
  modelindex3: number;
  modelindex4: number; // weapons, CTF flags, etc
  frame: number;
  skinnum: number;
  effects: EffectsT; // PGM - we're filling it, so it needs to be unsigned
  renderfx: RenderfxT;
  solid: number; // uint32_t; for client side prediction
  sound: number; // for looping sounds, to guarantee shutoff
  event: KexEntityEventT; // impulse events -- muzzle flashes, footsteps, etc
  // events only go out for a single frame, they
  // are automatically cleared each frame
  alpha: number; // [Paril-KEX] alpha scalar; 0 is a "default" value, which will respect other
  // settings (default 1.0 for most things, EF_TRANSLUCENT will default this
  // to 0.3, etc)
  scale: number; // [Paril-KEX] model scale scalar; 0 is a "default" value, like with alpha.
  instance_bits: Byte; // [Paril-KEX] players that *can't* see this entity will have a bit of 1. handled by
  // the server, do not set directly.
  // [Paril-KEX] allow specifying volume/attn for looping noises; note that
  // zero will be defaults (1.0 and 3.0 respectively); -1 attenuation is used
  // for "none" (similar to target_speaker) for no phs/pvs looping noises
  loop_volume: number;
  loop_attenuation: number;
  // [Paril-KEX] for proper client-side owner collision skipping
  owner: number;
  // [Paril-KEX] for custom interpolation stuff
  old_frame: number;
}

//==============================================

// player_state_t is the information needed in addition to pmove_state_t
// to rendered a view. There will only be 10 player_state_t sent each second,
// but the number of pmove_state_t changes will be relative to client
// frame rates.
//
// DIFFERS from q_shared.ts's `PlayerStateT`: kex adds gunskin/gunrate,
// splits screen_blend into screen_blend/damage_blend, and adds team_id.
export interface KexPlayerStateT {
  pmove: KexPmoveStateT; // for prediction

  // these fields do not need to be communicated bit-precise

  viewangles: Vec3; // for fixed views
  viewoffset: Vec3; // add to pmovestate->origin
  kick_angles: Vec3; // add to view direction to get render angles
  // set by weapon kicks, pain effects, etc

  gunangles: Vec3;
  gunoffset: Vec3;
  gunindex: number;
  gunskin: number; // [Paril-KEX] gun skin #
  gunframe: number;
  gunrate: number; // [Paril-KEX] tickrate of gun animations; 0 and 10 are equivalent

  screen_blend: Vec4; // rgba full screen effect
  damage_blend: Vec4; // [Paril-KEX] rgba damage blend effect

  fov: number; // horizontal field of view

  rdflags: RefdefFlagsT; // refdef flags

  stats: Int16Array; // fast status bar updates; length MAX_STATS

  team_id: Byte; // team identifier
}

// protocol bytes that can be directly added to messages
export enum ServerCommandT {
  svc_bad,

  svc_muzzleflash,
  svc_muzzleflash2,
  svc_temp_entity,
  svc_layout,
  svc_inventory,

  svc_nop,
  svc_disconnect,
  svc_reconnect,
  svc_sound, // <see code>
  svc_print, // [byte] id [string] null terminated string
  svc_stufftext, // [string] stuffed into client's console buffer, should be \n terminated
  svc_serverdata, // [long] protocol ...
  svc_configstring, // [short] [string]
  svc_spawnbaseline,
  svc_centerprint, // [string] to put in center of the screen
  svc_download, // [short] size [size bytes]
  svc_playerinfo, // variable
  svc_packetentities, // [...]
  svc_deltapacketentities, // [...]
  svc_frame,

  svc_splitclient,

  svc_configblast, // [Kex] A compressed version of svc_configstring
  svc_spawnbaselineblast, // [Kex] A compressed version of svc_spawnbaseline
  svc_level_restart, // [Paril-KEX] level was soft-rebooted
  svc_damage, // [Paril-KEX] damage indicators
  svc_locprint, // [Kex] localized + libfmt version of print
  svc_fog, // [Paril-KEX] change current fog values
  svc_waitingforplayers, // [Kex-Edward] Inform clients that the server is waiting for remaining players
  svc_bot_chat, // [Kex] bot specific chat
  svc_poi, // [Paril-KEX] point of interest
  svc_help_path, // [Paril-KEX] help path
  svc_muzzleflash3, // [Paril-KEX] muzzleflashes, but ushort id
  svc_achievement, // [Paril-KEX]

  svc_last, // only for checks
}

export enum SvcPoiFlagsT {
  POI_FLAG_NONE = 0,
  POI_FLAG_HIDE_ON_AIM = 1, // hide the POI if we get close to it with our aim
}

// data for svc_fog
export const SvcFogDataBitsT = {
  // global fog
  BIT_DENSITY: bit(0),
  BIT_R: bit(1),
  BIT_G: bit(2),
  BIT_B: bit(3),
  BIT_TIME: bit(4), // if set, the transition takes place over N milliseconds

  // height fog
  BIT_HEIGHTFOG_FALLOFF: bit(5),
  BIT_HEIGHTFOG_DENSITY: bit(6),
  BIT_MORE_BITS: bit(7), // read additional bit
  BIT_HEIGHTFOG_START_R: bit(8),
  BIT_HEIGHTFOG_START_G: bit(9),
  BIT_HEIGHTFOG_START_B: bit(10),
  BIT_HEIGHTFOG_START_DIST: bit(11),
  BIT_HEIGHTFOG_END_R: bit(12),
  BIT_HEIGHTFOG_END_G: bit(13),
  BIT_HEIGHTFOG_END_B: bit(14),
  BIT_HEIGHTFOG_END_DIST: bit(15),
} as const;
export type SvcFogDataBitsT = number;

export interface SvcFogDataT {
  bits: SvcFogDataBitsT;
  density: number; // bits & BIT_DENSITY
  skyfactor: Byte; // bits & BIT_DENSITY
  red: Byte; // bits & BIT_R
  green: Byte; // bits & BIT_G
  blue: Byte; // bits & BIT_B
  time: number; // uint16_t; bits & BIT_TIME

  hf_falloff: number; // bits & BIT_HEIGHTFOG_FALLOFF
  hf_density: number; // bits & BIT_HEIGHTFOG_DENSITY
  hf_start_r: Byte; // bits & (BIT_MORE_BITS | BIT_HEIGHTFOG_START_R)
  hf_start_g: Byte; // bits & (BIT_MORE_BITS | BIT_HEIGHTFOG_START_G)
  hf_start_b: Byte; // bits & (BIT_MORE_BITS | BIT_HEIGHTFOG_START_B)
  hf_start_dist: number; // bits & (BIT_MORE_BITS | BIT_HEIGHTFOG_START_DIST)
  hf_end_r: Byte; // bits & (BIT_MORE_BITS | BIT_HEIGHTFOG_END_R)
  hf_end_g: Byte; // bits & (BIT_MORE_BITS | BIT_HEIGHTFOG_END_G)
  hf_end_b: Byte; // bits & (BIT_MORE_BITS | BIT_HEIGHTFOG_END_B)
  hf_end_dist: number; // bits & (BIT_MORE_BITS | BIT_HEIGHTFOG_END_DIST)
}

// bit masks
export const BITS_GLOBAL_FOG: SvcFogDataBitsT =
  SvcFogDataBitsT.BIT_DENSITY | SvcFogDataBitsT.BIT_R | SvcFogDataBitsT.BIT_G | SvcFogDataBitsT.BIT_B;
export const BITS_HEIGHTFOG: SvcFogDataBitsT =
  SvcFogDataBitsT.BIT_HEIGHTFOG_FALLOFF |
  SvcFogDataBitsT.BIT_HEIGHTFOG_DENSITY |
  SvcFogDataBitsT.BIT_HEIGHTFOG_START_R |
  SvcFogDataBitsT.BIT_HEIGHTFOG_START_G |
  SvcFogDataBitsT.BIT_HEIGHTFOG_START_B |
  SvcFogDataBitsT.BIT_HEIGHTFOG_START_DIST |
  SvcFogDataBitsT.BIT_HEIGHTFOG_END_R |
  SvcFogDataBitsT.BIT_HEIGHTFOG_END_G |
  SvcFogDataBitsT.BIT_HEIGHTFOG_END_B |
  SvcFogDataBitsT.BIT_HEIGHTFOG_END_DIST;

// edict->svflags
export const SvflagsT = {
  SVF_NONE: 0, // no serverflags
  SVF_NOCLIENT: bit(0), // don't send entity to clients, even if it has effects
  SVF_DEADMONSTER: bit(1), // treat as CONTENTS_DEADMONSTER for collision
  SVF_MONSTER: bit(2), // treat as CONTENTS_MONSTER for collision
  SVF_PLAYER: bit(3), // [Paril-KEX] treat as CONTENTS_PLAYER for collision
  SVF_BOT: bit(4), // entity is controlled by a bot AI.
  SVF_NOBOTS: bit(5), // don't allow bots to use/interact with entity
  SVF_RESPAWNING: bit(6), // entity will respawn on it's next think.
  SVF_PROJECTILE: bit(7), // treat as CONTENTS_PROJECTILE for collision
  SVF_INSTANCED: bit(8), // entity has different visibility per player
  SVF_DOOR: bit(9), // entity is a door of some kind
  SVF_NOCULL: bit(10), // always send, even if we normally wouldn't
  SVF_HULL: bit(11), // always use hull when appropriate (triggers, etc; for gi.clip)
} as const;
export type SvflagsT = number;

// edict->solid values (defined in q_shared.h upstream, not in game.h itself
// -- no existing TS port of q_shared.h's solid_t exists to reuse, so this is
// a fresh definition local to this module).
export enum SolidT {
  SOLID_NOT, // no interaction with other objects
  SOLID_TRIGGER, // only touch when inside, after moving
  SOLID_BBOX, // touch on edge
  SOLID_BSP, // bsp clip, touch on edge
}

// bitflags for STAT_LAYOUTS
export const LayoutFlagsT = {
  LAYOUTS_LAYOUT: bit(0), // svc_layout is active; escape remapped to putaway
  LAYOUTS_INVENTORY: bit(1), // inventory is active; escape remapped to putaway
  LAYOUTS_HIDE_HUD: bit(2), // hide entire hud, for cameras, etc
  LAYOUTS_INTERMISSION: bit(3), // intermission is being drawn; collapse splitscreen into 1 view
  LAYOUTS_HELP: bit(4), // help is active; escape remapped to putaway
  LAYOUTS_HIDE_CROSSHAIR: bit(5), // hide crosshair only
} as const;
export type LayoutFlagsT = number;

export enum GoalReturnCode {
  Error = 0,
  Started,
  InProgress,
  Finished,
}

export enum GestureType {
  GESTURE_NONE = -1,
  GESTURE_FLIP_OFF,
  GESTURE_SALUTE,
  GESTURE_TAUNT,
  GESTURE_WAVE,
  GESTURE_POINT,
  GESTURE_POINT_NO_PING,
  GESTURE_MAX,
}

export enum PathReturnCode {
  ReachedGoal = 0, // we're at our destination
  ReachedPathEnd, // we're as close to the goal as we can get with a path
  TraversalPending, // the upcoming path segment is a traversal
  RawPathFound, // user wanted ( and got ) just a raw path ( no processing )
  InProgress, // pathing in progress
  StartPathErrors, // any code after this one indicates an error of some kind.
  InvalidStart, // start position is invalid.
  InvalidGoal, // goal position is invalid.
  NoNavAvailable, // no nav file available for this map.
  NoStartNode, // can't find a nav node near the start position
  NoGoalNode, // can't find a nav node near the goal position
  NoPathFound, // can't find a path from the start to the goal
  MissingWalkOrSwimFlag, // MUST have at least Walk or Water path flags set!
}

export enum PathLinkType {
  Walk, // can walk between the path points
  WalkOffLedge, // will walk off a ledge going between path points
  LongJump, // will need to perform a long jump between path points
  BarrierJump, // will need to jump over a low barrier between path points
  Elevator, // will need to use an elevator between path points
}

export const PathFlags = {
  All: 0xffffffff, // static_cast<uint32_t>(-1)
  Water: bit(0), // swim to your goal ( useful for fish/gekk/etc. )
  Walk: bit(1), // walk to your goal
  WalkOffLedge: bit(2), // allow walking over ledges
  LongJump: bit(3), // allow jumping over gaps
  BarrierJump: bit(4), // allow jumping over low barriers
  Elevator: bit(5), // allow using elevators
} as const;
export type PathFlags = number;

export interface PathRequestDebugSettings {
  drawTime: number; // default 0.0f; if > 0, how long ( in seconds ) to draw path in world
}

export interface PathRequestNodeSettings {
  ignoreNodeFlags: boolean; // default false; true = ignore node flags when considering nodes
  minHeight: number; // default 0.0f; 0 <= use default values
  maxHeight: number; // default 0.0f; 0 <= use default values
  radius: number; // default 0.0f; 0 <= use default values
}

export interface PathRequestTraversalSettings {
  dropHeight: number; // default 0.0f; 0 = don't drop down
  jumpHeight: number; // default 0.0f; 0 = don't jump up
}

export interface PathRequestPathArray {
  array: Vec3[] | null; // default null; array to store raw path points ("mutable" in C++, no TS meaning)
  count: number; // int64_t; default 0; number of elements in array
}

export interface PathRequest {
  start: Vec3; // default (0,0,0)
  goal: Vec3; // default (0,0,0)
  pathFlags: PathFlags; // default PathFlags.Walk
  moveDist: number; // default 0.0f
  debugging: PathRequestDebugSettings;
  nodeSearch: PathRequestNodeSettings;
  traversals: PathRequestTraversalSettings;
  pathPoints: PathRequestPathArray;
}

export interface PathInfo {
  numPathPoints: number; // default 0
  pathDistSqr: number; // default 0.0f
  firstMovePoint: Vec3; // default (0,0,0)
  secondMovePoint: Vec3; // default (0,0,0)
  pathLinkType: PathLinkType; // default PathLinkType.Walk
  returnCode: PathReturnCode; // default PathReturnCode.StartPathErrors
}

//===============================================================

export const MODELINDEX_WORLD = 1; // special index for world
export const MODELINDEX_PLAYER = MAX_MODELS_OLD - 1; // special index for player models

// short stub only used by the engine; the game DLL's version must be
// compatible with this. (C: `gclient_t` / `gclient_shared_t` depending on
// whether GAME_INCLUDE is defined -- both names refer to the same shape.)
export interface KexGclientT {
  ps: KexPlayerStateT; // communicated by server to clients
  ping: number;
  // the game dll can add anything it wants after this point in the structure
}

export const Team_None = 0;
export const Item_UnknownRespawnTime = 2147483647; // INT_MAX
export const Item_Invalid = -1;
export const Item_Null = 0;

// `sv_ent_flags_t : uint64_t` -- BIGINT (see bit-width audit in file header).
export const SvEntFlagsT = {
  SVFL_NONE: 0n, // no flags
  SVFL_ONGROUND: bitBig(0),
  SVFL_HAS_DMG_BOOST: bitBig(1),
  SVFL_HAS_PROTECTION: bitBig(2),
  SVFL_HAS_INVISIBILITY: bitBig(3),
  SVFL_IS_JUMPING: bitBig(4),
  SVFL_IS_CROUCHING: bitBig(5),
  SVFL_IS_ITEM: bitBig(6),
  SVFL_IS_OBJECTIVE: bitBig(7),
  SVFL_HAS_TELEPORTED: bitBig(8),
  SVFL_TAKES_DAMAGE: bitBig(9),
  SVFL_IS_HIDDEN: bitBig(10),
  SVFL_IS_NOCLIP: bitBig(11),
  SVFL_IN_WATER: bitBig(12),
  SVFL_NO_TARGET: bitBig(13),
  SVFL_GOD_MODE: bitBig(14),
  SVFL_IS_FLIPPING_OFF: bitBig(15),
  SVFL_IS_SALUTING: bitBig(16),
  SVFL_IS_TAUNTING: bitBig(17),
  SVFL_IS_WAVING: bitBig(18),
  SVFL_IS_POINTING: bitBig(19),
  SVFL_ON_LADDER: bitBig(20),
  SVFL_MOVESTATE_TOP: bitBig(21),
  SVFL_MOVESTATE_BOTTOM: bitBig(22),
  SVFL_MOVESTATE_MOVING: bitBig(23),
  SVFL_IS_LOCKED_DOOR: bitBig(24),
  SVFL_CAN_GESTURE: bitBig(25),
  SVFL_WAS_TELEFRAGGED: bitBig(26),
  SVFL_TRAP_DANGER: bitBig(27),
  SVFL_ACTIVE: bitBig(28),
  SVFL_IS_SPECTATOR: bitBig(29),
  SVFL_IN_TEAM: bitBig(30),
} as const;
export type SvEntFlagsT = bigint;

export const Max_Armor_Types = 3;

export interface ArmorInfoT {
  item_id: number; // default Item_Null
  max_count: number; // default 0
}

// Used by AI/Tools on the engine side...
export interface SvEntityT {
  init: boolean;
  ent_flags: SvEntFlagsT;
  buttons: ButtonT;
  spawnflags: number; // uint32_t
  item_id: number;
  armor_type: number;
  armor_value: number;
  health: number;
  max_health: number;
  starting_health: number;
  weapon: number;
  team: number;
  lobby_usernum: number;
  respawntime: number;
  viewheight: number;
  last_attackertime: number;
  waterlevel: WaterLevelT;
  viewangles: Vec3;
  viewforward: Vec3;
  velocity: Vec3;
  start_origin: Vec3;
  end_origin: Vec3;
  enemy: KexEdictT | null;
  ground_entity: KexEdictT | null;
  classname: string | null;
  targetname: string | null;
  netname: string; // char[MAX_NETNAME]
  inventory: Int32Array; // length MAX_ITEMS, default all-zero
  armor_info: ArmorInfoT[]; // length Max_Armor_Types
}

// short stub only used by the engine; the game DLL's version must be
// compatible with this. (C: `edict_t` / `edict_shared_t` depending on
// whether GAME_INCLUDE is defined -- both names refer to the same shape.)
export interface KexEdictT {
  s: KexEntityStateT;
  client: KexGclientT | null; // nullptr if not a player
  // the server expects the first part
  // of gclient_t to be a player_state_t
  // but the rest of it is opaque

  sv: SvEntityT; // read only info about this entity for the server

  inuse: boolean;

  // world linkage data
  linked: boolean;
  linkcount: number;
  areanum: number;
  areanum2: number;

  svflags: SvflagsT;
  mins: Vec3;
  maxs: Vec3;
  absmin: Vec3;
  absmax: Vec3;
  size: Vec3;
  solid: SolidT;
  clipmask: ContentsT;
  owner: KexEdictT | null;
}

// `CHECK_INTEGRITY`/`CHECK_GCLIENT_INTEGRITY`/`CHECK_EDICT_INTEGRITY` are
// compile-time layout-agreement checks between the GAME_INCLUDE and non-
// GAME_INCLUDE views of gclient_t/edict_t; omitted (see file header).

//===============================================================

// file system stuff. Plain uint64_t alias, not a bitflag enum -- represented
// as `number` per the file header's "non-enum 64-bit fields" note.
export type FsHandleT = number;

export const FsSearchFlagsT = {
  FS_SEARCH_NONE: 0,

  // flags for individual file filtering; note that if none
  // of these are set, they will all apply.
  FS_SEARCH_FOR_DIRECTORIES: bit(0), // only get directories
  FS_SEARCH_FOR_FILES: bit(1), // only get files
} as const;
export type FsSearchFlagsT = number;

export const BoxEdictsResultT = {
  Keep: 0, // keep the given entity in the result and keep looping
  Skip: 1, // skip the given entity

  End: 64, // stop searching any further

  Flags: 64, // === End
} as const;
export type BoxEdictsResultT = number;

export type BoxEdictsFilterT = (ent: KexEdictT | null, filterData: unknown) => BoxEdictsResultT;

//
// functions provided by the main engine
//
export interface KexGameImports {
  tick_rate: number; // uint32_t
  frame_time_s: number;
  frame_time_ms: number; // uint32_t

  // broadcast to all clients
  Broadcast_Print(printlevel: PrintTypeT, message: string): void;

  // print to appropriate places (console, log file, etc)
  Com_Print(msg: string): void;

  // print directly to a single client (or nullptr for server console)
  Client_Print(ent: KexEdictT | null, printlevel: PrintTypeT, message: string): void;

  // center-print to player (legacy function)
  Center_Print(ent: KexEdictT | null, message: string): void;

  sound(ent: KexEdictT | null, channel: SoundchanT, soundindex: number, volume: number, attenuation: number, timeofs: number): void;
  positioned_sound(
    origin: Vec3,
    ent: KexEdictT | null,
    channel: SoundchanT,
    soundindex: number,
    volume: number,
    attenuation: number,
    timeofs: number,
  ): void;
  // [Paril-KEX] like sound, but only send to the player indicated by the parameter;
  // this is mainly to handle split screen properly
  local_sound(
    target: KexEdictT | null,
    origin: Vec3 | null,
    ent: KexEdictT | null,
    channel: SoundchanT,
    soundindex: number,
    volume: number,
    attenuation: number,
    timeofs: number,
    dupe_key: number,
  ): void;

  // config strings hold all the index strings, the lightstyles,
  // and misc data like the sky definition and cdtrack.
  // All of the current configstrings are sent to clients when
  // they connect, and changes are sent to all connected clients.
  configstring(num: number, str: string): void;
  get_configstring(num: number): string;

  Com_Error(message: string): never;

  // the *index functions create configstrings and some internal server state
  modelindex(name: string): number;
  soundindex(name: string): number;
  // [Paril-KEX] imageindex can precache both pics for the HUD and
  // textures used for RF_CUSTOMSKIN; to register an image as a texture,
  // the path must be relative to the mod dir and end in an extension
  // ie models/my_model/skin.tga
  imageindex(name: string): number;

  setmodel(ent: KexEdictT | null, name: string): void;

  // collision detection
  trace(start: Vec3, mins: Vec3 | null, maxs: Vec3 | null, end: Vec3, passent: KexEdictT | null, contentmask: ContentsT): KexTraceT;
  // [Paril-KEX] clip the box against the specified entity
  clip(entity: KexEdictT | null, start: Vec3, mins: Vec3 | null, maxs: Vec3 | null, end: Vec3, contentmask: ContentsT): KexTraceT;
  pointcontents(point: Vec3): ContentsT;
  inPVS(p1: Vec3, p2: Vec3, portals: boolean): boolean;
  inPHS(p1: Vec3, p2: Vec3, portals: boolean): boolean;
  SetAreaPortalState(portalnum: number, open: boolean): void;
  AreasConnected(area1: number, area2: number): boolean;

  // an entity will never be sent to a client or used for collision
  // if it is not passed to linkentity.  If the size, position, or
  // solidity changes, it must be relinked.
  linkentity(ent: KexEdictT | null): void;
  unlinkentity(ent: KexEdictT | null): void; // call before removing an interactive edict

  // return a list of entities that touch the input absmin/absmax.
  // if maxcount is 0, it will return a count but not attempt to fill "list".
  // if maxcount > 0, once it reaches maxcount, it will keep going but not fill
  // any more of list (the return count will cap at maxcount).
  // the filter function can remove unnecessary entities from the final list; it is illegal
  // to modify world links in this callback.
  BoxEdicts(
    mins: Vec3,
    maxs: Vec3,
    list: (KexEdictT | null)[],
    maxcount: number,
    areatype: SolidityAreaT,
    filter: BoxEdictsFilterT | null,
    filter_data: unknown,
  ): number;

  // network messaging
  multicast(origin: Vec3, to: KexMulticastT, reliable: boolean): void;
  // [Paril-KEX] `dupe_key` is a key unique to a group of calls to unicast
  // that will prevent sending the message on this frame with the same key
  // to the same player (for splitscreen players).
  unicast(ent: KexEdictT | null, reliable: boolean, dupe_key: number): void;

  WriteChar(c: number): void;
  WriteByte(c: number): void;
  WriteShort(c: number): void;
  WriteLong(c: number): void;
  WriteFloat(f: number): void;
  WriteString(s: string): void;
  WritePosition(pos: Vec3): void;
  WriteDir(pos: Vec3): void; // single byte encoded, very coarse
  WriteAngle(f: number): void; // legacy 8-bit angle
  WriteEntity(e: KexEdictT | null): void;

  // managed memory allocation
  TagMalloc(size: number, tag: number): unknown;
  TagFree(block: unknown): void;
  FreeTags(tag: number): void;

  // console variable interaction
  cvar(var_name: string, value: string | null, flags: CvarFlagsT): CvarT | null;
  cvar_set(var_name: string, value: string): CvarT | null;
  cvar_forceset(var_name: string, value: string): CvarT | null;

  // ClientCommand and ServerCommand parameter access
  argc(): number;
  argv(n: number): string;
  args(): string; // concatenation of all argv >= 1

  // add commands to the server console as if they were typed in
  // for map changing, etc
  AddCommandString(text: string): void;

  DebugGraph(value: number, color: number): void;

  // Fetch named extension from engine.
  GetExtension(name: string): unknown;

  // === [KEX] Additional APIs ===

  // bots
  Bot_RegisterEdict(edict: KexEdictT | null): void;
  Bot_UnRegisterEdict(edict: KexEdictT | null): void;
  Bot_MoveToPoint(bot: KexEdictT | null, point: Vec3, moveTolerance: number): GoalReturnCode;
  Bot_FollowActor(bot: KexEdictT | null, actor: KexEdictT | null): GoalReturnCode;

  // pathfinding - returns true if a path was found
  GetPathToGoal(request: PathRequest, info: PathInfo): boolean;

  // localization
  Loc_Print(ent: KexEdictT | null, level: PrintTypeT, base: string, args: string[], num_args: number): void;

  // drawing
  Draw_Line(start: Vec3, end: Vec3, color: RgbaT, lifeTime: number, depthTest: boolean): void;
  Draw_Point(point: Vec3, size: number, color: RgbaT, lifeTime: number, depthTest: boolean): void;
  Draw_Circle(origin: Vec3, radius: number, color: RgbaT, lifeTime: number, depthTest: boolean): void;
  Draw_Bounds(mins: Vec3, maxs: Vec3, color: RgbaT, lifeTime: number, depthTest: boolean): void;
  Draw_Sphere(origin: Vec3, radius: number, color: RgbaT, lifeTime: number, depthTest: boolean): void;
  Draw_OrientedWorldText(origin: Vec3, text: string, color: RgbaT, size: number, lifeTime: number, depthTest: boolean): void;
  Draw_StaticWorldText(origin: Vec3, angles: Vec3, text: string, color: RgbaT, size: number, lifeTime: number, depthTest: boolean): void;
  Draw_Cylinder(origin: Vec3, halfHeight: number, radius: number, color: RgbaT, lifeTime: number, depthTest: boolean): void;
  Draw_Ray(origin: Vec3, direction: Vec3, length: number, size: number, color: RgbaT, lifeTime: number, depthTest: boolean): void;
  Draw_Arrow(start: Vec3, end: Vec3, size: number, lineColor: RgbaT, arrowColor: RgbaT, lifeTime: number, depthTest: boolean): void;

  // scoreboard
  ReportMatchDetails_Multicast(is_end: boolean): void;

  // get server frame #
  ServerFrame(): number;

  // misc utils
  SendToClipBoard(text: string): void;

  // info string stuff
  Info_ValueForKey(s: string, key: string, buffer: [string], buffer_len: number): number;
  Info_RemoveKey(s: [string], key: string): boolean;
  Info_SetValueForKey(s: [string], key: string, value: string): boolean;
}

export enum ShadowLightTypeT {
  point,
  cone,
}

export interface ShadowLightDataT {
  lighttype: ShadowLightTypeT;
  radius: number;
  resolution: number;
  intensity: number; // default 1
  fade_start: number;
  fade_end: number;
  lightstyle: number; // default -1
  coneangle: number; // default 45
  conedirection: Vec3;
}

export const ServerFlagsT = {
  SERVER_FLAGS_NONE: 0,
  SERVER_FLAG_SLOW_TIME: bit(0),
  SERVER_FLAG_INTERMISSION: bit(1),
  SERVER_FLAG_LOADING: bit(2),
} as const;
export type ServerFlagsT = number;

//
// functions exported by the game subsystem
//
export interface KexGameExports {
  apiversion: number;

  // the init function will only be called when a game starts,
  // not each time a level is loaded.  Persistant data for clients
  // and the server can be allocated in init
  PreInit(): void; // [Paril-KEX] called before InitGame, to potentially change maxclients
  Init(): void;
  Shutdown(): void;

  // each new level entered will cause a call to SpawnEntities
  SpawnEntities(mapname: string, entstring: string, spawnpoint: string): void;

  // Read/Write Game is for storing persistant cross level information
  // about the world state and the clients.
  // WriteGame is called every time a level is exited.
  // ReadGame is called on a loadgame.

  // returns pointer to tagmalloc'd allocated string.
  // tagfree after use
  WriteGameJson(autosave: boolean, out_size: [number]): string | null;
  ReadGameJson(json: string): void;

  // ReadLevel is called after the default map information has been
  // loaded with SpawnEntities
  // returns pointer to tagmalloc'd allocated string.
  // tagfree after use
  WriteLevelJson(transition: boolean, out_size: [number]): string | null;
  ReadLevelJson(json: string): void;

  // [Paril-KEX] game can tell the server whether a save is allowed
  // currently or not.
  CanSave(): boolean;

  // [Paril-KEX] choose a free gclient_t slot for the given social ID; for
  // coop slot re-use. Return nullptr if none is available. You can not
  // return a slot that is currently in use by another client; that must
  // throw a fatal error.
  ClientChooseSlot(
    userinfo: string,
    social_id: string,
    isBot: boolean,
    ignore: (KexEdictT | null)[],
    num_ignore: number,
    cinematic: boolean,
  ): KexEdictT | null;
  ClientConnect(ent: KexEdictT | null, userinfo: [string], social_id: string, isBot: boolean): boolean;
  ClientBegin(ent: KexEdictT | null): void;
  ClientUserinfoChanged(ent: KexEdictT | null, userinfo: string): void;
  ClientDisconnect(ent: KexEdictT | null): void;
  ClientCommand(ent: KexEdictT | null): void;
  ClientThink(ent: KexEdictT | null, cmd: KexUsercmdT | null): void;

  RunFrame(main_loop: boolean): void;
  // [Paril-KEX] allow the game DLL to clear per-frame stuff
  PrepFrame(): void;

  // ServerCommand will be called when an "sv <command>" command is issued on the
  // server console.
  // The game can issue gi.argc() / gi.argv() commands to get the rest
  // of the parameters
  ServerCommand(): void;

  //
  // global variables shared between game and server
  //

  // The C struct holds `edict_t *edicts` (a pointer to a block sized by
  // `edict_size` since the game DLL's edict_t is larger than the server's)
  // plus `edict_size` for pointer arithmetic when walking the array.
  // TypeScript arrays need no element stride, so this reshapes the
  // pointer+size pair into a plain array of full edicts; `edict_size` is
  // dropped entirely, mirroring the same idiom src/game/game.ts already
  // documents for its (vanilla) GameExports.edicts field.
  edicts: KexEdictT[];
  num_edicts: number; // uint32_t; current number, <= max_edicts
  max_edicts: number; // uint32_t

  // [Paril-KEX] special flags to indicate something to the server
  server_flags: ServerFlagsT;

  // [KEX]: Pmove as export
  Pmove(pmove: KexPmoveT | null): void; // player movement code called by server & client

  // Fetch named extension from game DLL.
  GetExtension(name: string): unknown;

  Bot_SetWeapon(botEdict: KexEdictT | null, weaponIndex: number, instantSwitch: boolean): void;
  Bot_TriggerEdict(botEdict: KexEdictT | null, edict: KexEdictT | null): void;
  Bot_UseItem(botEdict: KexEdictT | null, itemID: number): void;
  Bot_GetItemID(classname: string): number;
  Edict_ForceLookAtPoint(edict: KexEdictT | null, point: Vec3): void;
  Bot_PickedUpItem(botEdict: KexEdictT | null, itemEdict: KexEdictT | null): boolean;

  // [KEX]: Checks entity visibility instancing
  Entity_IsVisibleToPlayer(ent: KexEdictT | null, player: KexEdictT | null): boolean;

  // Fetch info from the shadow light, for culling
  GetShadowLightData(entity_number: number): ShadowLightDataT | null;
}

// generic rectangle
export interface VrectT {
  x: number;
  y: number;
  width: number;
  height: number;
}

export enum TextAlignT {
  LEFT,
  CENTER,
  RIGHT,
}

// transient data from server
export interface CgServerDataT {
  layout: string; // char[1024]
  inventory: Int16Array; // length MAX_ITEMS
}

export const PROTOCOL_VERSION_3XX = 34;
export const PROTOCOL_VERSION_DEMOS = 2022;
export const PROTOCOL_VERSION = 2023;

//
// functions provided by main engine for client
//
export interface KexCgameImports {
  tick_rate: number; // uint32_t
  frame_time_s: number;
  frame_time_ms: number; // uint32_t

  // print to appropriate places (console, log file, etc)
  Com_Print(msg: string): void;

  // config strings hold all the index strings, the lightstyles,
  // and misc data like the sky definition and cdtrack.
  // All of the current configstrings are sent to clients when
  // they connect, and changes are sent to all connected clients.
  get_configstring(num: number): string;

  Com_Error(message: string): never;

  // managed memory allocation
  TagMalloc(size: number, tag: number): unknown;
  TagFree(block: unknown): void;
  FreeTags(tag: number): void;

  // console variable interaction
  cvar(var_name: string, value: string | null, flags: CvarFlagsT): CvarT | null;
  cvar_set(var_name: string, value: string): CvarT | null;
  cvar_forceset(var_name: string, value: string): CvarT | null;

  // add commands to the server console as if they were typed in
  // for map changing, etc
  AddCommandString(text: string): void;

  // Fetch named extension from engine.
  GetExtension(name: string): unknown;

  // Check whether current frame is valid
  CL_FrameValid(): boolean;

  // Get client frame time delta
  CL_FrameTime(): number;

  // [Paril-KEX] cgame-specific stuff
  CL_ClientTime(): number; // uint64_t
  CL_ClientRealTime(): number; // uint64_t
  CL_ServerFrame(): number;
  CL_ServerProtocol(): number;
  CL_GetClientName(index: number): string;
  CL_GetClientPic(index: number): string;
  CL_GetClientDogtag(index: number): string;
  CL_GetKeyBinding(binding: string): string; // fetch key bind for key, or empty string
  Draw_RegisterPic(name: string): boolean;
  Draw_GetPicSize(w: [number], h: [number], name: string): void; // will return 0 0 if not found
  SCR_DrawChar(x: number, y: number, scale: number, num: number, shadow: boolean): void;
  SCR_DrawPic(x: number, y: number, w: number, h: number, name: string): void;
  SCR_DrawColorPic(x: number, y: number, w: number, h: number, name: string, color: RgbaT): void;

  // [Paril-KEX] kfont stuff
  SCR_SetAltTypeface(enabled: boolean): void;
  SCR_DrawFontString(str: string, x: number, y: number, scale: number, color: RgbaT, shadow: boolean, align: TextAlignT): void;
  SCR_MeasureFontString(str: string, scale: number): Vec2T;
  SCR_FontLineHeight(scale: number): number;

  // [Paril-KEX] for legacy text input (not used in lobbies)
  CL_GetTextInput(msg: [string], is_team: [boolean]): boolean;

  // [Paril-KEX] FIXME this probably should be an export instead...
  CL_GetWarnAmmoCount(weapon_id: number): number;

  // === [KEX] Additional APIs ===
  // returns a *temporary string* ptr to a localized input
  Localize(base: string, args: string[], num_args: number): string;

  // [Paril-KEX] Draw binding, for centerprint; returns y offset
  SCR_DrawBind(isplit: number, binding: string, purpose: string, x: number, y: number, scale: number): number;

  // [Paril-KEX]
  CL_InAutoDemoLoop(): boolean;
}

//
// functions exported for client by game subsystem
//
export interface KexCgameExports {
  apiversion: number;

  // the init/shutdown functions will be called between levels/connections
  // and when the client initially loads.
  Init(): void;
  Shutdown(): void;

  // [Paril-KEX] hud drawing
  DrawHUD(
    isplit: number,
    data: CgServerDataT | null,
    hud_vrect: VrectT,
    hud_safe: VrectT,
    scale: number,
    playernum: number,
    ps: KexPlayerStateT | null,
  ): void;
  // [Paril-KEX] precache special pics used by hud
  TouchPics(): void;

  // [Paril-KEX] layout flags; see layout_flags_t
  LayoutFlags(ps: KexPlayerStateT | null): LayoutFlagsT;

  // [Paril-KEX] fetch the current wheel weapon ID in use
  GetActiveWeaponWheelWeapon(ps: KexPlayerStateT | null): number;

  // [Paril-KEX] fetch owned weapon IDs
  GetOwnedWeaponWheelWeapons(ps: KexPlayerStateT | null): number; // uint32_t

  // [Paril-KEX] fetch ammo count for given ammo id
  GetWeaponWheelAmmoCount(ps: KexPlayerStateT | null, ammo_id: number): number;

  // [Paril-KEX] fetch powerup count for given powerup id
  GetPowerupWheelCount(ps: KexPlayerStateT | null, powerup_id: number): number;

  // [Paril-KEX] fetch how much damage was registered by these stats
  GetHitMarkerDamage(ps: KexPlayerStateT | null): number;

  // [KEX]: Pmove as export
  Pmove(pmove: KexPmoveT | null): void; // player movement code called by server & client

  // [Paril-KEX] allow cgame to react to configstring changes
  ParseConfigString(i: number, s: string): void;

  // [Paril-KEX] parse centerprint-like messages
  ParseCenterPrint(str: string, isplit: number, instant: boolean): void;

  // [Paril-KEX] tell the cgame to clear notify stuff
  ClearNotify(isplit: number): void;

  // [Paril-KEX] tell the cgame to clear centerprint state
  ClearCenterprint(isplit: number): void;

  // [Paril-KEX] be notified by the game DLL of a message of some sort
  NotifyMessage(isplit: number, msg: string, is_chat: boolean): void;

  // [Paril-KEX]
  GetMonsterFlashOffset(id: MonsterMuzzleflashIdT, offset: Vec3): void;

  // Fetch named extension from cgame DLL.
  GetExtension(name: string): unknown;
}

// EOF
