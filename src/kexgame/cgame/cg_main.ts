// cg_main.cpp (2023 Quake II re-release / "KEX" engine, 124 lines) + the
// cgame half of cg_local.h (13 lines -- see ./cg_local.ts for the shared
// `cgi` state that header declares `extern`). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/cg_main.cpp.
//
// This is GetCGameAPI's assembly: it builds and returns a KexCgameExports
// table (`cglobals` in the C source), wires the weapon-wheel/hit-marker
// stat-read functions, forwards Pmove to the shared movement code
// (p_move.ts, exactly like g_main.ts's own GetGameAPI does for the game
// side), forwards configstring-driven pm_config updates, and forwards
// monster muzzle-flash offset lookups to m_flash.ts's table.
//
// Every function taking `const player_state_t *ps` in the C++ dereferences
// it unconditionally with no null check; ported per this codebase's
// established "throw explicitly instead of segfaulting implicitly"
// precedent (see g_main.ts's own Pmove wrapper: "the C++ source
// dereferences it unconditionally here").
//
// pm_config (bg_local.ts's PmConfigT) is NOT a module-global read directly
// by Pmove -- see bg_local.ts's own file header and g_main.ts's identical
// precedent on the game side ("this file -- the natural owner of 'the state
// g_main's init code assigns a cvar into' -- keeps a small local mutable
// pmConfig"). This file is the cgame-side owner of that same pattern:
// InitCGame/ParseConfigString update a local `pmConfig`, threaded through
// the Pmove export wrapper exactly like g_main.ts threads its own copy
// through GetGameAPI's Pmove wrapper.
//
// CONFIG_N64_PHYSICS is recomputed locally from the same bg_local.h
// offset chain g_target.ts/g_spawn.ts already duplicate for the identical
// reason (no shared/exported home for bg_local.h's reserved-CS-range
// anonymous enum yet); see g_target.ts's file header for the full citation.

import type { KexCgameImports, KexCgameExports, KexPlayerStateT, KexPmoveT, MonsterMuzzleflashIdT } from "../../kexapi/game";
import { CS_AIRACCEL, CS_GENERAL, MAX_CLIENTS, CGAME_API_VERSION as KEX_CGAME_API_VERSION_2022 } from "../../kexapi/game";
import type { Vec3 } from "../../shared/math";
import { PlayerStatT, G_GetAmmoStat, G_GetPowerupStat, AMMO_VALUE_INFINITE, STAT_POWERUP_INFO_START } from "../p_hud";
import { PM_CONFIG_DEFAULT, type PmConfigT } from "../bg_local";
import { Pmove } from "../p_move";
import { monsterFlashOffset } from "../m_flash";
import { CGI, setCgi, setCgameInitTime } from "./cg_local";
import { CG_InitScreen, CG_DrawHUD, CG_TouchPics, CG_LayoutFlags, CG_ParseCenterPrint, CG_ClearNotify, CG_ClearCenterprint, CG_NotifyMessage } from "./cg_screen";

function atoi(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

function requirePs(ps: KexPlayerStateT | null, fn: string): KexPlayerStateT {
  if (ps === null) throw new Error(`${fn}: called with a null player_state_t -- the C++ source dereferences it unconditionally here`);
  return ps;
}

// ---------------------------------------------------------------------------
// bg_local.h reserved-CS-range offset chain -- see file header.
// ---------------------------------------------------------------------------
const CONFIG_CTF_PLAYER_NAME_END = CS_GENERAL + 2 + MAX_CLIENTS;
const COOP_RESPAWN_TOTAL = 6;
const CONFIG_COOP_RESPAWN_STRING_END = CONFIG_CTF_PLAYER_NAME_END + 1 + (COOP_RESPAWN_TOTAL - 1);
const CONFIG_N64_PHYSICS = CONFIG_COOP_RESPAWN_STRING_END + 1;

// ---------------------------------------------------------------------------
// module state (cg_main.cpp:7-8, 17: `cgame_import_t cgi; cgame_export_t
// cglobals; uint64_t cgame_init_time = 0;`)
// ---------------------------------------------------------------------------

let pmConfig: PmConfigT = PM_CONFIG_DEFAULT;

// ---------------------------------------------------------------------------
// InitCGame / ShutdownCGame (cg_main.cpp:19-31)
// ---------------------------------------------------------------------------

function InitCGame(): void {
  CG_InitScreen();

  setCgameInitTime(CGI().CL_ClientRealTime());

  pmConfig = {
    n64_physics: atoi(CGI().get_configstring(CONFIG_N64_PHYSICS)) !== 0,
    airaccel: atoi(CGI().get_configstring(CS_AIRACCEL)),
  };
}

function ShutdownCGame(): void {
  // cg_main.cpp:29-31: empty body.
}

// ---------------------------------------------------------------------------
// weapon-wheel / hit-marker stat reads (cg_main.cpp:37-65)
// ---------------------------------------------------------------------------

function GetActiveWeaponWheelWeapon(psIn: KexPlayerStateT | null): number {
  const ps = requirePs(psIn, "GetActiveWeaponWheelWeapon");
  return ps.stats[PlayerStatT.STAT_ACTIVE_WHEEL_WEAPON];
}

function GetOwnedWeaponWheelWeapons(psIn: KexPlayerStateT | null): number {
  const ps = requirePs(psIn, "GetOwnedWeaponWheelWeapons");
  // C: `((uint32_t)(uint16_t)stats[W1]) | ((uint32_t)(uint16_t)stats[W2] << 16)`
  const w1 = ps.stats[PlayerStatT.STAT_WEAPONS_OWNED_1] & 0xffff;
  const w2 = ps.stats[PlayerStatT.STAT_WEAPONS_OWNED_2] & 0xffff;
  return (w1 | (w2 << 16)) >>> 0;
}

function GetWeaponWheelAmmoCount(psIn: KexPlayerStateT | null, ammo_id: number): number {
  const ps = requirePs(psIn, "GetWeaponWheelAmmoCount");
  const ammo = G_GetAmmoStat(ps.stats, PlayerStatT.STAT_AMMO_INFO_START, ammo_id);
  if (ammo === AMMO_VALUE_INFINITE) return -1;
  return ammo;
}

function GetPowerupWheelCount(psIn: KexPlayerStateT | null, powerup_id: number): number {
  const ps = requirePs(psIn, "GetPowerupWheelCount");
  return G_GetPowerupStat(ps.stats, STAT_POWERUP_INFO_START, powerup_id);
}

function GetHitMarkerDamage(psIn: KexPlayerStateT | null): number {
  const ps = requirePs(psIn, "GetHitMarkerDamage");
  return ps.stats[PlayerStatT.STAT_HIT_MARKER];
}

// ---------------------------------------------------------------------------
// ParseConfigString (cg_main.cpp:67-73)
// ---------------------------------------------------------------------------

function ParseConfigString(i: number, s: string): void {
  if (i === CONFIG_N64_PHYSICS) {
    pmConfig = { ...pmConfig, n64_physics: atoi(s) !== 0 };
  } else if (i === CS_AIRACCEL) {
    pmConfig = { ...pmConfig, airaccel: atoi(s) };
  }
}

// ---------------------------------------------------------------------------
// GetMonsterFlashOffset (cg_main.cpp:80-86)
// ---------------------------------------------------------------------------

function GetMonsterFlashOffset(id: MonsterMuzzleflashIdT, offset: Vec3): void {
  const table = monsterFlashOffset();
  if (id >= table.length) CGI().Com_Error("Bad muzzle flash offset");
  const src = table[id];
  offset[0] = src[0];
  offset[1] = src[1];
  offset[2] = src[2];
}

// ---------------------------------------------------------------------------
// GetCGameAPI (cg_main.cpp:96-124)
// ---------------------------------------------------------------------------

export function GetCGameAPI(imports: KexCgameImports): KexCgameExports {
  setCgi(imports);

  return {
    apiversion: KEX_CGAME_API_VERSION_2022,

    Init: InitCGame,
    Shutdown: ShutdownCGame,

    DrawHUD: CG_DrawHUD,
    TouchPics: CG_TouchPics,
    LayoutFlags: CG_LayoutFlags,

    GetActiveWeaponWheelWeapon,
    GetOwnedWeaponWheelWeapons,
    GetWeaponWheelAmmoCount,
    GetPowerupWheelCount,
    GetHitMarkerDamage,

    Pmove: (pmove: KexPmoveT | null): void => {
      if (pmove === null) throw new Error("Pmove: called with a null pmove -- the C++ source dereferences it unconditionally here");
      Pmove(pmove, pmConfig);
    },

    ParseConfigString,
    ParseCenterPrint: CG_ParseCenterPrint,
    ClearNotify: CG_ClearNotify,
    ClearCenterprint: CG_ClearCenterprint,
    NotifyMessage: CG_NotifyMessage,
    GetMonsterFlashOffset,

    // cg_main.cpp:10-13: `static void *CG_GetExtension(const char *name) {
    // return nullptr; }` -- always null, verbatim.
    GetExtension(_name: string): unknown {
      return null;
    },
  };
}
