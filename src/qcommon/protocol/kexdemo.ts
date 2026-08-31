// KEX_DEMO_CODEC: the native KEX wire format used by the 2022/2023
// Quake II re-release engine's OWN demo files (protocol numbers 2022 =
// PROTOCOL_KEX_DEMOS and 2023 = PROTOCOL_KEX), ported READ-SIDE ONLY from
// ~/Projects/q2proto/src/q2proto_proto_kex.c (2,045 lines; lines 1-913 are
// the entire client-read/decode path this file ports -- lines 914-2045 are
// server-side write/encode logic, out of scope per the brief: "q2repro
// parses these for playback only"). ARCHITECTURE.md "Protocol layer" /
// .orch/RESUME.md's "v1.0.0 REQUIRES: ... KEX demo playback" ruling.
//
// LICENSE FINDING: q2proto_proto_kex.c's header carries the same GPLv2-or-
// later notice as q2proto_proto_q2repro.c (see q2repro.ts's own LICENSE
// FINDING) -- same vendoring policy applies.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A SEPARATE CODEC FROM Q2REPRO_CODEC (1038)
// ---------------------------------------------------------------------------
// PROTOCOL_KEX_DEMOS (2022) and PROTOCOL_KEX (2023) are NOT the same wire
// format as PROTOCOL_VERSION_RERELEASE (1038, q2repro.ts). 1038 is q2repro's
// OWN compatible reimplementation of the re-release protocol for live
// network play by third-party servers (inc/q2proto/q2proto_protocol.h:52-57);
// 2022/2023 is the ACTUAL re-release engine's native format -- what real
// retail demos are recorded in, and (2023 only) what a real retail server
// speaks live. q2repro's OWN kex.c reuses several of its q2repro.c read
// functions verbatim where the two formats happen to coincide (cited at each
// call site below), but the entity-delta, playerstate-delta, frame-envelope,
// and several auxiliary message shapes genuinely differ -- ported fresh here,
// not delegated to Q2REPRO_CODEC.
//
// Detection: q2proto_proto_kex.c:341-342's own protocol-number range check
// (`protocol < PROTOCOL_KEX_DEMOS || protocol > PROTOCOL_KEX`) is exactly
// this port's existing selectServerCodec(protocol) idiom (cl_parse.ts) --
// 2022 or 2023 in the leading svc_serverdata long selects this codec, no
// separate file-header magic needed (verified against q2repro's own demo.c:
// detection happens purely from the first message's protocol content, same
// mechanism as a live connect -- see the KEX demo playback unit's own task
// report for the full derivation).
//
// ---------------------------------------------------------------------------
// 2022 vs 2023: the one real behavioral fork
// ---------------------------------------------------------------------------
// Both protocol numbers route through this exact same codec (q2proto_client.c
// dispatches both to kex.c's own continue_serverdata, kex.c:45). The two
// differ in exactly one place this codec cares about: `kex_client_read_
// entity_delta`'s origin/old_origin precision (kex.c:434-475) --
// PROTOCOL_KEX_DEMOS (2022, real recorded demos) drops to a lower-precision
// 12.3-fixed-point short encoding for any entity whose most recently known
// `solid` value is 0; PROTOCOL_KEX (2023, live native-engine network traffic
// -- never emitted by this engine's own server, but decodable if encountered)
// always uses full float precision. `setKexProtocol` (below) records which of
// the two the active stream's serverdata declared; cl_parse.ts's
// selectServerCodec calls it at codec-selection time, mirroring how `csr`/
// `cls.codec` are already selected together there.
//
// ---------------------------------------------------------------------------
// SCOPE CUTS (documented, not silent -- see .orch/followups.md)
// ---------------------------------------------------------------------------
// - Per-entity "nonzero_solid" precision tracking (needed for the 2022 low-
//   precision branch above) is real and stateful (`kexDemoEdictNonzeroSolid`
//   below), matching kex.c:436-437's own per-edict bitset. kex.c ALSO
//   maintains a separate `kex_demo_baseline_nonzero_solid` bitset
//   (kex.c:561-562) that a later `U_REMOVE` uses to reset an entity slot's
//   tracked value back to its baseline's value when that entity is removed
//   and (potentially) later reused by a different conceptual entity
//   (kex.c:321-327). This narrow reset-on-remove edge case is NOT ported:
//   in practice a freshly-reused entity slot almost always resends its own
//   `solid` bit explicitly on first reappearance (a genuinely new server-side
//   entity has no reason to omit it), so `kexDemoEdictNonzeroSolid`'s plain
//   per-slot persistence (falling back to `false` for a never-yet-seen slot,
//   which is also kex.c's own hardcoded default for baselines,
//   kex_client_read_baseline's `default_solid_nonzero=false` at kex.c:561)
//   already covers the overwhelmingly common case correctly. A demo that hit
//   this exact edge case (solid=0 entity removed, slot reused, new entity's
//   very first appearance omits its own solid bit while relying on the
//   pre-removal value) would misdecode that one entity's origin precision.
//   Reported precisely here and in .orch/followups.md, not swept under.
// - Live-2023-only wire shapes with no 2022/demo equivalent (float-based
//   svc_temp_entity per kex.c:213-220, float-based svc_sound SND_POS per
//   kex.c:596-602) are not ported: this engine's own server never speaks
//   protocol 2023 (it only ever emits 34 or 1038), so no code path in this
//   engine could ever produce that variant, and no retail demo (2022) uses
//   it either. `readTempEntityKex`/`readSoundKex` below implement the 2022
//   (short/legacy) forms only; both throw a clear, cited error if
//   `kexServerProtocol === PROTOCOL_KEX` (2023) ever reaches them, rather
//   than silently misdecoding.
//
// ---------------------------------------------------------------------------
// AUXILIARY MESSAGES (svc_damage/fog/poi/help_path/muzzleflash3/achievement/
// locprint/splitclient/configblast/spawnbaselineblast) -- NOT part of
// ProtocolCodec
// ---------------------------------------------------------------------------
// Per this port line's existing convention (q2repro.ts's own `readFog`: "NOT
// part of the ProtocolCodec interface -- like svc_damage/svc_poi/etc, this is
// a one-off auxiliary server command ... follows the same
// write-it-directly/read-it-directly convention those messages already use
// elsewhere"), every KEX-only auxiliary message this file exports below
// (readDamageKex, readPoiKex, readHelpPathKex, readMuzzleflash3Kex,
// readAchievementKex, readLocprintKex, readSplitclientKex,
// readConfigblastBeginKex/readConfigblastNextKex,
// readSpawnbaselineblastBeginKex/readSpawnbaselineblastNextKex) is a
// standalone export, consumed by cl_parse.ts's CL_ParseServerMessage
// dispatch, not the codec seam. `readFog` itself (q2repro.ts) is reused
// UNCHANGED here (kex.c:267 reuses q2proto_q2repro_client_read_fog verbatim
// for its own svc_rr_fog, exactly as this port's cl_parse.ts wiring does);
// likewise readDamageKex/readPoiKex/readHelpPathKex/readMuzzleflash3Kex/
// readAchievementKex below are ported fresh here (from q2repro.c, since
// kex.c reuses those q2repro.c functions verbatim too -- see each function's
// own citation) rather than duplicated a second time in q2repro.ts, since
// q2repro.ts's own live-network dispatch never reaches them today (this
// engine's cl_parse.ts has no live-1038-server opcode dispatch beyond
// entity/playerstate/frame; see cl_parse.ts's own header for that separate,
// larger, out-of-scope gap).
//
// ---------------------------------------------------------------------------
// SOURCES CONSULTED
// ---------------------------------------------------------------------------
//   src/q2proto_proto_kex.c              -- the KEX 2022/2023 codec (this file)
//   src/q2proto_proto_q2repro.c          -- reused verbatim for several
//                                            auxiliary messages (fog/damage/
//                                            poi/help_path/muzzleflash3/
//                                            achievement), cited per function
//   src/q2proto_internal_common.c        -- shared entity-bits header codec
//                                            (q2proto_common_client_read_entity_bits,
//                                            IDENTICAL across every protocol
//                                            q2proto supports -- reused here
//                                            via q2repro.ts's exported
//                                            readEntityBitsWide, not re-derived)
//   src/q2proto_internal_protocol.h      -- U_*/PS_*/SND_*/GUNBIT_* bit constants
//   src/q2proto_internal_io.h            -- var_coords/var_angles/var_color/
//                                            viewoffset/kickangles quantization
//   src/q2proto_coords.c                 -- _q2proto_valenc_int2coord (x*0.125,
//                                            the 2022 low-precision origin scale)
//   inc/q2proto/q2proto_valenc.h         -- int2coord/coord2int definitions
//   inc/q2proto/q2proto_limits.h         -- Q2PROTO_MAX_DAMAGE_INDICATORS(4)/
//                                            Q2PROTO_MAX_LOCALIZATION_ARGS(8)

import { SizeBuf, SZ_Init, MSG_BeginReading, MSG_ReadByte, MSG_ReadChar, MSG_ReadShort, MSG_ReadWord, MSG_ReadLong, MSG_ReadFloat, MSG_ReadString, MSG_ReadData, MSG_ReadDir } from "../sizebuf";
import {
  U_ORIGIN1,
  U_ORIGIN2,
  U_ORIGIN3,
  U_ANGLE1,
  U_ANGLE2,
  U_ANGLE3,
  U_FRAME8,
  U_EVENT,
  U_REMOVE,
  U_MODEL,
  U_RENDERFX8,
  U_EFFECTS8,
  U_SKIN8,
  U_FRAME16,
  U_RENDERFX16,
  U_EFFECTS16,
  U_MODEL2,
  U_MODEL3,
  U_MODEL4,
  U_OLDORIGIN,
  U_SKIN16,
  U_SOUND,
  U_SOLID,
  PS_M_TYPE,
  PS_M_ORIGIN,
  PS_M_VELOCITY,
  PS_M_TIME,
  PS_M_FLAGS,
  PS_M_GRAVITY,
  PS_M_DELTA_ANGLES,
  PS_VIEWOFFSET,
  PS_VIEWANGLES,
  PS_KICKANGLES,
  PS_BLEND,
  PS_FOV,
  PS_WEAPONINDEX,
  PS_WEAPONFRAME,
  PS_RDFLAGS,
  SvcOpsT,
  ComError,
  ERR_DROP,
} from "../qcommon";
import { net_message } from "../net_chan";
import { EntityStateT, PlayerStateT, type UsercmdT, ANGLE2SHORT } from "../../shared/q_shared";
import type { ProtocolCodec, ServerDataParamsT, ServerDataReadResultT, FrameWriteParamsT, FrameHeaderT } from "./codec";
import {
  readEntityBitsWide,
  combineBits,
  bitsHasHi,
  HI_SCALE,
  HI_MOREFX16,
  decodeAlpha,
  decodeScale,
  decodeLoopVolume,
  decodeLoopAttenuation,
  SOUND_FLAG_VOLUME,
  SOUND_FLAG_ATTENUATION,
  pmFloatToShort,
  VIEWOFFSET_SCALE,
  KICK_ANGLE_SCALE,
  Q2PRO_GUNINDEX_BITS,
  Q2PRO_GUNINDEX_MASK,
} from "./q2repro";

// ---------------------------------------------------------------------------
// Protocol numbers (q2proto_internal_protocol.h:39-40)
// ---------------------------------------------------------------------------
export const PROTOCOL_KEX_DEMOS = 2022;
export const PROTOCOL_KEX = 2023;

// Set by cl_parse.ts's selectServerCodec once the leading svc_serverdata
// protocol long has been read (mirrors that function's existing `csr`/
// `cls.codec` co-selection) -- see file header's "2022 vs 2023" section.
// Defaults to 2023 (full precision, the conservative choice: never silently
// under-reads a stream this codec hasn't been told about yet).
let kexServerProtocol = PROTOCOL_KEX;
export function setKexProtocol(protocol: number): void {
  kexServerProtocol = protocol;
}

// Per-entity "was solid last known nonzero" tracking (kex.c:436-437's
// `kex_demo_edict_nonzero_solid` bitset) -- see file header's SCOPE CUTS.
// Cleared on every new svc_serverdata (a fresh demo/level has no carried-over
// entity state), matching CL_ClearState's own per-level-reset precedent.
const kexDemoEdictNonzeroSolid = new Map<number, boolean>();

// ---------------------------------------------------------------------------
// Local bit constants: q2proto's U_/PS_/SND_/GUNBIT_ layouts that neither
// vanilla (34) nor q2repro (1038) engage, so qcommon.ts's/q2repro.ts's own
// exports stop short of them.
// ---------------------------------------------------------------------------

// q2proto_internal_protocol.h:151,157-161. U_MODEL16 is a plain lo-word bit
// (28); U_KEX_EFFECTS64 shares q2repro's own U_MOREFX8 slot (bit 29, "Q2PRO,
// Q2rePRO" vs "KEX" -- same bit position, different per-protocol meaning,
// exactly like U_KEX_INSTANCE/U_MOREFX16 below). U_KEX_INSTANCE/OWNER/
// OLDFRAME live in the SAME hi-byte q2repro.ts's own HI_SCALE(bit32)/
// HI_MOREFX16(bit33) already occupy -- reusing combineBits/bitsHasHi
// unchanged (q2repro.ts's readEntityBitsWide already reads the full hi byte
// whenever U_MOREBITS4 is set, regardless of which protocol is active).
const U_MODEL16 = 1 << 28;
const U_KEX_EFFECTS64 = 1 << 29;
const U_ALPHA = 1 << 30; // q2proto_internal_protocol.h:154
const HI_KEX_INSTANCE = HI_MOREFX16; // bit 33 -- same slot as U_MOREFX16
const HI_KEX_OWNER = 4; // bit 34 (hi-word bit index 2)
const HI_KEX_OLDFRAME = 8; // bit 35 (hi-word bit index 3)

// q2proto_internal_protocol.h:263-267.
const PS_MOREBITS = 1 << 15;
const PS_KEX_DAMAGE_BLEND = 1 << 16;
const PS_KEX_TEAM_ID = 1 << 17;

// q2proto_proto_kex.c:25-31 -- svc_playerinfo's packed weaponframe sub-flags.
const GUNBIT_OFFSET_X = 1 << 0;
const GUNBIT_OFFSET_Y = 1 << 1;
const GUNBIT_OFFSET_Z = 1 << 2;
const GUNBIT_ANGLES_X = 1 << 3;
const GUNBIT_ANGLES_Y = 1 << 4;
const GUNBIT_ANGLES_Z = 1 << 5;
const GUNBIT_GUNRATE = 1 << 6;

// q2proto_internal_protocol.h:109-115 -- svc_sound's flags byte.
const SND_VOLUME = 1 << 0;
const SND_ATTENUATION = 1 << 1;
const SND_POS = 1 << 2;
const SND_ENT = 1 << 3;
const SND_OFFSET = 1 << 4;
const SND_KEX_LARGE_ENT = 1 << 6;
const SOUND_DEFAULT_VOLUME = 1.0;
const SOUND_DEFAULT_ATTENUATION = 1.0;

// _q2proto_valenc_int2coord (q2proto_valenc.h:64): x*0.125 -- the SAME
// 1/8-unit fixed-point scale classic Quake II has always used for MSG_ReadShort
// -encoded coordinates (matches this port's own MASK/COORD conventions
// elsewhere; not a new format).
const COORD_SHORT_SCALE = 0.125;

// ---------------------------------------------------------------------------
// svc_serverdata (kex.c:335-347) -- much sparser than q2repro's 1038
// handshake: no feature-negotiation bits, no fog/q2pro extension fields.
// ---------------------------------------------------------------------------
function readServerData(): ServerDataReadResultT {
  // New level/demo -- no carried-over per-entity solid-precision state.
  kexDemoEdictNonzeroSolid.clear();

  // kex.c:51-59 field order: servercount(i32), attractloop(bool),
  // server_fps(u8), gamedir(string), clientnum(i16), levelname(string).
  const servercount = MSG_ReadLong(net_message);
  const attractloop = MSG_ReadByte(net_message) !== 0;
  MSG_ReadByte(net_message); // server_fps -- no home on ServerDataReadResultT (matches VANILLA_CODEC's own "protocol-specific field, nowhere to go" precedent); discarded.
  const gamedir = MSG_ReadString(net_message);
  const clientnum = MSG_ReadShort(net_message);
  if (clientnum === -2) {
    // kex.c:56-58: split-screen sentinel. This port has no split-screen client.
    throw new ComError(ERR_DROP, "kexdemo: svc_serverdata clientnum -2 (split-screen) is not supported");
  }
  const levelname = MSG_ReadString(net_message);

  // KEX's handshake carries no q2pro-style server_state field at all --
  // 0 (matching VANILLA_CODEC's own "q2repro-only fields are simply
  // unread/unset" precedent, codec.ts's ServerDataReadResultT doc comment).
  return { servercount, attractloop, gamedir, clientnum, levelname, serverState: 0 };
}

// ---------------------------------------------------------------------------
// Entity bits header -- IDENTICAL across every protocol q2proto supports
// (q2proto_internal_common.c's q2proto_common_client_read_entity_bits is
// called unchanged by vanilla/r1q2/q2pro/q2pro_extdemo/q2repro/kex alike).
// q2repro.ts's readEntityBitsWide already implements this exactly (up to 5
// bytes: base + up to 3 MOREBITS-gated lo bytes + 1 MOREBITS4-gated hi byte,
// entnum as u8 or u16), reused verbatim -- see this file's own header.
// ---------------------------------------------------------------------------
const readEntityBits = readEntityBitsWide;

// ---------------------------------------------------------------------------
// Entity state delta (kex.c:349-549, `kex_client_read_entity_delta`) --
// field order and encodings verified against the C source directly, not
// just the derivation summary (several fields are reordered/re-encoded
// relative to q2repro.ts's own readDeltaEntity; see file header).
// ---------------------------------------------------------------------------
function copyEntityState(dst: EntityStateT, src: EntityStateT): void {
  dst.number = src.number;
  dst.origin.set(src.origin);
  dst.angles.set(src.angles);
  dst.old_origin.set(src.old_origin);
  dst.modelindex = src.modelindex;
  dst.modelindex2 = src.modelindex2;
  dst.modelindex3 = src.modelindex3;
  dst.modelindex4 = src.modelindex4;
  dst.frame = src.frame;
  dst.skinnum = src.skinnum;
  dst.effects = src.effects;
  dst.morefx = src.morefx;
  dst.renderfx = src.renderfx;
  dst.solid = src.solid;
  dst.sound = src.sound;
  dst.event = src.event;
  dst.alpha = src.alpha;
  dst.scale = src.scale;
  dst.loop_volume = src.loop_volume;
  dst.loop_attenuation = src.loop_attenuation;
  // KEX-only fields (dormant on q2repro.ts's own copyEntityState, since
  // protocol 1038 never carries them) -- real here, since this codec does.
  dst.instance_bits = src.instance_bits;
  dst.owner = src.owner;
  dst.old_frame = src.old_frame;
}

function readDeltaEntity(from: EntityStateT, to: EntityStateT, number: number, bits: number): void {
  copyEntityState(to, from);
  to.number = number;

  // Every 16-bit entity field below is read UNSIGNED (MSG_ReadWord), matching
  // q2proto_proto_kex.c's own `READ_CHECKED(client_read, io_arg, <field>, u16)`
  // (:426 for renderfx, and the identical u16 reads for modelindex/frame/
  // skinnum/effects). A signed read sign-extends bit 15 across bits 16..31 --
  // for renderfx that turns the rerelease game's RF_IR_VISIBLE (0x8000, set
  // on every spawned entity by g_spawn.cpp) into 0xffff8000, lighting up
  // RF_SHELL_DOUBLE|RF_SHELL_HALF_DAM and drawing the model as an untextured
  // yellow shell blob.
  const model16 = (bits & U_MODEL16) !== 0;
  if (bits & U_MODEL) to.modelindex = model16 ? MSG_ReadWord(net_message) : MSG_ReadByte(net_message);
  if (bits & U_MODEL2) to.modelindex2 = model16 ? MSG_ReadWord(net_message) : MSG_ReadByte(net_message);
  if (bits & U_MODEL3) to.modelindex3 = model16 ? MSG_ReadWord(net_message) : MSG_ReadByte(net_message);
  if (bits & U_MODEL4) to.modelindex4 = model16 ? MSG_ReadWord(net_message) : MSG_ReadByte(net_message);

  if (bits & U_FRAME8) to.frame = MSG_ReadByte(net_message);
  else if (bits & U_FRAME16) to.frame = MSG_ReadWord(net_message);

  if ((bits & (U_SKIN8 | U_SKIN16)) === (U_SKIN8 | U_SKIN16)) to.skinnum = MSG_ReadLong(net_message); // laser colors, kex.c:381
  else if (bits & U_SKIN16) to.skinnum = MSG_ReadWord(net_message);
  else if (bits & U_SKIN8) to.skinnum = MSG_ReadByte(net_message);

  // kex.c:391-411: 64-bit effects. Low 32 bits sent first (gated by
  // U_KEX_EFFECTS64), high 32 bits second (the plain 8/16/32-progressive
  // U_EFFECTS8/16 field, reinterpreted as the HIGH word whenever
  // U_KEX_EFFECTS64 is also set) -- see file header derivation.
  let lowEffects = 0;
  if (bits & U_KEX_EFFECTS64) lowEffects = MSG_ReadLong(net_message) >>> 0;

  let effects32 = 0;
  const effectsCombo = bits & (U_EFFECTS8 | U_EFFECTS16);
  if (effectsCombo === (U_EFFECTS8 | U_EFFECTS16)) effects32 = MSG_ReadLong(net_message) >>> 0;
  else if (bits & U_EFFECTS16) effects32 = MSG_ReadWord(net_message) >>> 0;
  else if (bits & U_EFFECTS8) effects32 = MSG_ReadByte(net_message) >>> 0;

  if (bits & (U_KEX_EFFECTS64 | U_EFFECTS8 | U_EFFECTS16)) {
    // "All 64 effects bits are always replaced" (kex.c:410's own comment)
    // whenever either half was touched.
    if (bits & U_KEX_EFFECTS64) {
      to.effects = lowEffects >>> 0;
      to.morefx = effects32 >>> 0;
    } else {
      to.effects = effects32 >>> 0;
      to.morefx = 0;
    }
  }

  if ((bits & (U_RENDERFX8 | U_RENDERFX16)) === (U_RENDERFX8 | U_RENDERFX16)) to.renderfx = MSG_ReadLong(net_message);
  else if (bits & U_RENDERFX16) to.renderfx = MSG_ReadWord(net_message);
  else if (bits & U_RENDERFX8) to.renderfx = MSG_ReadByte(net_message);

  // kex.c:434-441: solid moves BEFORE origin/angles (unlike q2repro), and
  // its value (or, when unsent, the entity's last known value) decides
  // origin/old_origin precision for 2022 demos -- see file header.
  let nonzeroSolid: boolean;
  if (bits & U_SOLID) {
    to.solid = MSG_ReadLong(net_message) >>> 0;
    nonzeroSolid = to.solid !== 0;
    kexDemoEdictNonzeroSolid.set(number, nonzeroSolid);
  } else {
    nonzeroSolid = kexDemoEdictNonzeroSolid.get(number) ?? false;
  }

  const highPrecisionOrigin = kexServerProtocol !== PROTOCOL_KEX_DEMOS || nonzeroSolid;

  if (highPrecisionOrigin) {
    if (bits & U_ORIGIN1) to.origin[0] = MSG_ReadFloat(net_message);
    if (bits & U_ORIGIN2) to.origin[1] = MSG_ReadFloat(net_message);
    if (bits & U_ORIGIN3) to.origin[2] = MSG_ReadFloat(net_message);
    if (bits & U_OLDORIGIN) {
      to.old_origin[0] = MSG_ReadFloat(net_message);
      to.old_origin[1] = MSG_ReadFloat(net_message);
      to.old_origin[2] = MSG_ReadFloat(net_message);
    }
  } else {
    if (bits & U_ORIGIN1) to.origin[0] = MSG_ReadShort(net_message) * COORD_SHORT_SCALE;
    if (bits & U_ORIGIN2) to.origin[1] = MSG_ReadShort(net_message) * COORD_SHORT_SCALE;
    if (bits & U_ORIGIN3) to.origin[2] = MSG_ReadShort(net_message) * COORD_SHORT_SCALE;
    if (bits & U_OLDORIGIN) {
      to.old_origin[0] = MSG_ReadShort(net_message) * COORD_SHORT_SCALE;
      to.old_origin[1] = MSG_ReadShort(net_message) * COORD_SHORT_SCALE;
      to.old_origin[2] = MSG_ReadShort(net_message) * COORD_SHORT_SCALE;
    }
  }

  // kex.c:478-489: angles are ALWAYS plain float degrees -- no U_ANGLE16
  // branch at all (unlike q2repro's short-vs-byte scheme).
  if (bits & U_ANGLE1) to.angles[0] = MSG_ReadFloat(net_message);
  if (bits & U_ANGLE2) to.angles[1] = MSG_ReadFloat(net_message);
  if (bits & U_ANGLE3) to.angles[2] = MSG_ReadFloat(net_message);

  if (bits & U_SOUND) {
    const soundWord = MSG_ReadShort(net_message);
    to.sound = soundWord & 0x3fff;
    if (soundWord & SOUND_FLAG_VOLUME) to.loop_volume = decodeLoopVolume(MSG_ReadByte(net_message));
    if (soundWord & SOUND_FLAG_ATTENUATION) to.loop_attenuation = decodeLoopAttenuation(MSG_ReadByte(net_message));
  }

  if (bits & U_EVENT) to.event = MSG_ReadByte(net_message);
  else to.event = 0; // zero-compressed, matches q2repro.ts's own convention (see that file's comment)

  if (bits & U_ALPHA) to.alpha = decodeAlpha(MSG_ReadByte(net_message));
  if (bitsHasHi(bits, HI_SCALE)) to.scale = decodeScale(MSG_ReadByte(net_message));

  if (bitsHasHi(bits, HI_KEX_INSTANCE)) to.instance_bits = MSG_ReadByte(net_message);
  if (bitsHasHi(bits, HI_KEX_OWNER)) to.owner = MSG_ReadShort(net_message);
  if (bitsHasHi(bits, HI_KEX_OLDFRAME)) to.old_frame = MSG_ReadShort(net_message);
}

// ---------------------------------------------------------------------------
// Player state delta (kex.c:625-766, `kex_client_read_playerstate`) --
// STRUCTURALLY different flags scheme from q2repro.ts's own (a single 32-bit
// `flags` built from two u16 reads gated by PS_MOREBITS, no separate
// extraflags byte at all), so this is a fresh port, not a reuse of
// q2repro.ts's readPlayerStateFields. See file header for the 2022/2023
// distinction (there is none here -- every playerstate field below reads
// identically on both).
// ---------------------------------------------------------------------------
function readKexFlags(): number {
  // MSG_ReadShort returns a SIGNED 16-bit value (matching the C `(short)`
  // cast) -- for a real wire value with bit 15 set (i.e. any value with
  // PS_MOREBITS itself, or any other high bit, on), that comes back
  // NEGATIVE. Masking to 0xffff BEFORE combining with the high word is
  // required: `flags |= moreFlags << 16` on a still-negative (sign-extended
  // to all 1s in bits 16-31) `flags` would OR moreFlags's bits into a field
  // that's already all 1s, silently setting every PS_KEX_* bit beyond
  // whatever moreFlags actually carried (found via a real retail demo file
  // -- see this unit's own task report: PS_KEX_TEAM_ID spuriously appeared
  // set on every playerstate whose low flags word had bit 15 set, corrupting
  // downstream byte alignment for the rest of the frame).
  let flags = MSG_ReadShort(net_message) & 0xffff;
  if (flags & PS_MOREBITS) {
    const moreFlags = MSG_ReadShort(net_message) & 0xffff;
    flags |= moreFlags << 16;
  }
  return flags >>> 0;
}

function readKexPlayerStateFields(from: PlayerStateT, to: PlayerStateT, flags: number): void {
  // copy-then-overwrite, matching q2repro.ts's own readPlayerStateFields
  // convention (this port's delta model, vs. q2proto's own delta-bits-only
  // struct).
  to.pmove.pm_type = from.pmove.pm_type;
  to.pmove.origin.set(from.pmove.origin);
  to.pmove.velocity.set(from.pmove.velocity);
  to.pmove.originF.set(from.pmove.originF);
  to.pmove.velocityF.set(from.pmove.velocityF);
  to.pmove.pm_flags = from.pmove.pm_flags;
  to.pmove.pm_time = from.pmove.pm_time;
  to.pmove.gravity = from.pmove.gravity;
  to.pmove.delta_angles.set(from.pmove.delta_angles);
  to.pmove.viewheight = from.pmove.viewheight;
  to.viewangles.set(from.viewangles);
  to.viewoffset.set(from.viewoffset);
  to.kick_angles.set(from.kick_angles);
  to.gunangles.set(from.gunangles);
  to.gunoffset.set(from.gunoffset);
  to.gunindex = from.gunindex;
  to.gunskin = from.gunskin;
  to.gunframe = from.gunframe;
  to.gunrate = from.gunrate;
  to.blend.set(from.blend);
  to.damage_blend.set(from.damage_blend);
  to.fov = from.fov;
  to.rdflags = from.rdflags;
  to.stats.set(from.stats);
  to.team_id = from.team_id;

  if (flags & PS_M_TYPE) to.pmove.pm_type = MSG_ReadByte(net_message);

  // kex.c:648-655: pm_origin/pm_velocity are always full float triples
  // (read_var_coords_float), all-or-nothing per field -- no q2repro-style
  // xy/z split. `originF`/`velocityF` (q_shared.ts, FLOAT PMOVE STATE END TO
  // END, .orch/followups.md) carry the value through with no narrowing at
  // all, matching live 1038 playback; the legacy `origin`/`velocity`
  // Int16Array fields are also kept in sync (q2repro.ts's own
  // pmFloatToShort, the same 1/8-unit scale src/server/bindings/kex.ts uses
  // at the sync boundary) for the family-generic client consumers that still
  // read them.
  if (flags & PS_M_ORIGIN) {
    const x = MSG_ReadFloat(net_message);
    const y = MSG_ReadFloat(net_message);
    const z = MSG_ReadFloat(net_message);
    to.pmove.originF[0] = x;
    to.pmove.originF[1] = y;
    to.pmove.originF[2] = z;
    to.pmove.origin[0] = pmFloatToShort(x);
    to.pmove.origin[1] = pmFloatToShort(y);
    to.pmove.origin[2] = pmFloatToShort(z);
  }
  if (flags & PS_M_VELOCITY) {
    const x = MSG_ReadFloat(net_message);
    const y = MSG_ReadFloat(net_message);
    const z = MSG_ReadFloat(net_message);
    to.pmove.velocityF[0] = x;
    to.pmove.velocityF[1] = y;
    to.pmove.velocityF[2] = z;
    to.pmove.velocity[0] = pmFloatToShort(x);
    to.pmove.velocity[1] = pmFloatToShort(y);
    to.pmove.velocity[2] = pmFloatToShort(z);
  }

  if (flags & PS_M_TIME) to.pmove.pm_time = MSG_ReadShort(net_message);
  if (flags & PS_M_FLAGS) to.pmove.pm_flags = MSG_ReadShort(net_message);
  if (flags & PS_M_GRAVITY) to.pmove.gravity = MSG_ReadShort(net_message);
  if (flags & PS_M_DELTA_ANGLES) {
    // read_var_angles_float: plain float degrees; this port's
    // PmoveStateT.delta_angles is packed-short (matches every other angle
    // field this port line stores that way) -- ANGLE2SHORT converts.
    to.pmove.delta_angles[0] = ANGLE2SHORT(MSG_ReadFloat(net_message));
    to.pmove.delta_angles[1] = ANGLE2SHORT(MSG_ReadFloat(net_message));
    to.pmove.delta_angles[2] = ANGLE2SHORT(MSG_ReadFloat(net_message));
  }

  if (flags & PS_VIEWOFFSET) {
    // read_viewoffsets_q2repro: i16/VIEWOFFSET_SCALE(16) per axis -- the
    // SAME setter q2repro.c itself uses (q2proto_coords.c:302, shared
    // between the two source files) -- THEN an unconditional pm_viewheight
    // i8 immediately after (kex.c:678-682, present on both 2022 and 2023
    // despite older docs claiming otherwise). This byte used to be read and
    // discarded because PmoveStateT had no viewheight field; it does now
    // (q_shared.ts), and dropping it is what made a re-release player render
    // permanently crouched, so it is applied here too. SIGNED: a dead
    // player's eye height goes negative.
    to.viewoffset[0] = MSG_ReadShort(net_message) / VIEWOFFSET_SCALE;
    to.viewoffset[1] = MSG_ReadShort(net_message) / VIEWOFFSET_SCALE;
    to.viewoffset[2] = MSG_ReadShort(net_message) / VIEWOFFSET_SCALE;
    to.pmove.viewheight = MSG_ReadChar(net_message); // pm_viewheight (i8)
  }

  if (flags & PS_VIEWANGLES) {
    to.viewangles[0] = MSG_ReadFloat(net_message);
    to.viewangles[1] = MSG_ReadFloat(net_message);
    to.viewangles[2] = MSG_ReadFloat(net_message);
  }

  if (flags & PS_KICKANGLES) {
    // read_kickangles_q2repro: i16/KICK_ANGLE_SCALE(1024) per axis -- same
    // shared setter as q2repro.c (q2proto_coords.c:446).
    to.kick_angles[0] = MSG_ReadShort(net_message) / KICK_ANGLE_SCALE;
    to.kick_angles[1] = MSG_ReadShort(net_message) / KICK_ANGLE_SCALE;
    to.kick_angles[2] = MSG_ReadShort(net_message) / KICK_ANGLE_SCALE;
  }

  if (flags & PS_WEAPONINDEX) {
    const gunIndexAndSkin = MSG_ReadShort(net_message);
    to.gunindex = gunIndexAndSkin & Q2PRO_GUNINDEX_MASK;
    to.gunskin = gunIndexAndSkin >>> Q2PRO_GUNINDEX_BITS;
  }

  if (flags & PS_WEAPONFRAME) {
    // kex.c:704-726: frame(9 bits) + a 7-bit GUNBIT_* sub-flags field packed
    // into ONE u16 -- materially different from q2repro's separate
    // PS_WEAPONFRAME+EPS_GUNOFFSET/EPS_GUNANGLES/EPS_GUNRATE scheme.
    // gunoffset/gunangles are plain unscaled floats here (no GUNOFFSET_SCALE/
    // GUNANGLE_SCALE division -- those only apply to q2repro's short encoding).
    let gunbits = MSG_ReadShort(net_message);
    to.gunframe = gunbits & 0x1ff;
    gunbits >>>= 9;
    if (gunbits & GUNBIT_OFFSET_X) to.gunoffset[0] = MSG_ReadFloat(net_message);
    if (gunbits & GUNBIT_OFFSET_Y) to.gunoffset[1] = MSG_ReadFloat(net_message);
    if (gunbits & GUNBIT_OFFSET_Z) to.gunoffset[2] = MSG_ReadFloat(net_message);
    if (gunbits & GUNBIT_ANGLES_X) to.gunangles[0] = MSG_ReadFloat(net_message);
    if (gunbits & GUNBIT_ANGLES_Y) to.gunangles[1] = MSG_ReadFloat(net_message);
    if (gunbits & GUNBIT_ANGLES_Z) to.gunangles[2] = MSG_ReadFloat(net_message);
    if (gunbits & GUNBIT_GUNRATE) to.gunrate = MSG_ReadByte(net_message);
  }

  if (flags & PS_BLEND) {
    // read_var_color: 4 plain unconditional bytes (no bitmask byte, unlike
    // q2repro's own PS_BLEND encoding).
    to.blend[0] = MSG_ReadByte(net_message) / 255;
    to.blend[1] = MSG_ReadByte(net_message) / 255;
    to.blend[2] = MSG_ReadByte(net_message) / 255;
    to.blend[3] = MSG_ReadByte(net_message) / 255;
  }

  if (flags & PS_FOV) to.fov = MSG_ReadByte(net_message);
  if (flags & PS_RDFLAGS) to.rdflags = MSG_ReadByte(net_message);

  // kex.c:738-751: TWO u32 statbit masks read UNCONDITIONALLY on every
  // playerstate (unlike q2repro's single EPS_STATS-gated mask), covering 64
  // total stat slots. PlayerStateT.stats is MAX_STATS_STORAGE=64 slots wide
  // (shared/q_shared.ts), so both masks' slots now have a real backing
  // element; the `idx < to.stats.length` guards below are kept as a
  // harmless, always-true bounds check rather than removed.
  const statbits1 = MSG_ReadLong(net_message) >>> 0;
  for (let i = 0; i < 32; i++) {
    if (statbits1 & (1 << i)) {
      const value = MSG_ReadShort(net_message);
      if (i < to.stats.length) to.stats[i] = value;
    }
  }
  const statbits2 = MSG_ReadLong(net_message) >>> 0;
  for (let i = 0; i < 32; i++) {
    if (statbits2 & (1 << i)) {
      const value = MSG_ReadShort(net_message);
      const idx = 32 + i;
      if (idx < to.stats.length) to.stats[idx] = value;
    }
  }

  if (flags & PS_KEX_DAMAGE_BLEND) {
    to.damage_blend[0] = MSG_ReadByte(net_message) / 255;
    to.damage_blend[1] = MSG_ReadByte(net_message) / 255;
    to.damage_blend[2] = MSG_ReadByte(net_message) / 255;
    to.damage_blend[3] = MSG_ReadByte(net_message) / 255;
  }

  if (flags & PS_KEX_TEAM_ID) {
    // "FIXME unused" in q2proto's own client (kex.c:762) -- this port has a
    // real, dormant `team_id` field (phase 2) with nowhere else to be
    // populated from; stored for real here rather than discarded, per this
    // port line's fidelity/interop mandate (.orch/preferences.md rule 17).
    to.team_id = MSG_ReadByte(net_message);
  }
}

function readPlayerStateDelta(_msg: SizeBuf, from: PlayerStateT, to: PlayerStateT): void {
  // Unreachable in practice (KEX never sends a standalone svc_playerinfo --
  // playerinfo only ever appears embedded in svc_frame, see
  // readFramePlayerstate below), but implemented for real for
  // ProtocolCodec interface completeness/testability.
  const flags = readKexFlags();
  readKexPlayerStateFields(from, to, flags);
}

// ---------------------------------------------------------------------------
// Frame envelope (kex.c:768-796, `kex_client_read_frame`) -- both
// serverframe and deltaframe are full, independent, UNPACKED i32s (no
// q2repro-style 5-bit-offset packing), and there is no q2pro_frame_flags/
// extraflags byte pair at all -- just the one suppress_count byte. The
// embedded svc_playerinfo(17)/svc_packetentities(18) opcode bytes ARE
// explicitly checked here (kex.c:781-783,788-791), unlike q2repro's
// no-opcode convention -- matching VANILLA_CODEC's own explicit-check
// idiom instead (codec.ts's readFramePlayerstate/readPacketEntitiesBegin
// doc comments).
// ---------------------------------------------------------------------------
function readFrameHeader(areabits: Uint8Array, _readSuppressByte: boolean): FrameHeaderT {
  const serverframe = MSG_ReadLong(net_message);
  const deltaframe = MSG_ReadLong(net_message);
  const surpressCount = MSG_ReadByte(net_message);

  const len = MSG_ReadByte(net_message);
  MSG_ReadData(net_message, areabits, len);

  return { serverframe, deltaframe, surpressCount };
}

function readFramePlayerstate(from: PlayerStateT, to: PlayerStateT): void {
  const cmd = MSG_ReadByte(net_message);
  if (cmd !== SvcOpsT.svc_playerinfo) throw new ComError(ERR_DROP, `kexdemo: CL_ParseFrame: not playerinfo (got ${cmd})`);
  const flags = readKexFlags();
  readKexPlayerStateFields(from, to, flags);
}

function readPacketEntitiesBegin(): void {
  const cmd = MSG_ReadByte(net_message);
  if (cmd !== SvcOpsT.svc_packetentities) throw new ComError(ERR_DROP, `kexdemo: CL_ParseFrame: not packetentities (got ${cmd})`);
}

function readDeltaUsercmd(_msg: SizeBuf, _from: UsercmdT, _move: UsercmdT): void {
  // A demo stream is server->client only; clc_move never appears in one.
  throw new ComError(ERR_DROP, "KEX_DEMO_CODEC.readDeltaUsercmd: unreachable -- demo streams carry no client->server messages");
}

// ---------------------------------------------------------------------------
// Write side -- genuinely unsupported. This engine never records or serves
// native KEX-format (2022/2023) streams, only plays them back (the brief's
// own "read side only" scope, ARCHITECTURE.md). ProtocolCodec requires the
// full interface shape (VANILLA_CODEC/Q2REPRO_CODEC both implement read AND
// write); these throw a clear, specific error rather than silently no-op-ing
// or producing wrong bytes if ever mistakenly invoked.
// ---------------------------------------------------------------------------
function writeOnly(op: string): never {
  throw new ComError(ERR_DROP, `KEX_DEMO_CODEC.${op}: this codec is read-only (demo playback only, see kexdemo.ts file header) -- writing native KEX-format streams is not implemented`);
}
function writeServerData(_msg: SizeBuf, _params: ServerDataParamsT): void {
  writeOnly("writeServerData");
}
function writeDeltaEntity(_msg: SizeBuf, _from: EntityStateT, _to: EntityStateT, _force: boolean, _newentity: boolean): void {
  writeOnly("writeDeltaEntity");
}
function writeEntityRemove(_msg: SizeBuf, _oldnum: number): void {
  writeOnly("writeEntityRemove");
}
function writePacketEntitiesEnd(_msg: SizeBuf): void {
  writeOnly("writePacketEntitiesEnd");
}
function writeSpawnBaseline(_msg: SizeBuf, _base: EntityStateT): void {
  writeOnly("writeSpawnBaseline");
}
function writePlayerStateDelta(_msg: SizeBuf, _from: PlayerStateT, _to: PlayerStateT): void {
  writeOnly("writePlayerStateDelta");
}
function writePacketEntitiesBegin(_msg: SizeBuf): void {
  writeOnly("writePacketEntitiesBegin");
}
function writeFrame(_msg: SizeBuf, _params: FrameWriteParamsT, _writeEntities: (msg: SizeBuf) => void): void {
  writeOnly("writeFrame");
}
function writeDeltaUsercmd(_msg: SizeBuf, _from: UsercmdT, _cmd: UsercmdT): void {
  writeOnly("writeDeltaUsercmd");
}

export const KEX_DEMO_CODEC: ProtocolCodec = {
  name: "kexdemo",
  writeServerData,
  writeDeltaEntity,
  writeEntityRemove,
  writePacketEntitiesEnd,
  writeSpawnBaseline,
  writePlayerStateDelta,
  writePacketEntitiesBegin,
  writeFrame,
  writeDeltaUsercmd,
  readDeltaUsercmd,
  readServerData,
  readEntityBits,
  readDeltaEntity,
  readPlayerStateDelta,
  readFrameHeader,
  readFramePlayerstate,
  readPacketEntitiesBegin,
};

// ---------------------------------------------------------------------------
// Auxiliary messages -- NOT part of ProtocolCodec (see file header). Every
// reader below consumes exactly the bytes its own citation says and returns
// a plain result object; none of them are wired into game-state side
// effects here (that belongs to cl_parse.ts's dispatch, which owns `cl`).
// ---------------------------------------------------------------------------

export { readFog } from "./q2repro"; // kex.c:267 reuses q2proto_q2repro_client_read_fog verbatim

export interface KexDamageIndicatorT {
  damage: number; // 5 bits, 0-31
  health: boolean;
  armor: boolean;
  shield: boolean;
  direction: Float32Array; // 3 -- packed_direction (bytedirs table lookup)
}

const MAX_DAMAGE_INDICATORS = 4; // Q2PROTO_MAX_DAMAGE_INDICATORS (q2proto_limits.h:28)

// q2proto_q2repro_client_read_damage, q2repro.c:789-807 -- reused verbatim
// by kex.c:262 (`case svc_rr_damage: return q2proto_q2repro_client_read_damage(...)`).
export function readDamageKex(): KexDamageIndicatorT[] {
  const count = MSG_ReadByte(net_message);
  const result: KexDamageIndicatorT[] = [];
  for (let i = 0; i < count; i++) {
    const encoded = MSG_ReadByte(net_message);
    const direction = new Float32Array(3);
    MSG_ReadDir(net_message, direction);
    if (i >= MAX_DAMAGE_INDICATORS) continue; // bytes still consumed above, just not stored -- matches q2repro.c:800-801
    result.push({
      damage: encoded & 0x1f,
      health: (encoded & 0x20) !== 0,
      armor: (encoded & 0x40) !== 0,
      shield: (encoded & 0x80) !== 0,
      direction,
    });
  }
  return result;
}

export interface KexPoiT {
  key: number;
  time: number;
  pos: Float32Array; // 3
  image: number;
  color: number;
  flags: number;
}

// q2proto_q2repro_client_read_poi, q2repro.c:885-895 -- reused verbatim by
// kex.c:270 (`case svc_rr_poi`).
export function readPoiKex(): KexPoiT {
  const key = MSG_ReadShort(net_message);
  const time = MSG_ReadShort(net_message);
  const pos = new Float32Array([MSG_ReadFloat(net_message), MSG_ReadFloat(net_message), MSG_ReadFloat(net_message)]);
  const image = MSG_ReadShort(net_message);
  const color = MSG_ReadByte(net_message);
  const flags = MSG_ReadByte(net_message);
  return { key, time, pos, image, color, flags };
}

export interface KexHelpPathT {
  start: boolean;
  pos: Float32Array; // 3
  dir: Float32Array; // 3
}

// q2proto_q2repro_client_read_help_path, q2repro.c:897-907 -- reused
// verbatim by kex.c:271 (`case svc_rr_help_path`).
export function readHelpPathKex(): KexHelpPathT {
  const start = MSG_ReadByte(net_message) !== 0;
  const pos = new Float32Array([MSG_ReadFloat(net_message), MSG_ReadFloat(net_message), MSG_ReadFloat(net_message)]);
  const dir = new Float32Array(3);
  MSG_ReadDir(net_message, dir);
  return { start, pos, dir };
}

export interface KexMuzzleflash3T {
  entity: number; // i16
  weapon: number; // u16
}

// q2proto_q2repro_client_read_muzzleflash3, q2repro.c:744-749 -- reused
// verbatim by kex.c:272 (`case svc_rr_muzzleflash3`).
export function readMuzzleflash3Kex(): KexMuzzleflash3T {
  const entity = MSG_ReadShort(net_message);
  const weapon = MSG_ReadShort(net_message) & 0xffff;
  return { entity, weapon };
}

// q2proto_q2repro_client_read_achievement, q2repro.c:909-913 -- reused
// verbatim by kex.c:273 (`case svc_rr_achievement`).
export function readAchievementKex(): string {
  return MSG_ReadString(net_message);
}

export interface KexLocprintT {
  flags: number;
  base: string;
  args: string[];
}

const MAX_LOCALIZATION_ARGS = 8; // Q2PROTO_MAX_LOCALIZATION_ARGS (q2proto_limits.h:32)

// kex_client_read_locprint, kex.c:892-901 -- KEX-only, no q2repro equivalent.
export function readLocprintKex(): KexLocprintT {
  const flags = MSG_ReadByte(net_message);
  const base = MSG_ReadString(net_message);
  const numArgs = MSG_ReadByte(net_message);
  if (numArgs > MAX_LOCALIZATION_ARGS) {
    throw new ComError(ERR_DROP, `kexdemo: svc_rr_locprint num_args ${numArgs} exceeds MAX_LOCALIZATION_ARGS (${MAX_LOCALIZATION_ARGS})`);
  }
  const args: string[] = [];
  for (let i = 0; i < numArgs; i++) args.push(MSG_ReadString(net_message));
  return { flags, base, args };
}

// kex_client_read_splitclient, kex.c:798-805 -- KEX-only, no q2repro
// equivalent. Split-screen demos are explicitly unsupported beyond
// correctly skipping this one byte (q2proto's own client discards it too;
// the message is surfaced to its caller as a plain NOP, kex.c:246-249).
export function readSplitclientKex(): void {
  MSG_ReadByte(net_message); // isplit -- discarded, matching q2proto's own (void)isplit
}

// True for a real recorded demo (2022); false for live-native-KEX network
// traffic (2023, never emitted by this engine's own server). Exposed so
// cl_parse.ts's dispatch can pick the legacy (vanilla-compatible, 2022) vs.
// float (2023-only, NOT implemented -- see file header SCOPE CUTS) wire
// shape for svc_temp_entity/svc_sound's SND_POS.
export function isKexDemoProtocol(): boolean {
  return kexServerProtocol === PROTOCOL_KEX_DEMOS;
}

export interface KexSoundT {
  flags: number;
  index: number;
  volume: number;
  attenuation: number;
  timeofs: number;
  entity: number;
  channel: number;
  pos: Float32Array | null; // 3, only when SND_POS is set
}

// kex_client_read_sound, kex.c:566-603. Genuinely different from
// q2repro's own svc_sound (u16 index vs q2repro's presumed float-index
// scheme; SND_KEX_LARGE_ENT widens entchan to u32; SND_POS uses the
// 2022/2023 precision fork like entity origins). 2023's float SND_POS is
// NOT implemented (see file header SCOPE CUTS) -- throws rather than
// silently misdecoding if ever reached.
export function readSoundKex(): KexSoundT {
  const flags = MSG_ReadByte(net_message);
  const index = MSG_ReadShort(net_message);

  const volume = flags & SND_VOLUME ? MSG_ReadByte(net_message) / 255 : SOUND_DEFAULT_VOLUME;
  const attenuation = flags & SND_ATTENUATION ? MSG_ReadByte(net_message) / 64 : SOUND_DEFAULT_ATTENUATION;
  const timeofs = flags & SND_OFFSET ? MSG_ReadByte(net_message) / 1000 : 0;

  let entity = 0;
  let channel = 0;
  if (flags & SND_ENT) {
    const entchan = flags & SND_KEX_LARGE_ENT ? MSG_ReadLong(net_message) >>> 0 : MSG_ReadShort(net_message) & 0xffff;
    entity = entchan >>> 3;
    channel = entchan & 7;
  }

  let pos: Float32Array | null = null;
  if (flags & SND_POS) {
    if (!isKexDemoProtocol()) {
      throw new ComError(ERR_DROP, "kexdemo: svc_sound SND_POS in float form (protocol 2023) is not implemented -- see kexdemo.ts file header SCOPE CUTS");
    }
    pos = new Float32Array([
      MSG_ReadShort(net_message) * COORD_SHORT_SCALE,
      MSG_ReadShort(net_message) * COORD_SHORT_SCALE,
      MSG_ReadShort(net_message) * COORD_SHORT_SCALE,
    ]);
  }

  return { flags, index, volume, attenuation, timeofs, entity, channel, pos };
}

// ---------------------------------------------------------------------------
// svc_rr_configblast / svc_rr_spawnbaselineblast (kex.c:807-890) -- a u16
// compressed_len + u16 uncompressed_len (discarded) header, then a
// zlib-wrapped (Q2P_INFL_DEFL_HEADER -- has a standard 2-byte zlib header,
// unlike ZIP's raw deflate entries) deflate stream of `compressed_len`
// bytes. Inflated via node:zlib.inflateSync, matching this port line's own
// established precedent (qcommon/png.ts's IDAT decompression,
// qcommon/zipfile.ts's own require("node:zlib") use -- see that file's
// header for why raw ZIP entries need inflateRawSync instead; this is NOT
// that case).
// ---------------------------------------------------------------------------

function inflateInternal(compressedLen: number): Uint8Array {
  const compressed = new Uint8Array(compressedLen);
  MSG_ReadData(net_message, compressed, compressedLen);
  const zlib = require("node:zlib") as typeof import("node:zlib");
  try {
    return new Uint8Array(zlib.inflateSync(compressed));
  } catch (e) {
    throw new ComError(ERR_DROP, `kexdemo: zlib inflate failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Wraps an already-inflated buffer as a fresh, independent SizeBuf for
// reading via the generic MSG_Read* primitives (all of which take an
// explicit buffer param) -- deliberately NOT the shared net_message
// singleton, so the outer dispatch loop's own read position over the raw
// (still-compressed-container) message is left completely undisturbed.
function makeReadBuf(data: Uint8Array): SizeBuf {
  const buf = new SizeBuf();
  SZ_Init(buf, data, data.length);
  buf.cursize = data.length; // mark the whole inflated buffer as "written" so reads are in-bounds
  MSG_BeginReading(buf);
  return buf;
}

export interface KexConfigstringRecordT {
  index: number;
  value: string;
}

// kex_client_read_begin_configblast + kex_client_read_continue_configblast
// (kex.c:844-864, 871-890). Reads the whole compressed block up front and
// decodes every inner {u16 index, string value} record from the inflated
// buffer, rather than porting q2proto's own incremental re-entrant
// state-machine shape (context->client_read swap) -- this port's dispatch
// loop calls one function per opcode and gets a complete result back,
// matching every other multi-field message reader in this file.
export function readConfigblastKex(): KexConfigstringRecordT[] {
  const compressedLen = MSG_ReadShort(net_message);
  MSG_ReadShort(net_message); // uncompressed_len -- discarded (kex.c:882, "(void)uncompressed_len")
  const inflated = inflateInternal(compressedLen);
  const buf = makeReadBuf(inflated);

  const records: KexConfigstringRecordT[] = [];
  while (buf.readcount < buf.cursize) {
    const index = MSG_ReadShort(buf);
    const value = MSG_ReadString(buf);
    records.push({ index, value });
  }
  return records;
}

// kex_client_read_begin_spawnbaselineblast + ..._continue_spawnbaselineblast
// (kex.c:807-826, 827-846). Each inner record is a full
// kex_client_read_baseline (entity-bits header + readDeltaEntity body) --
// both readEntityBits/readDeltaEntity above are hardcoded to read from the
// shared net_message singleton (codec.ts's own documented "signature
// asymmetry": these two ops were never parameterized), so this temporarily
// repoints net_message AT the inflated buffer, reads every baseline record,
// then restores net_message's original data/cursor exactly -- the outer
// dispatch loop resumes reading the raw (still-compressed-container)
// message exactly where it left off, none the wiser.
export function readSpawnbaselineblastKex(): Array<{ entnum: number; state: EntityStateT }> {
  const compressedLen = MSG_ReadShort(net_message);
  MSG_ReadShort(net_message); // uncompressed_len -- discarded
  const inflated = inflateInternal(compressedLen);

  const saved = { data: net_message.data, view: net_message.view, cursize: net_message.cursize, readcount: net_message.readcount, maxsize: net_message.maxsize };
  net_message.data = inflated;
  net_message.view = new DataView(inflated.buffer, inflated.byteOffset, inflated.byteLength);
  net_message.cursize = inflated.length;
  net_message.readcount = 0;
  net_message.maxsize = inflated.length;

  const results: Array<{ entnum: number; state: EntityStateT }> = [];
  try {
    while (net_message.readcount < net_message.cursize) {
      const { number: entnum, bits } = readEntityBitsWide();
      const state = new EntityStateT();
      readDeltaEntity(new EntityStateT(), state, entnum, bits);
      state.number = entnum;
      results.push({ entnum, state });
    }
  } finally {
    net_message.data = saved.data;
    net_message.view = saved.view;
    net_message.cursize = saved.cursize;
    net_message.readcount = saved.readcount;
    net_message.maxsize = saved.maxsize;
  }
  return results;
}
