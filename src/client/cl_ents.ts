// cl_ents.c -- entity parsing and management

import { type Vec3, VectorCopy, VectorMA, AngleVectors, LerpAngle, anglemod } from "../shared/math";
import { fixedLength } from "../shared/fixed";
import {
  EntityStateT,
  PlayerStateT,
  PmTypeT,
  PMF_NO_PREDICTION,
  VIDREF_GL,
  EntityEventT,
  EF_TELEPORTER,
  EF_ROTATE,
  EF_GIB,
  EF_BLASTER,
  EF_ROCKET,
  EF_GRENADE,
  EF_HYPERBLASTER,
  EF_BFG,
  EF_COLOR_SHELL,
  EF_POWERSCREEN,
  EF_ANIM01,
  EF_ANIM23,
  EF_ANIM_ALL,
  EF_ANIM_ALLFAST,
  EF_FLIES,
  EF_QUAD,
  EF_PENT,
  EF_FLAG1,
  EF_FLAG2,
  EF_IONRIPPER,
  EF_GREENGIB,
  EF_BLUEHYPERBLASTER,
  EF_SPINNINGLIGHTS,
  EF_PLASMA,
  EF_TRAP,
  EF_TRACKER,
  EF_DOUBLE,
  EF_SPHERETRANS,
  EF_TAGTRAIL,
  EF_HALF_DAMAGE,
  EF_TRACKERTRAIL,
  RF_MINLIGHT,
  RF_VIEWERMODEL,
  RF_WEAPONMODEL,
  RF_DEPTHHACK,
  RF_TRANSLUCENT,
  RF_FULLBRIGHT,
  RF_FRAMELERP,
  RF_BEAM,
  RF_SHELL_RED,
  RF_SHELL_GREEN,
  RF_SHELL_BLUE,
  RF_SHELL_DOUBLE,
  RF_SHELL_HALF_DAM,
  RF_CUSTOM_LIGHT,
  RF_FLARE,
  Q_strcasecmp,
  PM_TypeIsAlive,
} from "../shared/q_shared";
import type { ModelS } from "./ref";
import { EntityT } from "./ref";
import { cl, cls, ConnstateT, cl_entities, cl_parse_entities, MAX_PARSE_ENTITIES, FrameT, clCvars, gun_frame, gun_model, MAX_CLIENTWEAPONMODELS, re } from "./client";
import { net_message } from "../qcommon/net_chan";
import { UPDATE_MASK, ERR_DROP, U_REMOVE } from "../qcommon/qcommon";
import { Com_Error, Com_Printf, Com_ServerState } from "../qcommon/common";
import { Cvar_Get } from "../qcommon/cvar";
import { Cbuf_AddText } from "../qcommon/cmd";
import { sv, ServerStateT } from "../server/server";
import {
  CL_RocketTrail,
  CL_DiminishingTrail,
  CL_FlyEffect,
  CL_BfgParticles,
  CL_TrapParticles,
  CL_FlagTrail,
  CL_EntityEvent,
  CL_TeleporterParticles,
  CL_IonripperTrail,
  CL_BlasterTrail,
  CL_AddParticles,
  CL_AddDLights,
  CL_AddLightStyles,
} from "./cl_fx";
import { CL_TrackerTrail, CL_Tracker_Shell, CL_TagTrail, CL_BlasterTrail2 } from "./cl_newfx";
import { CL_AddTEnts } from "./cl_tent";
import { CL_CheckPredictionError } from "./cl_pred";
import { V_AddEntity, V_AddLight } from "./cl_view";
import { SCR_EndLoadingPlaque } from "./cl_scrn";
import { Developer_searchpath } from "../qcommon/files";

//PGM -- extern in game/q_shared.h, defined here (confirmed by grep of the
// full v3.19 tree); set by win32/vid_dll.c, which per PORTING.md's platform
// mapping is not ported. src/platform/vid.ts exists now (both ref_gl and
// ref_soft are real, landed renderers), but nothing in it calls
// setVidrefVal -- reported gap, now more consequential than when this was
// written: cl_newfx.ts/cl_fx.ts/cl_tent.ts's `vidref_val === VIDREF_GL`
// branches always take the non-GL path regardless of which renderer is
// actually active. Stays 0 (VIDREF_OTHER's absence) until platform/vid.ts's
// renderer-selection path wires up the setter.
export let vidref_val = 0;
export function setVidrefVal(v: number): void {
  vidref_val = v;
}

// extern in cl_ents.c, defined in cl_tent.c (CL_RegisterTEntModels).
// cl_tent.ts's CL_RegisterTEntModels is a real, landed implementation now,
// but it assigns its OWN module-local `cl_mod_powerscreen` export directly
// (src/client/cl_tent.ts) rather than calling this file's setClModPowerscreen
// -- so this copy is never actually written and the RF_POWERSCREEN consumer
// below always sees null. LIVE BUG, not fixed here (out of this unit's
// SCOPE): wire cl_tent.ts's CL_RegisterTEntModels to call
// setClModPowerscreen, or have this file import cl_tent.ts's real binding
// directly and drop this dead local copy.
export let cl_mod_powerscreen: ModelS | null = null;
export function setClModPowerscreen(v: ModelS | null): void {
  cl_mod_powerscreen = v;
}

/*
=================
CL_FrameTimeMs

The original engine hardcodes every `serverframe` -> milliseconds
conversion to `* 100` (BASE_FRAMERATE 10, i.e. FRAMETIME 100ms):
protocol 34's `svc_frame` message carries only a raw frame *counter*, no
tick-duration field, so a receiving client has no wire-level way to know
the sending server's actual frame period -- assuming the fixed legacy
10 Hz was safe because every pre-rerelease server ran at exactly that
rate. That assumption breaks now that a kex-family local server can run
at any `sv_tick_rate` in [10,60] (sv_init.ts's SV_SpawnServer, family
dispatch via sv_game.ts's currentGameFamily()): a 40 Hz local server's
frames are 25ms apart, not 100ms, and calculating servertime/lerpfrac
against a hardcoded 100 would run playback 4x too slow.

Documented, flagged seam for now: when this process IS the server (a
listen/singleplayer game -- `Com_ServerState()` mirrors `sv.state`, set by
Com_SetServerState in sv_init.ts/sv_main.ts), the client reads `sv.frametime`
directly out of the server module rather than off the wire, exactly like
cl_main.ts already reaches into `../server/sv_main` for SV_Shutdown/
allow_download*. Connected to a REMOTE server, there is still no wire
signal, so this falls back to the legacy 100ms assumption (correct for
every legacy-family remote server; wrong today for a remote kex-family
server running a non-default tick rate -- a real gap, not silently papered
over here, that needs the 1038 codec to carry the server's actual frame
time on the wire; see ARCHITECTURE.md phase 5 "Protocol layer").
=================
*/
function CL_FrameTimeMs(): number {
  return Com_ServerState() !== ServerStateT.ss_dead ? sv.frametime : 100;
}

/*
=================
CL_ParseEntityBits

Returns the entity number and the header bits

ARCHITECTURE.md "Protocol layer" / .orch/phase5-design.md step 1: the wire
decoding this function used to do directly now lives in
qcommon/protocol/vanilla.ts's readEntityBits (extracted verbatim, including
the bit-count profiling counter, which moved there too since nothing outside
this function ever read it). This wrapper is kept, unchanged in signature, so
the existing direct callers/imports (this file's CL_ParsePacketEntities,
cl_parse.ts's CL_ParseBaseline, and test/cl_parse.test.ts) keep working while
actually routing through cls.codec.
=================
*/
export function CL_ParseEntityBits(): { number: number; bits: number } {
  return cls.codec.readEntityBits();
}

// struct-copy helper (PORTING.md: "struct copies need explicit clone
// helpers"). sv_ents.ts/sv_init.ts each keep a private unexported copy of
// the same field set; duplicated here for the same reason.
function copyEntityState(dst: EntityStateT, src: EntityStateT): void {
  dst.number = src.number;
  VectorCopy(src.origin, dst.origin);
  VectorCopy(src.angles, dst.angles);
  VectorCopy(src.old_origin, dst.old_origin);
  dst.modelindex = src.modelindex;
  dst.modelindex2 = src.modelindex2;
  dst.modelindex3 = src.modelindex3;
  dst.modelindex4 = src.modelindex4;
  dst.frame = src.frame;
  dst.skinnum = src.skinnum;
  dst.effects = src.effects;
  dst.renderfx = src.renderfx;
  dst.solid = src.solid;
  dst.sound = src.sound;
  dst.event = src.event;
}

/*
==================
CL_ParseDelta

Can go from either a baseline or a previous packet_entity

ARCHITECTURE.md "Protocol layer" / .orch/phase5-design.md step 1: the field-
body decoding this function used to do directly now lives in
qcommon/protocol/vanilla.ts's readDeltaEntity (extracted verbatim, including
its own private copy of the copyEntityState struct-copy helper -- see that
file's header comment). This wrapper is kept, unchanged in signature, so the
existing direct callers/imports (this file's CL_DeltaEntity, cl_parse.ts's
CL_ParseBaseline, and test/cl_parse.test.ts) keep working while actually
routing through cls.codec.
==================
*/
export function CL_ParseDelta(from: EntityStateT, to: EntityStateT, number: number, bits: number): void {
  cls.codec.readDeltaEntity(from, to, number, bits);
}

// C's abs() takes an int; passing float origin deltas to it implicitly
// truncates toward zero before taking the absolute value. Preserved
// bug-for-bug rather than using a float-precision Math.abs.
function absInt(x: number): number {
  return Math.abs(Math.trunc(x));
}

/*
==================
CL_DeltaEntity

Parses deltas from the given base and adds the resulting entity
to the current frame
==================
*/
function CL_DeltaEntity(frame: FrameT, newnum: number, old: EntityStateT, bits: number): void {
  const ent = cl_entities[newnum];

  const state = cl_parse_entities[cl.parse_entities & (MAX_PARSE_ENTITIES - 1)];
  cl.parse_entities++;
  frame.num_entities++;

  CL_ParseDelta(old, state, newnum, bits);

  // some data changes will force no lerping
  if (
    state.modelindex !== ent.current.modelindex ||
    state.modelindex2 !== ent.current.modelindex2 ||
    state.modelindex3 !== ent.current.modelindex3 ||
    state.modelindex4 !== ent.current.modelindex4 ||
    absInt(state.origin[0] - ent.current.origin[0]) > 512 ||
    absInt(state.origin[1] - ent.current.origin[1]) > 512 ||
    absInt(state.origin[2] - ent.current.origin[2]) > 512 ||
    state.event === EntityEventT.EV_PLAYER_TELEPORT ||
    state.event === EntityEventT.EV_OTHER_TELEPORT
  ) {
    ent.serverframe = -99;
  }

  if (ent.serverframe !== cl.frame.serverframe - 1) {
    // wasn't in last update, so initialize some things
    ent.trailcount = 1024; // for diminishing rocket / grenade trails
    // duplicate the current state so lerping doesn't hurt anything
    copyEntityState(ent.prev, state);
    if (state.event === EntityEventT.EV_OTHER_TELEPORT) {
      VectorCopy(state.origin, ent.prev.origin);
      VectorCopy(state.origin, ent.lerp_origin);
    } else {
      VectorCopy(state.old_origin, ent.prev.origin);
      VectorCopy(state.old_origin, ent.lerp_origin);
    }
  } else {
    // shuffle the last state to previous
    copyEntityState(ent.prev, ent.current);
  }

  ent.serverframe = cl.frame.serverframe;
  copyEntityState(ent.current, state);
}

/*
==================
CL_ParsePacketEntities

An svc_packetentities has just been parsed, deal with the
rest of the data stream.
==================
*/
function CL_ParsePacketEntities(oldframe: FrameT | null, newframe: FrameT): void {
  newframe.parse_entities = cl.parse_entities;
  newframe.num_entities = 0;

  // delta from the entities present in oldframe
  let oldindex = 0;
  let oldstate: EntityStateT | null = null;
  let oldnum: number;
  if (!oldframe) {
    oldnum = 99999;
  } else if (oldindex >= oldframe.num_entities) {
    oldnum = 99999;
  } else {
    oldstate = cl_parse_entities[(oldframe.parse_entities + oldindex) & (MAX_PARSE_ENTITIES - 1)];
    oldnum = oldstate.number;
  }

  // repeated four times verbatim in the original; folded into one helper
  // (mirrors PORTING.md's "goto -> restructure" idiom, not an algorithm change)
  function advanceOld(): void {
    oldindex++;
    if (!oldframe || oldindex >= oldframe.num_entities) {
      oldnum = 99999;
      oldstate = null;
    } else {
      oldstate = cl_parse_entities[(oldframe.parse_entities + oldindex) & (MAX_PARSE_ENTITIES - 1)];
      oldnum = oldstate.number;
    }
  }

  for (;;) {
    const { number: newnum, bits } = CL_ParseEntityBits();
    // q2repro parse.c:183 `if (newnum < 0 || newnum >= cl.csr.max_edicts)` --
    // bound against the ACTIVE family's csr, not a compile-time constant:
    // protocol 34/35/36 (CS_REMAP_OLD) stays capped at 1024 exactly as
    // vanilla always was, while 1038/kex (CS_REMAP_RERELEASE) allows the
    // full 8192-entity range cl_entities is now sized to hold.
    if (newnum >= cls.csr.max_edicts) {
      Com_Error(ERR_DROP, "CL_ParsePacketEntities: bad number:%i", newnum);
    }

    if (net_message.readcount > net_message.cursize) {
      Com_Error(ERR_DROP, "CL_ParsePacketEntities: end of message");
    }

    if (!newnum) break;

    while (oldnum < newnum) {
      // one or more entities from the old packet are unchanged
      if (clCvars.cl_shownet?.value === 3) Com_Printf("   unchanged: %i\n", oldnum);
      if (oldstate) CL_DeltaEntity(newframe, oldnum, oldstate, 0);

      advanceOld();
    }

    if (bits & U_REMOVE) {
      // the entity present in oldframe is not in the current frame
      if (clCvars.cl_shownet?.value === 3) Com_Printf("   remove: %i\n", newnum);
      if (oldnum !== newnum) Com_Printf("U_REMOVE: oldnum != newnum\n");

      advanceOld();
      continue;
    }

    if (oldnum === newnum) {
      // delta from previous state
      if (clCvars.cl_shownet?.value === 3) Com_Printf("   delta: %i\n", newnum);
      if (oldstate) CL_DeltaEntity(newframe, newnum, oldstate, bits);

      advanceOld();
      continue;
    }

    if (oldnum > newnum) {
      // delta from baseline
      if (clCvars.cl_shownet?.value === 3) Com_Printf("   baseline: %i\n", newnum);
      CL_DeltaEntity(newframe, newnum, cl_entities[newnum].baseline, bits);
      continue;
    }
  }

  // any remaining entities in the old frame are copied over
  while (oldnum !== 99999) {
    // one or more entities from the old packet are unchanged
    if (clCvars.cl_shownet?.value === 3) Com_Printf("   unchanged: %i\n", oldnum);
    if (oldstate) CL_DeltaEntity(newframe, oldnum, oldstate, 0);

    advanceOld();
  }
}

/*
===================
CL_ParsePlayerstate

ARCHITECTURE.md "Protocol layer" / .orch/phase5-design.md step 1: the wire-
field decoding this function used to do directly (plus the "copy forward
from the old frame's playerstate" struct-copy step) now lives in
qcommon/protocol/vanilla.ts's readPlayerStateDelta. The `cl.attractloop`
demo-playback override stays here rather than moving into the codec, since it
is not wire decoding and depends on this module's `cl` singleton, which the
codec module does not import -- see vanilla.ts's header comment for why this
is behavior-preserving.
===================
*/
function CL_ParsePlayerstate(oldframe: FrameT | null, newframe: FrameT): void {
  let target: PlayerStateT;
  const from = oldframe ? oldframe.playerstate : new PlayerStateT();
  if (oldframe) {
    target = newframe.playerstate;
  } else {
    target = new PlayerStateT();
    newframe.playerstate = target;
  }

  cls.codec.readFramePlayerstate(from, target);

  if (cl.attractloop) target.pmove.pm_type = PmTypeT.PM_FREEZE; // demo playback
}

/*
==================
CL_FireEntityEvents
==================
*/
function CL_FireEntityEvents(frame: FrameT): void {
  for (let pnum = 0; pnum < frame.num_entities; pnum++) {
    const num = (frame.parse_entities + pnum) & (MAX_PARSE_ENTITIES - 1);
    const s1 = cl_parse_entities[num];
    if (s1.event) CL_EntityEvent(s1);

    // EF_TELEPORTER acts like an event, but is not cleared each frame
    if (s1.effects & EF_TELEPORTER) CL_TeleporterParticles(s1);
  }
}

/*
================
CL_ParseFrame
================
*/
export function CL_ParseFrame(): void {
  // memset(&cl.frame, 0, sizeof(cl.frame)) -- cl.frame may be aliased into
  // cl.frames[] from a previous call, so it is replaced with a fresh
  // instance rather than mutated in place (mirrors ClStateT.clear()'s same
  // convention for the identical reason).
  cl.frame = new FrameT();

  // Header + areabits: envelope shape (framenum/delta encoding, per-protocol
  // frame-flags byte) is now owned by cls.codec (ARCHITECTURE.md "Protocol
  // layer" / .orch/phase5-design.md phase 5 -- q2repro.ts's file header
  // "RESOLVED: frame envelope" note). `readSuppressByte` threads through the
  // pre-existing "BIG HACK to let old demos continue to work" (protocol 26
  // never had a suppress-count byte on the wire).
  const readSuppressByte = cls.serverProtocol !== 26;
  const header = cls.codec.readFrameHeader(cl.frame.areabits, readSuppressByte);
  cl.frame.serverframe = header.serverframe;
  cl.frame.deltaframe = header.deltaframe;
  const frameTimeMs = CL_FrameTimeMs();
  cl.frame.servertime = cl.frame.serverframe * frameTimeMs;

  if (readSuppressByte) cl.surpressCount = header.surpressCount;

  if (clCvars.cl_shownet?.value === 3) Com_Printf("   frame:%i  delta:%i\n", cl.frame.serverframe, cl.frame.deltaframe);

  // If the frame is delta compressed from data that we
  // no longer have available, we must suck up the rest of
  // the frame, but not use it, then ask for a non-compressed
  // message
  let old: FrameT | null;
  if (cl.frame.deltaframe <= 0) {
    cl.frame.valid = true; // uncompressed frame
    old = null;
    cls.demowaiting = false; // we can start recording now
  } else {
    old = cl.frames[cl.frame.deltaframe & UPDATE_MASK];
    if (!old.valid) {
      // should never happen
      Com_Printf("Delta from invalid frame (not supposed to happen!).\n");
    }
    if (old.serverframe !== cl.frame.deltaframe) {
      // The frame that the server did the delta from
      // is too old, so we can't reconstruct it properly.
      Com_Printf("Delta frame too old.\n");
    } else if (cl.parse_entities - old.parse_entities > MAX_PARSE_ENTITIES - 128) {
      Com_Printf("Delta parse_entities too old.\n");
    } else {
      cl.frame.valid = true; // valid delta parse
    }
  }

  // clamp time
  if (cl.time > cl.frame.servertime) cl.time = cl.frame.servertime;
  else if (cl.time < cl.frame.servertime - frameTimeMs) cl.time = cl.frame.servertime - frameTimeMs;

  // read playerinfo (opcode boundary, if any, is cls.codec's concern -- see
  // ProtocolCodec.readFramePlayerstate; vanilla still validates
  // svc_playerinfo the way this used to inline). NOTE: the cl_shownet>=2
  // per-submessage opcode print this used to do inline for svc_playerinfo/
  // svc_packetentities is dropped now that the opcode read moved inside the
  // codec seam (q2repro has no such opcode to print); cl_shownet>=3's
  // per-entity delta/baseline/remove prints inside CL_ParsePacketEntities
  // are unaffected.
  CL_ParsePlayerstate(old, cl.frame);

  // read packet entities (opcode boundary, if any, is cls.codec's concern --
  // see ProtocolCodec.readPacketEntitiesBegin)
  cls.codec.readPacketEntitiesBegin();
  CL_ParsePacketEntities(old, cl.frame);

  // save the frame off in the backup array for later delta comparisons
  cl.frames[cl.frame.serverframe & UPDATE_MASK] = cl.frame;

  if (cl.frame.valid) {
    // getting a valid frame message ends the connection process
    if (cls.state !== ConnstateT.ca_active) {
      cls.state = ConnstateT.ca_active;
      cl.force_refdef = true;
      cl.predicted_origin[0] = cl.frame.playerstate.pmove.origin[0] * 0.125;
      cl.predicted_origin[1] = cl.frame.playerstate.pmove.origin[1] * 0.125;
      cl.predicted_origin[2] = cl.frame.playerstate.pmove.origin[2] * 0.125;
      VectorCopy(cl.frame.playerstate.viewangles, cl.predicted_angles);
      // q2repro client/entities.c:319-322: seed both eye-height slots from
      // the first frame and zero the change timer, so entering a level does
      // not play a 100ms "stand up" ease from 0.
      cl.current_viewheight = cl.frame.playerstate.pmove.viewheight;
      cl.prev_viewheight = cl.frame.playerstate.pmove.viewheight;
      cl.viewheight_change_time = 0;
      if (cls.disable_servercount !== cl.servercount && cl.refresh_prepped) {
        SCR_EndLoadingPlaque(); // get rid of loading plaque
      }
      // q2repro src/client/entities.c:337-339 -- EXEC_TRIGGER(cl_beginmapcmd)
      // fires once the first valid frame after connecting arrives (this
      // port's closest analog to that same "entering the level" moment);
      // "#cl_enterlevel"-style trigger aliases are not ported, only the cvar.
      if (!cls.demoplayback) {
        const beginmapcmd = Cvar_Get("cl_beginmapcmd", "", 0);
        if (beginmapcmd && beginmapcmd.string) {
          Cbuf_AddText(beginmapcmd.string);
          Cbuf_AddText("\n");
        }
      }
    }
    cl.sound_prepped = true; // can start mixing ambient sounds

    // fire entity events
    CL_FireEntityEvents(cl.frame);
    CL_CheckPredictionError();
  }
}

/*
==========================================================================

INTERPOLATE BETWEEN FRAMES TO GET RENDERING PARMS

==========================================================================
*/

// Defined but never called anywhere in the v3.19 tree (confirmed by grep) --
// dead code in the original engine. Ported anyway for fidelity since it is
// cheap and self-contained; not exported (matches its C linkage: file-local,
// no header declares it).
function S_RegisterSexedModel(ent: EntityStateT, base: string): ModelS | null {
  // determine what model the client is using
  let model = "";
  const n = cls.csr.playerskins + ent.number - 1;
  const cs = cl.configstrings[n] ?? "";
  if (cs) {
    const bs = cs.indexOf("\\");
    if (bs !== -1) {
      model = cs.slice(bs + 1);
      const slash = model.indexOf("/");
      if (slash !== -1) model = model.slice(0, slash);
    }
  }
  // if we can't figure it out, they're male
  if (!model) model = "male";

  let mdl = re?.RegisterModel(`players/${model}/${base.slice(1)}`) ?? null;
  if (!mdl) {
    // not found, try default weapon model
    mdl = re?.RegisterModel(`players/${model}/weapon.md2`) ?? null;
    if (!mdl) {
      // no, revert to the male model
      mdl = re?.RegisterModel(`players/male/${base.slice(1)}`) ?? null;
      if (!mdl) {
        // last try, default male weapon.md2
        mdl = re?.RegisterModel("players/male/weapon.md2") ?? null;
      }
    }
  }

  return mdl;
}

/*
===============
CL_AddPacketEntities
===============
*/
function CL_AddPacketEntities(frame: FrameT): void {
  const ent = new EntityT();

  // bonus items rotate at a fixed rate
  const autorotate = anglemod(cl.time / 10);

  // brush models can auto animate their frames
  const autoanim = Math.trunc((2 * cl.time) / 1000);

  for (let pnum = 0; pnum < frame.num_entities; pnum++) {
    const s1 = cl_parse_entities[(frame.parse_entities + pnum) & (MAX_PARSE_ENTITIES - 1)];

    const cent = cl_entities[s1.number];

    let effects = s1.effects;
    let renderfx = s1.renderfx;

    // reset per-entity transient fields (mirrors `memset(&ent, 0, sizeof(ent))`
    // being run once before the loop in C -- fields not explicitly set below
    // must not leak the previous iteration's values)
    ent.model = null;
    ent.skin = null;
    ent.skinnum = 0;
    ent.alpha = 0;
    ent.flags = 0;

    // set frame
    if (effects & EF_ANIM01) ent.frame = autoanim & 1;
    else if (effects & EF_ANIM23) ent.frame = 2 + (autoanim & 1);
    else if (effects & EF_ANIM_ALL) ent.frame = autoanim;
    else if (effects & EF_ANIM_ALLFAST) ent.frame = Math.trunc(cl.time / 100);
    else ent.frame = s1.frame;

    // quad and pent can do different things on client
    if (effects & EF_PENT) {
      effects &= ~EF_PENT;
      effects |= EF_COLOR_SHELL;
      renderfx |= RF_SHELL_RED;
    }

    if (effects & EF_QUAD) {
      effects &= ~EF_QUAD;
      effects |= EF_COLOR_SHELL;
      renderfx |= RF_SHELL_BLUE;
    }

    // PMM
    if (effects & EF_DOUBLE) {
      effects &= ~EF_DOUBLE;
      effects |= EF_COLOR_SHELL;
      renderfx |= RF_SHELL_DOUBLE;
    }

    if (effects & EF_HALF_DAMAGE) {
      effects &= ~EF_HALF_DAMAGE;
      effects |= EF_COLOR_SHELL;
      renderfx |= RF_SHELL_HALF_DAM;
    }
    // pmm

    ent.oldframe = cent.prev.frame;
    ent.backlerp = 1.0 - cl.lerpfrac;

    if (renderfx & (RF_FRAMELERP | RF_BEAM)) {
      // step origin discretely, because the frames
      // do the animation properly
      VectorCopy(cent.current.origin, ent.origin);
      VectorCopy(cent.current.old_origin, ent.oldorigin);
    } else {
      // interpolate origin
      for (let i = 0; i < 3; i++) {
        ent.origin[i] = ent.oldorigin[i] = cent.prev.origin[i] + cl.lerpfrac * (cent.current.origin[i] - cent.prev.origin[i]);
      }
    }

    // create a new entity

    if (cls.csr.extended) {
      // q2repro src/client/entities.c:710-748 handles both of these before
      // the model lookup below and jumps straight to the loop's `skip:`
      // label, so neither ever reaches the renderer. That matters here
      // because SP_misc_flare (rerelease g_misc.cpp:2136) and SP_target_light
      // (g_target.cpp:1532) both set `s.modelindex = 1`, which resolves to
      // cl.model_draw[1] -- the world model. Handing that to the renderer
      // draws the whole map once per such entity as an inline bmodel
      // (maps/mguhub.bsp: 8 target_lights x 66621 surfaces per frame) and
      // re-queues world surfaces that are already on the translucent chain,
      // which turns that chain into a cycle and hangs R_DrawAlphaSurfaces.
      if (renderfx & RF_FLARE) {
        // DEVIATION: q2repro draws the flare here as a scaled, RGBA-tinted
        // sprite (ent.scale/ent.rgba, cl_img_flare); EntityT carries neither
        // field yet, so this port takes the same branch's `cl_flares 0`
        // outcome -- the flare is consumed, not drawn -- rather than the
        // world model. Full flare rendering is a follow-up.
        VectorCopy(ent.origin, cent.lerp_origin);
        continue;
      }

      if (renderfx & RF_CUSTOM_LIGHT) {
        // DLIGHT_CUTOFF (q2repro inc/refresh/refresh.h:37) duplicated as a
        // local the same way ref_gl/gl_light.ts and gl_shader.ts each do.
        const DLIGHT_CUTOFF = 64;
        // `color.u32 = BigLong(s1->skinnum)` then color.r/g/b: a big-endian
        // read of the packed value SP_target_light writes as
        // `(b << 8) | (g << 16) | (r << 24)`.
        let r = 1;
        let g = 1;
        let b = 1;
        if (s1.skinnum) {
          r = ((s1.skinnum >>> 24) & 0xff) / 255.0;
          g = ((s1.skinnum >>> 16) & 0xff) / 255.0;
          b = ((s1.skinnum >>> 8) & 0xff) / 255.0;
        }
        V_AddLight(ent.origin, DLIGHT_CUTOFF + s1.frame, r, g, b);
        VectorCopy(ent.origin, cent.lerp_origin);
        continue;
      }
    }

    // tweak the color of beams
    if (renderfx & RF_BEAM) {
      // the four beam colors are encoded in 32 bits of skinnum (hack)
      ent.alpha = 0.3;
      ent.skinnum = (s1.skinnum >> (Math.floor(Math.random() * 4) * 8)) & 0xff;
      ent.model = null;
    } else {
      // set skin
      if (s1.modelindex === 255) {
        // use custom player skin
        ent.skinnum = 0;
        const ci = cl.clientinfo[s1.skinnum & 0xff];
        ent.skin = ci.skin;
        ent.model = ci.model;
        if (!ent.skin || !ent.model) {
          ent.skin = cl.baseclientinfo.skin;
          ent.model = cl.baseclientinfo.model;
        }

        // PGM: RF_USE_DISGUISE reinterprets ent.skin (a char* image name) as
        // a string via strncmp -- undefined behavior against an opaque
        // renderer handle (ImageS = unknown per ref.ts) and unportable as
        // written. Dropped; reported as a deviation.
      } else {
        ent.skinnum = s1.skinnum;
        ent.skin = null;
        ent.model = cl.model_draw[s1.modelindex];
      }
    }

    // only used for black hole model right now, FIXME: do better
    if (renderfx === RF_TRANSLUCENT) ent.alpha = 0.7;

    // render effects (fullbright, translucent, etc)
    if (effects & EF_COLOR_SHELL) ent.flags = 0; // renderfx go on color shell entity
    else ent.flags = renderfx;

    // calculate angles
    if (effects & EF_ROTATE) {
      // some bonus items auto-rotate
      ent.angles[0] = 0;
      ent.angles[1] = autorotate;
      ent.angles[2] = 0;
    } else if (effects & EF_SPINNINGLIGHTS) {
      // RAFAEL
      ent.angles[0] = 0;
      ent.angles[1] = anglemod(cl.time / 2) + s1.angles[1];
      ent.angles[2] = 180;
      {
        const forward: Vec3 = new Float32Array(3);
        const start: Vec3 = new Float32Array(3);
        AngleVectors(ent.angles, forward, null, null);
        VectorMA(ent.origin, 64, forward, start);
        V_AddLight(start, 100, 1, 0, 0);
      }
    } else {
      // interpolate angles
      for (let i = 0; i < 3; i++) {
        const a1 = cent.current.angles[i];
        const a2 = cent.prev.angles[i];
        ent.angles[i] = LerpAngle(a2, a1, cl.lerpfrac);
      }
    }

    if (s1.number === cl.playernum + 1) {
      ent.flags |= RF_VIEWERMODEL; // only draw from mirrors
      // FIXME: still pass to refresh

      if (effects & EF_FLAG1) V_AddLight(ent.origin, 225, 1.0, 0.1, 0.1);
      else if (effects & EF_FLAG2) V_AddLight(ent.origin, 225, 0.1, 0.1, 1.0);
      else if (effects & EF_TAGTRAIL) V_AddLight(ent.origin, 225, 1.0, 1.0, 0.0); // PGM
      else if (effects & EF_TRACKERTRAIL) V_AddLight(ent.origin, 225, -1.0, -1.0, -1.0); // PGM

      continue;
    }

    // if set to invisible, skip
    if (!s1.modelindex) continue;

    if (effects & EF_BFG) {
      ent.flags |= RF_TRANSLUCENT;
      ent.alpha = 0.3;
    }

    // RAFAEL
    if (effects & EF_PLASMA) {
      ent.flags |= RF_TRANSLUCENT;
      ent.alpha = 0.6;
    }

    if (effects & EF_SPHERETRANS) {
      ent.flags |= RF_TRANSLUCENT;
      // PMM - *sigh* yet more EF overloading
      if (effects & EF_TRACKERTRAIL) ent.alpha = 0.6;
      else ent.alpha = 0.3;
    }
    //pmm

    // add to refresh list
    V_AddEntity(ent);

    // color shells generate a seperate entity for the main model
    if (effects & EF_COLOR_SHELL) {
      // PMM - at this point, all of the shells have been handled
      // if we're in the rogue pack, set up the custom mixing, otherwise just
      // keep going
      // all of the solo colors are fine.  we need to catch any of the combinations that look bad
      // (double & half) and turn them into the appropriate color, and make double/quad something special
      if (renderfx & RF_SHELL_HALF_DAM) {
        if (Developer_searchpath(2) === 2) {
          // ditch the half damage shell if any of red, blue, or double are on
          if (renderfx & (RF_SHELL_RED | RF_SHELL_BLUE | RF_SHELL_DOUBLE)) renderfx &= ~RF_SHELL_HALF_DAM;
        }
      }

      if (renderfx & RF_SHELL_DOUBLE) {
        if (Developer_searchpath(2) === 2) {
          // lose the yellow shell if we have a red, blue, or green shell
          if (renderfx & (RF_SHELL_RED | RF_SHELL_BLUE | RF_SHELL_GREEN)) renderfx &= ~RF_SHELL_DOUBLE;
          // if we have a red shell, turn it to purple by adding blue
          if (renderfx & RF_SHELL_RED) renderfx |= RF_SHELL_BLUE;
          // if we have a blue shell (and not a red shell), turn it to cyan by adding green
          else if (renderfx & RF_SHELL_BLUE) {
            // go to green if it's on already, otherwise do cyan (flash green)
            if (renderfx & RF_SHELL_GREEN) renderfx &= ~RF_SHELL_BLUE;
            else renderfx |= RF_SHELL_GREEN;
          }
        }
      }
      // pmm
      ent.flags = renderfx | RF_TRANSLUCENT;
      ent.alpha = 0.3;
      V_AddEntity(ent);
    }

    ent.skin = null; // never use a custom skin on others
    ent.skinnum = 0;
    ent.flags = 0;
    ent.alpha = 0;

    // duplicate for linked models
    if (s1.modelindex2) {
      if (s1.modelindex2 === 255) {
        // custom weapon
        const ci = cl.clientinfo[s1.skinnum & 0xff];
        let i = s1.skinnum >> 8; // 0 is default weapon model
        if (!clCvars.cl_vwep?.value || i > MAX_CLIENTWEAPONMODELS - 1) i = 0;
        ent.model = ci.weaponmodel[i];
        if (!ent.model) {
          if (i !== 0) ent.model = ci.weaponmodel[0];
          if (!ent.model) ent.model = cl.baseclientinfo.weaponmodel[0];
        }
      } else {
        ent.model = cl.model_draw[s1.modelindex2];
      }

      // PMM - check for the defender sphere shell .. make it translucent
      // replaces the previous version which used the high bit on modelindex2 to determine transparency
      if (Q_strcasecmp(cl.configstrings[cls.csr.models + s1.modelindex2] ?? "", "models/items/shell/tris.md2") === 0) {
        ent.alpha = 0.32;
        ent.flags = RF_TRANSLUCENT;
      }
      // pmm

      V_AddEntity(ent);

      //PGM - make sure these get reset.
      ent.flags = 0;
      ent.alpha = 0;
      //PGM
    }
    if (s1.modelindex3) {
      ent.model = cl.model_draw[s1.modelindex3];
      V_AddEntity(ent);
    }
    if (s1.modelindex4) {
      ent.model = cl.model_draw[s1.modelindex4];
      V_AddEntity(ent);
    }

    if (effects & EF_POWERSCREEN) {
      ent.model = cl_mod_powerscreen;
      ent.oldframe = 0;
      ent.frame = 0;
      ent.flags |= RF_TRANSLUCENT | RF_SHELL_GREEN;
      ent.alpha = 0.3;
      V_AddEntity(ent);
    }

    // add automatic particle trails
    if (effects & ~EF_ROTATE) {
      if (effects & EF_ROCKET) {
        CL_RocketTrail(cent.lerp_origin, ent.origin, cent);
        V_AddLight(ent.origin, 200, 1, 1, 0);
      } else if (effects & EF_BLASTER) {
        // PGM - Do not reorder EF_BLASTER and EF_HYPERBLASTER.
        // EF_BLASTER | EF_TRACKER is a special case for EF_BLASTER2... Cheese!
        if (effects & EF_TRACKER) {
          // lame... problematic?
          CL_BlasterTrail2(cent.lerp_origin, ent.origin);
          V_AddLight(ent.origin, 200, 0, 1, 0);
        } else {
          CL_BlasterTrail(cent.lerp_origin, ent.origin);
          V_AddLight(ent.origin, 200, 1, 1, 0);
        }
        //PGM
      } else if (effects & EF_HYPERBLASTER) {
        if (effects & EF_TRACKER)
          V_AddLight(ent.origin, 200, 0, 1, 0); // PGM overloaded for blaster2.
        else V_AddLight(ent.origin, 200, 1, 1, 0); // PGM
      } else if (effects & EF_GIB) {
        CL_DiminishingTrail(cent.lerp_origin, ent.origin, cent, effects);
      } else if (effects & EF_GRENADE) {
        CL_DiminishingTrail(cent.lerp_origin, ent.origin, cent, effects);
      } else if (effects & EF_FLIES) {
        CL_FlyEffect(cent, ent.origin);
      } else if (effects & EF_BFG) {
        const bfg_lightramp = fixedLength("bfg_lightramp", 6, [300, 400, 600, 300, 150, 75]);

        let i: number;
        if (effects & EF_ANIM_ALLFAST) {
          CL_BfgParticles(ent);
          i = 200;
        } else {
          i = bfg_lightramp[s1.frame] ?? 0;
        }
        V_AddLight(ent.origin, i, 0, 1, 0);
      } else if (effects & EF_TRAP) {
        // RAFAEL
        ent.origin[2] += 32;
        CL_TrapParticles(ent);
        const i = Math.floor(Math.random() * 100) + 100;
        V_AddLight(ent.origin, i, 1, 0.8, 0.1);
      } else if (effects & EF_FLAG1) {
        CL_FlagTrail(cent.lerp_origin, ent.origin, 242);
        V_AddLight(ent.origin, 225, 1, 0.1, 0.1);
      } else if (effects & EF_FLAG2) {
        CL_FlagTrail(cent.lerp_origin, ent.origin, 115);
        V_AddLight(ent.origin, 225, 0.1, 0.1, 1);
      } else if (effects & EF_TAGTRAIL) {
        //ROGUE
        CL_TagTrail(cent.lerp_origin, ent.origin, 220);
        V_AddLight(ent.origin, 225, 1.0, 1.0, 0.0);
      } else if (effects & EF_TRACKERTRAIL) {
        if (effects & EF_TRACKER) {
          const intensity = 50 + 500 * (Math.sin(cl.time / 500.0) + 1.0);
          // FIXME - check out this effect in rendition
          if (vidref_val === VIDREF_GL) V_AddLight(ent.origin, intensity, -1.0, -1.0, -1.0);
          else V_AddLight(ent.origin, -1.0 * intensity, 1.0, 1.0, 1.0);
        } else {
          CL_Tracker_Shell(cent.lerp_origin);
          V_AddLight(ent.origin, 155, -1.0, -1.0, -1.0);
        }
      } else if (effects & EF_TRACKER) {
        CL_TrackerTrail(cent.lerp_origin, ent.origin, 0);
        // FIXME - check out this effect in rendition
        if (vidref_val === VIDREF_GL) V_AddLight(ent.origin, 200, -1, -1, -1);
        else V_AddLight(ent.origin, -200, 1, 1, 1);
        //ROGUE
      } else if (effects & EF_GREENGIB) {
        // RAFAEL
        CL_DiminishingTrail(cent.lerp_origin, ent.origin, cent, effects);
      } else if (effects & EF_IONRIPPER) {
        // RAFAEL
        CL_IonripperTrail(cent.lerp_origin, ent.origin);
        V_AddLight(ent.origin, 100, 1, 0.5, 0.5);
      } else if (effects & EF_BLUEHYPERBLASTER) {
        // RAFAEL
        V_AddLight(ent.origin, 200, 0, 0, 1);
      } else if (effects & EF_PLASMA) {
        // RAFAEL
        if (effects & EF_ANIM_ALLFAST) CL_BlasterTrail(cent.lerp_origin, ent.origin);
        V_AddLight(ent.origin, 130, 1, 0.5, 0.5);
      }
    }

    VectorCopy(ent.origin, cent.lerp_origin);
  }
}

/*
==============
CL_AddViewWeapon
==============
*/
// Exported (not just called from CL_CalcViewValues below) so tests can
// drive the view-weapon-plus-muzzle-flash render pass directly, the same
// way cl_tent.ts's CL_AddMuzzleFX is tested directly rather than through
// the full CL_AddEntities pipeline.
export function CL_AddViewWeapon(ps: PlayerStateT, ops: PlayerStateT): void {
  // allow the gun to be completely removed
  if (!clCvars.cl_gun?.value) return;

  // don't draw gun if in wide angle view
  if (ps.fov > 90) return;

  const gun = new EntityT();

  if (gun_model) gun.model = gun_model; // development tool
  else gun.model = cl.model_draw[ps.gunindex];
  if (!gun.model) return;

  // set up gun position
  for (let i = 0; i < 3; i++) {
    gun.origin[i] = cl.refdef.vieworg[i] + ops.gunoffset[i] + cl.lerpfrac * (ps.gunoffset[i] - ops.gunoffset[i]);
    gun.angles[i] = cl.refdef.viewangles[i] + LerpAngle(ops.gunangles[i], ps.gunangles[i], cl.lerpfrac);
  }

  if (gun_frame) {
    gun.frame = gun_frame; // development tool
    gun.oldframe = gun_frame; // development tool
  } else {
    gun.frame = ps.gunframe;
    if (gun.frame === 0) gun.oldframe = 0; // just changed weapons, don't lerp from old
    else gun.oldframe = ops.gunframe;
  }

  gun.flags = RF_MINLIGHT | RF_DEPTHHACK | RF_WEAPONMODEL;
  gun.backlerp = 1.0 - cl.lerpfrac;
  VectorCopy(gun.origin, gun.oldorigin); // don't lerp at all
  V_AddEntity(gun);

  // add muzzle flash (q2repro entities.c:1320-1349). cl.weapon.muzzle is
  // written by CL_AddWeaponMuzzleFX (cl_fx.ts, called from the LOCAL
  // player's own CL_ParseMuzzleFlash branch only) and expires 50ms after
  // being set -- a real short-lived flash MODEL, not the classic dlight.
  if (!cl.weapon.muzzle.model) return;

  if (cl.time - cl.weapon.muzzle.time > 50) {
    cl.weapon.muzzle.model = null;
    return;
  }

  gun.flags = RF_FULLBRIGHT | RF_DEPTHHACK | RF_WEAPONMODEL | RF_TRANSLUCENT;
  gun.alpha = 1.0;
  gun.model = cl.weapon.muzzle.model;
  gun.skinnum = 0;
  // DEVIATION: q2repro's entity_t.scale (VectorSet(gun.scale, muzzle.scale,
  // muzzle.scale, muzzle.scale)) has no field on this port's EntityT
  // (ref.ts) -- same cut cl_tent.ts's CL_AddMuzzleFX already documents for
  // the world-entity flash model (ref_gl/ isn't ported, PORTING.md).
  // cl.weapon.muzzle.scale is still carried on client state for a future
  // renderer to consume.
  gun.backlerp = 0.0;
  gun.frame = gun.oldframe = 0;

  const forward: Vec3 = new Float32Array(3);
  const right: Vec3 = new Float32Array(3);
  const up: Vec3 = new Float32Array(3);
  AngleVectors(gun.angles, forward, right, up);

  VectorMA(gun.origin, cl.weapon.muzzle.offset[0], forward, gun.origin);
  VectorMA(gun.origin, cl.weapon.muzzle.offset[1], right, gun.origin);
  VectorMA(gun.origin, cl.weapon.muzzle.offset[2], up, gun.origin);

  VectorCopy(cl.refdef.viewangles, gun.angles);
  gun.angles[2] += cl.weapon.muzzle.roll;

  V_AddEntity(gun);
}

/*
===============
CL_CalcViewValues

Sets cl.refdef view values
===============
*/
function CL_CalcViewValues(): void {
  // find the previous frame to interpolate from
  const ps = cl.frame.playerstate;
  const i = (cl.frame.serverframe - 1) & UPDATE_MASK;
  let oldframe = cl.frames[i];
  if (oldframe.serverframe !== cl.frame.serverframe - 1 || !oldframe.valid) oldframe = cl.frame; // previous frame was dropped or invalid
  let ops = oldframe.playerstate;

  // see if the player entity was teleported this frame
  if (
    Math.abs(ops.pmove.origin[0] - ps.pmove.origin[0]) > 256 * 8 ||
    absInt(ops.pmove.origin[1] - ps.pmove.origin[1]) > 256 * 8 ||
    absInt(ops.pmove.origin[2] - ps.pmove.origin[2]) > 256 * 8
  )
    ops = ps; // don't interpolate

  const lerp = cl.lerpfrac;

  // calculate the origin
  if (clCvars.cl_predict?.value && !(cl.frame.playerstate.pmove.pm_flags & PMF_NO_PREDICTION)) {
    // use predicted values
    const backlerp = 1.0 - lerp;
    for (let i2 = 0; i2 < 3; i2++) {
      cl.refdef.vieworg[i2] = cl.predicted_origin[i2] + ops.viewoffset[i2] + cl.lerpfrac * (ps.viewoffset[i2] - ops.viewoffset[i2]) - backlerp * cl.prediction_error[i2];
    }

    // smooth out stair climbing
    const delta = cls.realtime - cl.predicted_step_time;
    if (delta < 100) cl.refdef.vieworg[2] -= cl.predicted_step * (100 - delta) * 0.01;
  } else {
    // just use interpolated values
    for (let i2 = 0; i2 < 3; i2++)
      cl.refdef.vieworg[i2] =
        ops.pmove.origin[i2] * 0.125 + ops.viewoffset[i2] + lerp * (ps.pmove.origin[i2] * 0.125 + ps.viewoffset[i2] - (ops.pmove.origin[i2] * 0.125 + ops.viewoffset[i2]));
  }

  // [Paril-KEX] re-release eye height. Vanilla folds eye height into
  // `viewoffset` (already added above); the re-release deliberately does not
  // -- q2repro's server/entities.c:610-612 states it outright ("Rerelease
  // game doesn't include viewheight in viewoffset, vanilla does") -- and
  // ships it as ps.pmove.viewheight instead, which the client adds here.
  // q2repro client/entities.c:1528-1536 records the change, :1605-1609
  // eases it: `viewheight_lerp = 100 - min(cl.time - change_time, 100);
  // viewheight = current + (prev - current) * viewheight_lerp * 0.01;
  // cl.refdef.vieworg[2] += viewheight;`. Vanilla-family servers leave
  // pmove.viewheight at 0, so this whole block is a no-op there.
  if (cl.current_viewheight !== ps.pmove.viewheight) {
    cl.prev_viewheight = cl.current_viewheight;
    cl.current_viewheight = ps.pmove.viewheight;
    cl.viewheight_change_time = cl.time;
  }
  {
    let viewheight_lerp = cl.time - cl.viewheight_change_time;
    viewheight_lerp = 100 - Math.min(viewheight_lerp, 100);
    cl.refdef.vieworg[2] += cl.current_viewheight + (cl.prev_viewheight - cl.current_viewheight) * viewheight_lerp * 0.01;
  }

  // if not running a demo or on a locked frame, add the local angle movement.
  // The C source's test is `pm_type < PM_DEAD`; PM_TypeIsAlive (q_shared.ts)
  // is that same test written as an explicit membership check, because the
  // engine's PmTypeT appends PM_GRAPPLE/PM_NOCLIP at 5/6 rather than
  // interleaving them the way the kex enum does. Identical result for every
  // classic-family value.
  if (PM_TypeIsAlive(cl.frame.playerstate.pmove.pm_type)) {
    // use predicted values
    for (let i2 = 0; i2 < 3; i2++) cl.refdef.viewangles[i2] = cl.predicted_angles[i2];
  } else {
    // just use interpolated values
    for (let i2 = 0; i2 < 3; i2++) cl.refdef.viewangles[i2] = LerpAngle(ops.viewangles[i2], ps.viewangles[i2], lerp);
  }

  for (let i2 = 0; i2 < 3; i2++) cl.refdef.viewangles[i2] += LerpAngle(ops.kick_angles[i2], ps.kick_angles[i2], lerp);

  AngleVectors(cl.refdef.viewangles, cl.v_forward, cl.v_right, cl.v_up);

  // interpolate field of view
  cl.refdef.fov_x = ops.fov + lerp * (ps.fov - ops.fov);

  // don't interpolate blend color
  for (let i2 = 0; i2 < 4; i2++) cl.refdef.blend[i2] = ps.blend[i2];

  // add the weapon
  CL_AddViewWeapon(ps, ops);
}

/*
===============
CL_AddEntities

Emits all entities, particles, and lights to the refresh
===============
*/
export function CL_AddEntities(): void {
  if (cls.state !== ConnstateT.ca_active) return;

  const frameTimeMs = CL_FrameTimeMs();
  if (cl.time > cl.frame.servertime) {
    if (clCvars.cl_showclamp?.value) Com_Printf("high clamp %i\n", cl.time - cl.frame.servertime);
    cl.time = cl.frame.servertime;
    cl.lerpfrac = 1.0;
  } else if (cl.time < cl.frame.servertime - frameTimeMs) {
    if (clCvars.cl_showclamp?.value) Com_Printf("low clamp %i\n", cl.frame.servertime - frameTimeMs - cl.time);
    cl.time = cl.frame.servertime - frameTimeMs;
    cl.lerpfrac = 0;
  } else {
    cl.lerpfrac = 1.0 - (cl.frame.servertime - cl.time) / frameTimeMs;
  }

  if (clCvars.cl_timedemo?.value) cl.lerpfrac = 1.0;

  CL_CalcViewValues();
  // PMM - moved this here so the heat beam has the right values for the vieworg, and can lock the beam to the gun
  CL_AddPacketEntities(cl.frame);
  CL_AddTEnts();
  CL_AddParticles();
  CL_AddDLights();
  CL_AddLightStyles();
}

/*
===============
CL_GetEntitySoundOrigin

Called to get the sound spatialization origin
===============
*/
export function CL_GetEntitySoundOrigin(ent: number, org: Vec3): void {
  // q2repro entities.c:1650 `if (entnum >= cl.csr.max_edicts)` -- family-active bound.
  if (ent < 0 || ent >= cls.csr.max_edicts) {
    Com_Error(ERR_DROP, "CL_GetEntitySoundOrigin: bad ent");
  }
  const old = cl_entities[ent];
  VectorCopy(old.lerp_origin, org);

  // FIXME: bmodel issues...
}
