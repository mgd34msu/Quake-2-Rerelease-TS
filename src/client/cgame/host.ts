// cgame host -- ARCHITECTURE.md phase 4 ("Client: cgame host, two built-in
// cgames"). Step 1 of that phase: introduce the seam and exercise it,
// WITHOUT extracting the ~8k lines of cl_scrn/cl_tent/cl_fx/cl_newfx/cl_inv
// that will eventually live behind it. Precedent: q2repro's
// src/client/cgame.c (the host) and src/client/cgame_classic.c (the
// built-in classic cgame), both GPLv2.
//
// CgameImports below is the 2022/2023 cgame import surface verbatim
// (KexCgameImports, src/kexapi/game.ts) -- reused as-is rather than
// trimmed, because every future cgame implementation (including the
// phase 6 kex cgame port) needs the full surface, not a subset invented
// for this step. Only the members the classic cgame's pass-through
// DrawHUD path touches today are wired to real client/engine functions
// in buildCgameImports() below; every other member is a stub, each
// commented with the phase expected to give it a real body.
//
// CgameExports is intentionally NOT the full KexCgameExports -- this step's
// classic cgame is a bare pass-through (Init/Shutdown no-ops, DrawHUD
// delegating to the existing SCR_DrawStats/SCR_DrawLayout functions in
// cl_scrn.ts), so only the members actually exercised are declared. It
// grows toward KexCgameExports's full shape (isplit/data/hud_vrect/
// hud_safe/scale/playernum/ps parameters on DrawHUD, the weapon-wheel/
// centerprint/notify members, etc.) once the kex cgame (phase 6) needs
// them.

import { cl, cls, re } from "../client";
import { Com_Printf, Com_Error as Engine_Com_Error } from "../../qcommon/common";
import { ERR_DROP } from "../../qcommon/qcommon";
import { Cvar_Get, Cvar_Set, Cvar_ForceSet } from "../../qcommon/cvar";
import type { KexCgameImports } from "../../kexapi/game";
import { GetClassicCgameAPI } from "./classic";
import { GetCGameAPI as GetKexCgameAPI } from "../../kexgame/cgame/cg_main";

// ---------------------------------------------------------------------------
// Import table (engine -> cgame)
// ---------------------------------------------------------------------------

export type CgameImports = KexCgameImports;

// The classic engine's game logic has always run at a fixed 10Hz tick (see
// server.ts's ServerT.framerate/frametime, which documents the identical
// "fixed until ARCHITECTURE.md phase 3's tick-rate binding lands" state on
// the server side). tick_rate/frame_time_s/frame_time_ms mirror Kex's
// cgame_import_t, which sets these once from the CL_FRAMETIME constant --
// they are the *logic* tick duration, not the variable per-frame render
// delta (that is CL_FrameTime() below, wired to the real cls.frametime).
const CGAME_TICK_RATE_HZ = 10;
const CGAME_TICK_MS = 1000 / CGAME_TICK_RATE_HZ;
const CGAME_TICK_S = CGAME_TICK_MS * 0.001;

function boundsCheckedConfigstring(num: number): string {
  if (num < 0 || num >= cl.configstrings.length) {
    Engine_Com_Error(ERR_DROP, "get_configstring: bad index: %d", num);
  }
  return cl.configstrings[num];
}

function boundsCheckedClientName(index: number): string {
  if (index < 0 || index >= cl.clientinfo.length) {
    Engine_Com_Error(ERR_DROP, "CL_GetClientName: invalid client index");
  }
  return cl.clientinfo[index].name;
}

export function buildCgameImports(): CgameImports {
  return {
    // ---- tick fields (implemented: fixed logic-tick constants; see comment above) ----
    tick_rate: CGAME_TICK_RATE_HZ,
    frame_time_s: CGAME_TICK_S,
    frame_time_ms: CGAME_TICK_MS,

    // ---- implemented: wired to real engine functions ----
    Com_Print(msg: string): void {
      Com_Printf("%s", msg);
    },

    get_configstring: boundsCheckedConfigstring,

    Com_Error(message: string): never {
      Engine_Com_Error(ERR_DROP, "%s", message);
    },

    cvar(var_name, value, flags) {
      return Cvar_Get(var_name, value, flags);
    },
    cvar_set(var_name, value) {
      return Cvar_Set(var_name, value);
    },
    cvar_forceset(var_name, value) {
      return Cvar_ForceSet(var_name, value);
    },

    CL_FrameTime(): number {
      return cls.frametime;
    },
    CL_ClientTime(): number {
      return cl.time;
    },
    CL_ServerFrame(): number {
      return cl.frame.serverframe;
    },
    CL_GetClientName: boundsCheckedClientName,

    SCR_DrawChar(x, y, _scale, num, _shadow) {
      // TODO(phase 6, kex cgame): KexCgameImports.SCR_DrawChar carries a
      // scale + drop-shadow flag; ref.ts's RefExports.DrawChar (the only
      // char-drawing primitive our unconstructed-renderer port has) takes
      // just x/y/char (see ref.ts -- ref_gl/ is not ported per PORTING.md).
      // Scale and shadow are dropped here; wire once scaled/kfont-aware
      // char drawing lands with the kex module.
      if (!re) return;
      re.DrawChar(x, y, num);
    },
    SCR_DrawPic(x, y, w, h, name) {
      if (!re) return;
      re.DrawStretchPic(x, y, w, h, name);
    },

    // ---- stubs: no current caller needs these; each names its phase ----

    // TS is garbage-collected -- the Z_Tag allocator concept this trio
    // ports has no client-side counterpart. Kept only for KexCgameImports
    // shape parity; not expected to ever gain a real body.
    TagMalloc(_size, _tag) {
      return null;
    },
    TagFree(_block) {
      // no-op: see TagMalloc comment above.
    },
    FreeTags(_tag) {
      // no-op: see TagMalloc comment above.
    },

    // TODO(phase 6, kex cgame): wire to the command buffer once a cgame
    // needs to inject console commands (menu actions, etc). The classic
    // cgame's pass-through DrawHUD never calls this.
    AddCommandString(_text) {
      // no-op
    },

    // TODO(phase 5, protocol layer): q2pro's extended-support query
    // mechanism (cgame_q2pro_extended_support_ext_t) has no counterpart
    // here yet. Unused by the classic cgame.
    GetExtension(_name) {
      return null;
    },

    // TODO(phase 4 continuation): real once the classic cgame's DrawHUD
    // stops being a bare pass-through and needs to skip stale frames
    // itself instead of relying on cl_scrn.ts's own guards.
    CL_FrameValid() {
      return true;
    },

    // TODO(phase 3, variable tick + framediv): wall-clock plumbing
    // (com_localTime equivalent) is not wired client-side yet.
    CL_ClientRealTime() {
      return 0;
    },

    // TODO(phase 5, protocol layer): "which protocol are we speaking" is
    // owned by the codec abstraction, not this step's bare seam.
    CL_ServerProtocol() {
      return 0;
    },

    // TODO(phase 6, kex cgame): client icon assets are a kex HUD concept;
    // the classic HUD path (cl_scrn.ts) reads cl.clientinfo directly today.
    CL_GetClientPic(_index) {
      return "";
    },
    // TODO(phase 6, kex cgame): dogtags are a kex-only concept, absent from
    // classic Q2's ClientinfoT.
    CL_GetClientDogtag(_index) {
      return "";
    },
    // TODO(phase 6, kex cgame): key-bind display is not used by the
    // classic HUD/layout-string interpreter.
    CL_GetKeyBinding(_binding) {
      return "";
    },

    // TODO(phase 4 continuation): once cl_scrn.ts's pic registration
    // (SCR_TouchPics et al) moves behind this interface instead of calling
    // re.RegisterPic/re.DrawGetPicSize directly.
    Draw_RegisterPic(_name) {
      return false;
    },
    Draw_GetPicSize(w, h, _name) {
      w[0] = 0;
      h[0] = 0;
    },

    // TODO(phase 6, kex cgame / ref color-tint support): RefExports (ref.ts)
    // has no colored/tinted pic-draw primitive yet -- only DrawPic/
    // DrawStretchPic, which are uncolored. Wire once one exists.
    SCR_DrawColorPic(_x, _y, _w, _h, _name, _color) {
      // no-op
    },

    // TODO(phase 7, KEX subsystems: localization/kfont). The classic HUD
    // never used a kfont; these four are purely a kex-cgame concept.
    SCR_SetAltTypeface(_enabled) {
      // no-op
    },
    SCR_DrawFontString(_str, _x, _y, _scale, _color, _shadow, _align) {
      // no-op
    },
    SCR_MeasureFontString(_str, _scale) {
      return { x: 0, y: 0 };
    },
    SCR_FontLineHeight(_scale) {
      return 0;
    },

    // Matches q2repro's own CG_CL_GetTextInput, which is a `// FIXME: Hook
    // up with chat prompt` stub upstream too -- not a gap introduced here.
    CL_GetTextInput(_msg, _is_team) {
      return false;
    },

    // TODO(phase 6, kex cgame): weapon-wheel ammo warning thresholds.
    CL_GetWarnAmmoCount(_weapon_id) {
      return 0;
    },

    // TODO(phase 7, KEX subsystems: localization). No loc.c port exists
    // yet; returns the base string unlocalized rather than faking a
    // translation.
    Localize(base, _args, _num_args) {
      return base;
    },

    // TODO(phase 7, KEX subsystems: localization/kfont). Key-bind display
    // for centerprints; unused by the classic layout-string interpreter.
    SCR_DrawBind(_isplit, _binding, _purpose, _x, _y, _scale) {
      return 0;
    },

    // Matches q2repro's own CG_CL_InAutoDemoLoop, which is a `// FIXME:
    // implement` stub upstream too -- not a gap introduced here.
    CL_InAutoDemoLoop() {
      return false;
    },
  };
}

// ---------------------------------------------------------------------------
// Exports table (cgame -> engine) -- minimal shape for this step
// ---------------------------------------------------------------------------

// Not KexCgameExports: this step's classic cgame is a bare pass-through,
// so only Init/Shutdown/DrawHUD exist. DrawHUD takes no parameters yet --
// it grows to KexCgameExports.DrawHUD's full signature (isplit, data,
// hud_vrect, hud_safe, scale, playernum, ps) in phase 6 when the kex cgame
// needs them and the classic cgame's internals actually move behind this
// interface.
export interface CgameExports {
  apiversion: number;
  Init(): void;
  Shutdown(): void;
  DrawHUD(): void;
}

// Own versioning for this minimal seam -- not yet KexCgameExports.apiversion
// (which is part of the full 2023 rerelease cgame API). Bumped only when
// this interface's shape changes; superseded once phase 6 raises it toward
// parity with the kex API.
export const CGAME_API_VERSION = 1;

// ---------------------------------------------------------------------------
// Kex cgame adapter -- ARCHITECTURE.md phase 6 ("Kex game module port ...
// then the kex cgame"). DIFF vs. the phase-4-step-1 shape documented at the
// top of this file: this is the first thing to register a SECOND built-in
// cgame with the host.
// ---------------------------------------------------------------------------
//
// src/kexgame/cgame/cg_main.ts's GetCGameAPI returns the full KexCgameExports
// shape (DrawHUD(isplit, data, hud_vrect, hud_safe, scale, playernum, ps),
// plus the weapon-wheel/centerprint/notify/Pmove members) -- richer than
// this file's own minimal CgameExports (DrawHUD(): void, no parameters).
// Registering the kex cgame in ensureActiveCgame()'s registry alongside
// GetClassicCgameAPI means adapting that richer shape down to CgameExports's
// narrower one; this function is that adapter.
//
// DrawHUD is the one member the adapter cannot make real yet: KexPlayerStateT
// (64 stats, weapon-wheel/coop-respawn/hit-marker fields) and the classic
// PlayerStateT that `cl.frame.playerstate` actually holds are DIFFERENT
// TYPES with no conversion function anywhere in this port line -- that
// conversion is protocol-layer work (ARCHITECTURE.md phase 5; see
// buildCgameImports()'s own CL_ServerProtocol/CL_FrameValid stubs above,
// which are TODO'd to the identical phase for the identical reason).
// Fabricating a placeholder KexPlayerStateT out of the classic one would
// silently draw a WRONG hud rather than no hud, so this adapter's DrawHUD is
// a documented no-op instead -- degrades visually, does not crash. Init/
// Shutdown/apiversion need none of that missing state and are wired for
// real. This is exactly the "kex cgame becomes active only when the kex
// binding drives the client, future wiring" boundary from this unit's brief.
function GetKexCgameAsClassicShape(imports: CgameImports): CgameExports {
  const kex = GetKexCgameAPI(imports);
  return {
    // This seam's own minimal-shape versioning (see CGAME_API_VERSION's own
    // doc comment below), NOT kex's real apiversion (KexCgameExports.apiversion
    // is 2022, kexapi/game.ts's CGAME_API_VERSION) -- the adapter is still
    // fulfilling the CgameExports CONTRACT, not exposing the richer kex API
    // surface through this narrow shape.
    apiversion: CGAME_API_VERSION,
    Init: kex.Init,
    Shutdown: kex.Shutdown,
    DrawHUD() {
      // TODO(phase 5, protocol layer): no KexPlayerStateT / CgServerDataT /
      // per-split hud_vrect/hud_safe/scale/playernum is derivable from the
      // classic client state yet -- see comment above. Intentionally not
      // wired; kex's real CG_DrawHUD (src/kexgame/cgame/cg_screen.ts) is
      // fully implemented and unit-tested (test/kexgame_cgame.test.ts), it
      // just has nothing valid to call it with here yet.
    },
  };
}

// ---------------------------------------------------------------------------
// Active cgame registry
// ---------------------------------------------------------------------------

/** Which built-in cgame ensureActiveCgame() constructs. Defaults to
 *  "classic": nothing in today's client wiring ever calls
 *  CG_SetActiveCgameKind, so this seam's mere existence does not change any
 *  current behavior. */
export type CgameKind = "classic" | "kex";

const cgameFactories: Record<CgameKind, (imports: CgameImports) => CgameExports> = {
  classic: GetClassicCgameAPI,
  kex: GetKexCgameAsClassicShape,
};

let activeCgameKind: CgameKind = "classic";
let activeCgame: CgameExports | null = null;

// Lazy singleton rather than an eager module-scope construction: host.ts,
// classic.ts and cl_scrn.ts form an import cycle (host builds classic,
// classic calls back into cl_scrn.ts's SCR_DrawStats/SCR_DrawLayout,
// cl_scrn.ts calls CG_DrawHUD). Every one of those references is only
// dereferenced from inside a function body, never at module-top-level, so
// the cycle is safe under ESM live bindings -- but building the classic
// cgame this way (on first actual use) sidesteps having to reason about
// module-initialization order at all.
function ensureActiveCgame(): CgameExports {
  if (!activeCgame) {
    activeCgame = cgameFactories[activeCgameKind](buildCgameImports());
    activeCgame.Init();
  }
  return activeCgame;
}

// Exposed for tests and for the eventual cgame-switching logic (rerelease
// server -> kex cgame, classic/legacy server -> classic cgame; see
// q2repro's CG_Load for the precedent this will follow).
export function CG_GetActiveCgame(): CgameExports {
  return ensureActiveCgame();
}

export function CG_SetActiveCgame(cgame: CgameExports): void {
  activeCgame = cgame;
}

// Selection seam: picks which of the two registered factories
// ensureActiveCgame() builds NEXT time it needs to (i.e. after this call, or
// before the first-ever draw). This is the "registry + setActiveCgame"
// extension point the task brief asked for -- q2repro's CG_Load (deciding
// classic vs. kex from the connected server's declared ruleset) is the real
// caller this seam is waiting on; nothing calls it yet, so default behavior
// is unchanged.
export function CG_SetActiveCgameKind(kind: CgameKind): void {
  activeCgameKind = kind;
  activeCgame = null; // force ensureActiveCgame() to rebuild under the new kind
}

export function CG_GetActiveCgameKind(): CgameKind {
  return activeCgameKind;
}

// The single entry point cl_scrn.ts's SCR_UpdateScreen calls in place of
// its former direct SCR_DrawStats()/SCR_DrawLayout() calls.
export function CG_DrawHUD(): void {
  ensureActiveCgame().DrawHUD();
}
