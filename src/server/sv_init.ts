// sv_init.c

import { SysError, SvcOpsT, PORT_MASTER, UPDATE_BACKUP, PROTOCOL_VERSION_RERELEASE_CLASSIC, PROTOCOL_VERSION_Q2PRO } from "../qcommon/qcommon";
import { CS_REMAP_OLD, CS_REMAP_RERELEASE, remapLegacyConfigstringIndex } from "../shared/cs_remap";
import { Q2REPRO_CLASSIC_CODEC } from "../qcommon/protocol/q2repro";
import { CM_LoadMap, CM_InlineModel, CM_NumInlineModels, CM_EntityString } from "../qcommon/cmodel";
import { Cvar_Set, Cvar_FullSet, Cvar_VariableValue, Cvar_GetLatchedVars } from "../qcommon/cvar";
import { CL_DropHook, SCR_BeginLoadingPlaqueHook, Com_Printf, Com_DPrintf, Com_Error, Com_SetServerState, Com_SetServerConnectProtocol, dedicated } from "../qcommon/common";
import { FS_FOpenFile, FS_FCloseFile } from "../qcommon/files";
import { NET_Config, NET_StringToAdr } from "../platform/net_udp";
import { Cbuf_CopyToDefer } from "../qcommon/cmd";
import { SZ_Clear, SZ_Init, MSG_WriteChar, MSG_WriteShort, MSG_WriteString } from "../qcommon/sizebuf";
import {
  Com_sprintf,
  ERR_DROP,
  MAX_CLIENTS,
  CS_NAME,
  MulticastT,
  CVAR_SERVERINFO,
  CVAR_LATCH,
  CVAR_NOSET,
  EntityStateT,
  UsercmdT,
  Q_stricmp,
} from "../shared/q_shared";
import { vec3_origin, VectorCopy } from "../shared/math";
import { cloneEntityState } from "../shared/state_copy";
import type { GameExports } from "../game/game";
import { sv, svs, master_adr, ServerStateT, ClientStateT, ClientT, ServerEntityT, SV_MaxModels, SV_MaxEdicts, sv_airaccelerate, sv_noreload, maxclients, sv_tick_rate } from "./server";
import { SV_Shutdown } from "./sv_main";
import { SV_Multicast, SV_BroadcastCommand, SV_SendClientMessages } from "./sv_send";
import { geHolder, SV_InitGameProgs, currentGameFamily, SV_RunGamePostFrameHook } from "./sv_game";
import { SV_ReadLevelFile } from "./sv_ccmds";
import { SV_ClearWorld } from "./sv_world";
import { SetPmAirAccelerate } from "../qcommon/pmove";
import { Nav_Load, Nav_Unload, Nav_LegacyLoadEnabled } from "./nav";
import { SV_MvdMapChanged } from "./sv_mvd";

function requireGe(): GameExports {
  const ge = geHolder.ge;
  if (!ge) throw new SysError("sv_init: ge used before SV_InitGameProgs");
  return ge;
}

/*
================
SV_FindIndex

================
*/
export function SV_FindIndex(name: string, start: number, max: number, create: boolean, reportOverflow = true): number {
  if (!name || !name.length) return 0;

  let i = 1;
  for (; i < max && sv.configstrings[start + i].length; i++) {
    if (sv.configstrings[start + i] === name) return i;
  }

  if (!create) return 0;

  if (i === max) {
    // `reportOverflow = false` is the widening path's probe (see
    // SV_FindIndexWidening below): the caller wants to know the block is full
    // so it can try to widen the session and retry, not to kill the server.
    // Every pre-existing caller leaves the default true and gets the original
    // Com_Error verbatim.
    if (!reportOverflow) return -1;
    Com_Error(ERR_DROP, "*Index: overflow");
  }

  sv.configstrings[start + i] = name;

  if (sv.state !== ServerStateT.ss_loading) {
    // send the update to everyone
    SZ_Clear(sv.multicast);
    MSG_WriteChar(sv.multicast, SvcOpsT.svc_configstring);
    MSG_WriteShort(sv.multicast, start + i);
    MSG_WriteString(sv.multicast, name);
    SV_Multicast(vec3_origin, MulticastT.MULTICAST_ALL_R);
  }

  return i;
}

/*
================
SV_WidenConfigstringSpace

Move this session from the classic configstring layout (CS_REMAP_OLD: 256
models, 256 sounds, 256 images, 1024 edicts) to the wide one
(CS_REMAP_RERELEASE: 8192/2048/512/8192), mid-spawn, and keep the classic
game module running on top of it.

WHY THIS EXISTS. The 256-model ceiling is a property of the classic
CONFIGSTRING LAYOUT and of protocol 34's byte-wide modelindex field -- not of
the classic game module. That module stores modelindex/sound/image as plain
numbers and never sees a CsRemapT at all (it is an engine-side concept). So
there is nothing in the module that stops the engine hosting it over the wide
layout when the CONTENT needs it, which is exactly what the Call of the
Machine maps need under the classic ruleset: mgu4m1 alone precaches ~730
distinct model paths and used to die on SV_FindIndex's "*Index: overflow".

WHY IT IS AN ESCALATION AND NOT A SETTING. Choosing the wide layout up front
for every classic session would change the wire format of every classic game
this engine plays, including the ones that fit in the classic limits
perfectly well -- protocol 34 demos, vanilla clients, the lot. Escalating only
at the moment a block actually fills means a session whose content fits is
byte-for-byte the session it always was (still CS_REMAP_OLD, still
VANILLA_CODEC, still negotiating 34/35/36 per client), and only a session that
genuinely cannot be expressed in the classic layout pays for the wide one.

WHAT MOVES AND WHAT DOES NOT. The two layouts agree on every index below
`airaccel` (CS_NAME..CS_STATUSBAR), so those stay put. Everything at or above
it lives in one of the named blocks whose START index differs between the
families (CS_MODELS is 32 classic / 62 wide, CS_ITEMS 1056 / 11326, ...), so
the already-written contents of those blocks are relocated here, descending by
source index -- every destination is >= its source, so a descending pass never
overwrites a slot it has not yet copied out.

Crucially, what the game module holds onto does NOT move: modelindex, sound
and image values are offsets WITHIN their block (1, 2, 3, ...), and the block
contents move together with their offsets, so every index the module already
handed out stays valid. The two places a classic tree does embed a RAW
configstring index in data rather than passing it to gi.configstring()
(g_items.ts's STAT_PICKUP_STRING and p_hud.ts's STAT_CHASE) are remapped by
bindings/legacy.ts's own per-frame fixup pass, the same shim
bindings/legacy_kex.ts already uses for LMCTF.

WHEN IT REFUSES. Only during map load (ss_loading/ss_dead), and only from the
classic layout. Once clients are connected they have been told the classic
layout, so a late overflow must stay the hard error it always was rather than
silently relocating the space out from under them.

TWO CALLERS NOW. The original one is SV_FindIndexWidening's overflow
escalation below (the "*Index: overflow" rescue). The second, added later, is
SV_SpawnServer's up-front content check -- SV_ContentNeedsWideLayout, whose
own header explains the signal -- which runs BEFORE ge.SpawnEntities so a map
whose presentation the classic wire cannot carry spends its whole load on one
layout instead of relocating halfway through. `reason` only picks the console
wording; everything else about the two paths is identical.
================
*/
export function SV_WidenConfigstringSpace(reason = "Map exceeds the classic configstring limits"): boolean {
  if (svs.csr !== CS_REMAP_OLD) return false; // already wide (kex family, or a previous escalation this level)
  if (sv.state !== ServerStateT.ss_loading && sv.state !== ServerStateT.ss_dead) return false;

  // Relocate every already-written configstring into its wide-layout home.
  // Descending source order; see the header for why that is collision-free.
  for (let i = CS_REMAP_OLD.end - 1; i >= CS_REMAP_OLD.airaccel; i--) {
    const value = sv.configstrings[i];
    const dst = remapLegacyConfigstringIndex(i, CS_REMAP_OLD, CS_REMAP_RERELEASE);
    if (dst === i) continue;
    sv.configstrings[i] = "";
    sv.configstrings[dst] = value;
  }

  svs.csr = CS_REMAP_RERELEASE;
  // The wire from here on is 1038's, announced under this engine's own
  // protocol number so the client knows the module producing these wide
  // indices is the classic one -- see qcommon.ts's
  // PROTOCOL_VERSION_RERELEASE_CLASSIC doc comment.
  svs.codec = Q2REPRO_CLASSIC_CODEC;
  svs.sessionProtocol = PROTOCOL_VERSION_RERELEASE_CLASSIC;

  // sv.models/baselines/entities were allocated for the classic family by
  // sv.clear() (server.ts, sized off SV_MaxModels()/SV_MaxEdicts(), which
  // both read the live svs.csr). Grow them to the family that is now active
  // rather than relying on JS arrays extending themselves on write -- a read
  // past the old length would hand back `undefined` where the element types
  // promise `CmodelT | null` / a real EntityStateT.
  for (let i = sv.models.length; i < SV_MaxModels(); i++) sv.models[i] = null;
  for (let i = sv.baselines.length; i < SV_MaxEdicts(); i++) sv.baselines[i] = new EntityStateT();
  for (let i = sv.entities.length; i < SV_MaxEdicts(); i++) sv.entities[i] = new ServerEntityT();

  Com_Printf("%s; widening this session (protocol %i).\n", reason, PROTOCOL_VERSION_RERELEASE_CLASSIC);
  return true;
}

/*
================
SV_ContentNeedsWideLayout

Does the map about to be spawned carry presentation that the CLASSIC wire
cannot deliver? Answered from the BSP's own entity lump, before a single
spawn function runs.

WHY THE SESSION HAS TO DECIDE THIS UP FRONT. The overflow escalation below
only fires when a model/sound/image block actually fills, which on the
shipped re-release content is 3 maps out of 28 (mgu4m1, mgu4trial, mgu5m2).
Every other re-release map played under the classic ruleset stayed on the
narrow layout, and the narrow layout is exactly what turns cls.csr.extended
off on the client: no flares, no shadow lights, per-entity alpha and scale
dropped from the delta. The content was spawning server-side the whole time
(src/game's g_kexmisc/g_kextarg) and being thrown away on the wire. Deciding
at session start means the map's own presentation, not its precache count,
picks the layout.

WHY THIS SIGNAL AND NOT THE OTHER TWO CANDIDATES.

  * "The mounted data tree is the re-release tree" (files.ts's
    FS_RootIsRerelease / menu_content.ts's DataMountPlanFor) is one line, but
    it is a statement about the INSTALL, not about the map. It widens a
    re-release-tree session whose map needs nothing -- costing that session
    protocol 34 and every vanilla-family client that could have connected to
    it -- and it misses the reverse case, a re-release map reached through a
    lower-priority content_root while basedir points at a 1997 install.

  * "The BSP has re-release lumps" does not exist as a distinction: both
    trees' maps are plain IBSP/38 here (verified against this machine's two
    installs -- rerelease base1 and mgu2m3 are IBSP v38, same as 1997 base1).

The entity lump is the thing that is actually different, it is per-map, and
it is available at exactly the right moment.

WHAT COUNTS. Two closed sets, both derived from src/game itself -- this is a
statement about which ENTITY-STATE FIELDS the classic delta has no room for
(s.alpha, s.scale) and which renderfx bits the client only honors behind
cls.csr.extended (RF_FLARE, RF_CUSTOM_LIGHT, RF_CASTSHADOW plus its
CS_SHADOWLIGHTS block), mapped back to the map syntax that reaches them:

  * classnames whose spawn function in src/game writes one of those fields --
    enumerated in WIDE_LAYOUT_CLASSNAMES below, each with the site that
    proves it;
  * the generic spawn keys that write them on ANY entity -- "alpha" and
    "scale" (g_save.ts's fields[] routes both to target "edict_s"), and
    "shadowlightradius", the key setup_dynamic_light gates its whole
    shadow-light path on.

WHY IT NEVER WIDENS A 1997-DATA SESSION. None of these classnames exists in
the 1997 entity set, and no 1997 map carries the three keys. Checked, not
assumed: all 686 maps in this machine's classic tree (baseq2/ctf/rogue/
xatrix/lmctf paks plus loose maps) were scanned with this predicate's exact
key/value pairing and produced zero matches. The pairing matters -- a naive
substring search hits `"team" "alpha"` in baseq2's dlite.bsp, where "alpha"
is a team NAME in value position, which is why this parses key/value pairs
rather than grepping.

RE-CHECKED when the fog and world-text entries were added (trigger_fog,
info_world_text, and the 18 worldspawn fog_* / heightfog_* keys): 583 maps
across this machine's baseq2/ctf/lmctf paks carry none of them, so the
1997-data answer is still "never widen". Those additions are about MESSAGES
the classic wire has no opcode for (svc_fog) and engine hooks that only exist
on the wide layout (the info_world_text draw pair), rather than entity-state
fields -- the same question, one layer out.
================
*/

// Classname -> the src/game site that writes a field the classic wire drops.
// Kept as a table with its evidence attached so it can be re-audited against
// the module rather than trusted.
const WIDE_LAYOUT_CLASSNAMES: ReadonlyMap<string, string> = new Map([
  // g_kexmisc.ts SP_misc_flare: `ent.s.renderfx = RF_FLARE` + `ent.s.scale`.
  ["misc_flare", "RF_FLARE + s.scale"],
  // g_kextarg.ts SP_target_light: `self.s.renderfx = RF_CUSTOM_LIGHT`.
  ["target_light", "RF_CUSTOM_LIGHT"],
  // g_kexmisc.ts SP_dynamic_light/setup_dynamic_light: RF_CASTSHADOW plus one
  // CS_SHADOWLIGHTS configstring per light -- a block the classic layout does
  // not have at all (cs_remap.ts: shadowlights -1, max_shadowlights 0).
  ["dynamic_light", "RF_CASTSHADOW + CS_SHADOWLIGHTS"],
  // g_kexmisc.ts SP_misc_hologram / misc_hologram_think: s.alpha + s.scale.
  ["misc_hologram", "s.alpha + s.scale"],
  // g_kexmisc.ts SP_misc_player_mannequin: s.scale (ai_model_scale/radius).
  ["misc_player_mannequin", "s.scale"],
  // m_tank.ts SP_monster_tank_stand: `if (!self.s.scale) self.s.scale = 1.5`.
  // NOTE the classname: plain monster_tank (a 1997 classname) sets nothing.
  ["monster_tank_stand", "s.scale"],
  // m_guncmdr.ts SP_monster_guncmdr: `self.s.scale = 1.25`.
  ["monster_guncmdr", "s.scale"],
  // g_kextarg.ts target_camera_dummy_think / update_target_camera: the
  // HACKFLAG_TELEPORT_OUT fade writes s.alpha on the cutscene dummy.
  ["target_camera", "s.alpha"],
  // g_kextrig.ts trigger_fog_touch: writes the toucher's wanted fog, which
  // p_view.ts's P_ForceFogTransition publishes as an svc_fog message. That
  // opcode exists only in protocol 1038 -- the classic wire has no fog
  // message at all, so on a narrow session the volume fires, holds correct
  // state, and the view stays unfogged.
  ["trigger_fog", "svc_fog"],
  // g_kexmisc.ts info_world_text_think: gi.draw_oriented_world_text /
  // gi.draw_static_world_text, engine hooks that exist only on the wide
  // layout (bindings/legacy.ts gates both on svs.csr.extended).
  ["info_world_text", "world text draw hooks"],
  // g_kextarg.ts target_poi -> P_SendLevelPOI / Compass_Update -> gi.poi() /
  // gi.help_path(), i.e. the svc_poi and svc_help_path opcodes. Same class as
  // trigger_fog above: a MESSAGE the classic wire has no opcode for. Without
  // the wide layout the whole POI selection algorithm still runs and the
  // objective marker is simply never drawn.
  ["target_poi", "svc_poi + svc_help_path"],
  // g_kextarg.ts target_healthbar -> p_hud.ts G_SetHealthBarStat fills
  // STAT_HEALTH_BARS (stat 52). Protocol 34's delta walks MAX_STATS=32 slots
  // behind a 32-bit statbits mask (qcommon/protocol/vanilla.ts), so slot 52
  // has nowhere to go; the wide session's codec carries all 64 behind a u64
  // mask. The bar's label also needs CS_GENERAL+266, which only exists as a
  // free slot in the wide layout's general block.
  ["target_healthbar", "STAT_HEALTH_BARS (52) + CONFIG_HEALTH_BAR_NAME"],
]);

// Spawn keys that reach the same fields on any entity at all.
// g_save.ts fields[]: "alpha"/"scale" -> target "edict_s"; "shadowlightradius"
// -> spawntemp, and setup_dynamic_light keys its whole path on it being > 0.
// The worldspawn fog block is the other half of the svc_fog story:
// p_client.ts's PutClientInServer turns these keys into the spawning player's
// fog and sends one instant transition, so a map can be fogged from the first
// frame without owning a single trigger_fog. g_spawn.ts routes all 18 onto
// worldspawn's fog/heightfog structs.
const WIDE_LAYOUT_FOG_KEYS: readonly string[] = [
  "fog_color",
  "fog_color_off",
  "fog_density",
  "fog_density_off",
  "fog_sky_factor",
  "fog_sky_factor_off",
  "heightfog_falloff",
  "heightfog_falloff_off",
  "heightfog_density",
  "heightfog_density_off",
  "heightfog_start_color",
  "heightfog_start_color_off",
  "heightfog_start_dist",
  "heightfog_start_dist_off",
  "heightfog_end_color",
  "heightfog_end_color_off",
  "heightfog_end_dist",
  "heightfog_end_dist_off",
];

const WIDE_LAYOUT_KEYS: ReadonlySet<string> = new Set([
  "alpha",
  "scale",
  "shadowlightradius",
  ...WIDE_LAYOUT_FOG_KEYS,
]);

export function SV_ContentNeedsWideLayout(entityString: string): { needed: boolean; reason: string } {
  // Entity-lump grammar: `{ "key" "value" "key" "value" ... }` repeated.
  // Tokens are read in pairs and the pairing is re-synchronized at every
  // brace, so a value can never be mistaken for a key (see the dlite.bsp
  // case in the header).
  let i = 0;
  let expectKey = true;
  let pendingKey = "";
  const n = entityString.length;

  while (i < n) {
    const c = entityString[i];
    if (c === "{" || c === "}") {
      expectKey = true;
      i++;
      continue;
    }
    if (c !== '"') {
      i++;
      continue;
    }
    const end = entityString.indexOf('"', i + 1);
    if (end < 0) break; // unterminated token; nothing more is parseable
    const token = entityString.slice(i + 1, end);
    i = end + 1;

    if (expectKey) {
      pendingKey = token.toLowerCase();
      expectKey = false;
      if (WIDE_LAYOUT_KEYS.has(pendingKey)) {
        return { needed: true, reason: `Map carries the "${pendingKey}" key, which the classic protocol cannot deliver` };
      }
      continue;
    }

    expectKey = true;
    if (pendingKey === "classname") {
      const why = WIDE_LAYOUT_CLASSNAMES.get(token.toLowerCase());
      if (why !== undefined) {
        return { needed: true, reason: `Map carries ${token} (${why}), which the classic protocol cannot deliver` };
      }
    }
  }

  return { needed: false, reason: "" };
}

// Shared body of SV_ModelIndex/SV_SoundIndex/SV_ImageIndex: look the name up
// in its block and, if the block is full, try to widen the whole session once
// and look again in the (relocated, much larger) block. `pick` is re-invoked
// after the widening because the block's start index and size both change
// with svs.csr.
function SV_FindIndexWidening(name: string, pick: () => { start: number; max: number }): number {
  const first = pick();
  const found = SV_FindIndex(name, first.start, first.max, true, false);
  if (found >= 0) return found;

  if (!SV_WidenConfigstringSpace()) {
    // Not widenable (already wide, or clients are already live on this
    // layout) -- the original hard error, unchanged.
    Com_Error(ERR_DROP, "*Index: overflow");
  }

  const wide = pick();
  return SV_FindIndex(name, wide.start, wide.max, true);
}

export function SV_ModelIndex(name: string): number {
  return SV_FindIndexWidening(name, () => ({ start: svs.csr.models, max: svs.csr.max_models }));
}

export function SV_SoundIndex(name: string): number {
  return SV_FindIndexWidening(name, () => ({ start: svs.csr.sounds, max: svs.csr.max_sounds }));
}

export function SV_ImageIndex(name: string): number {
  return SV_FindIndexWidening(name, () => ({ start: svs.csr.images, max: svs.csr.max_images }));
}

/*
================
SV_CreateBaseline

Entity baselines are used to compress the update messages
to the clients -- only the fields that differ from the
baseline will be transmitted
================
*/
export function SV_CreateBaseline(): void {
  const ge = requireGe();
  for (let entnum = 1; entnum < ge.num_edicts; entnum++) {
    const svent = ge.edicts[entnum];
    if (!svent.inuse) continue;
    if (!svent.s.modelindex && !svent.s.sound && !svent.s.effects) continue;
    svent.s.number = entnum;

    // take current state as baseline
    VectorCopy(svent.s.origin, svent.s.old_origin);
    // `sv.baselines[entnum] = svent.s;` is a struct copy in C; TS objects are
    // references, so cloning is required here or the baseline would alias
    // the live entity and "differ from baseline" comparisons would always
    // see zero delta.
    sv.baselines[entnum] = cloneEntityState(svent.s);
  }
}

/*
=================
SV_CheckForSavegame
=================
*/
export function SV_CheckForSavegame(): void {
  if (sv_noreload && sv_noreload.value) return;
  if (Cvar_VariableValue("deathmatch")) return;

  // C: fopen(FS_Gamedir() + "/save/current/" + sv.name + ".sav", "rb") just
  // to test existence. node:fs is restricted to platform/ and
  // qcommon/files.ts per PORTING.md (outside this unit's SCOPE), so this
  // goes through FS_FOpenFile's search-path lookup instead of a raw
  // absolute-path fopen. See report.
  const open = FS_FOpenFile(`save/current/${sv.name}.sav`);
  if (!open) return; // no savegame
  FS_FCloseFile(open.handle);

  SV_ClearWorld();

  // get configstrings and areaportals
  SV_ReadLevelFile(); // sv_ccmds.ts pending stub -- throws if a savegame is actually found; see report

  // q2repro save.c's SV_CheckForSavegame(cmd): LOAD_NORMAL (loading an
  // explicit savegame via the `load` command -- sv.loadgame is set true by
  // SV_Loadgame_f's own SV_Map(false, svs.mapcmd, true) call) runs only 2
  // frames ("called from SV_Loadgame_f" -- the savegame already captured a
  // fully-settled state, so this just lets one-shot post-load bookkeeping
  // run). LOAD_LEVEL_START (sv.loadgame false -- a normal level transition
  // reading back the autosave written at this level's own start) runs a
  // full ten seconds' worth so monsters/thinks that depend on elapsed time
  // catch up naturally. Vanilla's sv_init.c has no LOAD_NORMAL case at all
  // (always 0 frames when sv.loadgame is true); this distinction is a
  // q2repro-era addition -- ARCHITECTURE.md names q2repro the reference
  // specification for engine behavior generally, and this file already
  // family-dispatches other engine behavior (SV_ComputeFramerate) the same
  // way against the same reference.
  const frames = sv.loadgame ? 2 : 10 * sv.framerate;

  // rlava2 was sending too many lightstyles, and overflowing the reliable
  // data. temporarily changing the server state to loading prevents these
  // from being passed down. Applied to both branches here (q2repro's own
  // SV_CheckForSavegame doesn't carry this trick at all, but it is
  // unconditionally safe protective behavior against exactly the kind of
  // reliable-buffer overflow the SZ_GetSpace investigation in
  // .orch/followups.md is about) -- vanilla only guards the ten-second
  // branch since it never ran the 2-frame one at all.
  const previousState = sv.state;
  sv.state = ServerStateT.ss_loading;
  const ge = requireGe();
  // q2repro save.c:652 advances sv.framenum alongside every catch-up
  // RunFrame(false) (`for (...; i++, sv.framenum++) ge->RunFrame(false)`);
  // divergence-audit finding #27: our loop used to leave sv.framenum
  // untouched, so nothing ever recorded that these frames ran.
  for (let i = 0; i < frames; i++) {
    ge.RunFrame(false); // savegame catch-up, same mainLoop=false as q2repro
    sv.framenum++;
  }
  sv.state = previousState;
}

/*
================
SV_ComputeFramerate

Mirrors q2repro's set_frame_time() family dispatch (src/server/init.c:
136-148): the kex family honors `sv_tick_rate` (clamped to
Com_ComputeFrametime's Q_clip(rate/BASE_FRAMERATE, 1, MAX_FRAMEDIV=6)
range, i.e. BASE_FRAMERATE(10) * 1..6 = 10..60); every legacy family
(baseq2/ctf/xatrix/rogue -- still hardcoded to FRAMETIME = 0.1s in
g_local.ts) is pinned to BASE_FRAMERATE(10) regardless of what the cvar
holds. Split out of SV_SpawnServer as its own exported function so the
family-dispatch decision is directly unit-testable without spinning up a
full map load.
================
*/
export function SV_ComputeFramerate(): number {
  const tickRate = Math.min(60, Math.max(10, sv_tick_rate ? sv_tick_rate.value : 10));
  return currentGameFamily() === "kex" ? tickRate : 10;
}

/*
================
SV_SpawnServer

Change the server to a new map, taking all connected
clients along with it.
================
*/
export function SV_SpawnServer(server: string, spawnpoint: string, serverstate: ServerStateT, attractloop: boolean, loadgame: boolean): void {
  if (attractloop) Cvar_Set("paused", "0");

  Com_Printf("------- Server Initialization -------\n");

  Com_DPrintf("SpawnServer: %s\n", server);
  if (sv.demofile !== null) FS_FCloseFile(sv.demofile);

  svs.spawncount++; // any partially connected client will be restarted
  sv.state = ServerStateT.ss_dead;
  Com_SetServerState(sv.state);

  // free current level's nav data (init.c:124-125: "CM_FreeMap(&sv.cm);
  // Nav_Unload();", right before the memset `sv.clear()` mirrors below).
  // Idempotent (a no-op if nothing is loaded), so it's safe here regardless
  // of whether the previous level ever called Nav_Load at all.
  Nav_Unload();

  // wipe the entire per-level structure
  sv.clear();
  svs.realtime = 0;
  sv.loadgame = loadgame;
  sv.attractloop = attractloop;

  // set framerate parameters -- mirrors q2repro's set_frame_time() dispatch
  // (src/server/init.c:136-148), called right after the same memset there.
  // sv.clear() just re-asserted the 10Hz defaults (see its own comment);
  // SV_ComputeFramerate re-derives them from the latched cvar the same way
  // maxclients' already-latched value is read directly below
  // (`maxclients.value`, no extra Cvar_GetLatchedVars() call needed here --
  // SV_InitGame already settled it before SV_SpawnServer runs).
  sv.framerate = SV_ComputeFramerate();
  sv.frametime = 1000 / sv.framerate;

  // save name for levels that don't set message
  sv.configstrings[CS_NAME] = server;
  if (Cvar_VariableValue("deathmatch")) {
    sv.configstrings[svs.csr.airaccel] = Com_sprintf("%g", sv_airaccelerate ? sv_airaccelerate.value : 0);
    SetPmAirAccelerate(sv_airaccelerate ? sv_airaccelerate.value : 0);
  } else {
    sv.configstrings[svs.csr.airaccel] = "0";
    SetPmAirAccelerate(0);
  }

  SZ_Init(sv.multicast, sv.multicast_buf, sv.multicast_buf.length);

  sv.name = server;

  // leave slots at start for clients only
  const maxc = maxclients ? maxclients.value : 0;
  for (let i = 0; i < maxc; i++) {
    const cl = svs.clients[i];
    if (!cl) continue;
    if (cl.state > ClientStateT.cs_connected) cl.state = ClientStateT.cs_connected;
    cl.lastframe = -1;
  }

  sv.time = 1000;

  sv.name = server;
  sv.configstrings[CS_NAME] = server;

  let checksum: number;
  if (serverstate !== ServerStateT.ss_game) {
    const loaded = CM_LoadMap("", false); // no real map
    sv.models[1] = loaded.model;
    checksum = loaded.checksum;
  } else {
    sv.configstrings[svs.csr.models + 1] = `maps/${server}.bsp`;
    const loaded = CM_LoadMap(sv.configstrings[svs.csr.models + 1], false);
    sv.models[1] = loaded.model;
    checksum = loaded.checksum;

    // init.c:165-166: "sv.cm = cmd->cm; Nav_Load(cmd->server);" -- only on
    // the real-map (ss_game) path, never for the cinematic/demo/pic
    // fake-map branch above. Missing bots/navigation/<map>.nav is the
    // common case and is handled gracefully inside Nav_Load itself (see
    // nav.ts's header): it does not throw or block server startup.
    //
    // FAMILY GATE (not in init.c -- see nav.ts's "A DELIBERATE, DOCUMENTED
    // DEVIATION" header comment for the full citation trail and Mike's
    // ruling): the kex family loads nav unconditionally, matching upstream
    // exactly; the legacy family only loads it when `sv_nav_legacy` is on,
    // default off.
    if (currentGameFamily() === "kex" || Nav_LegacyLoadEnabled()) {
      Nav_Load(server);
    }

    // CONTENT-DRIVEN LAYOUT CHOICE. The classic module can host any content,
    // but only the wide layout can DELIVER re-release presentation (it is
    // what sets cls.csr.extended on the client, and so what turns on flares,
    // shadow lights and per-entity alpha/scale). Ask the map's own entity
    // lump whether it has any of that, before ge.SpawnEntities runs, so the
    // whole spawn happens on one layout and the game module can see the
    // answer through gi.extended_layout() while it spawns (src/game's
    // setup_dynamic_light needs exactly that).
    //
    // No-op for a kex-family session (already CS_REMAP_RERELEASE, so
    // SV_WidenConfigstringSpace returns false) and for a classic session on
    // 1997 data (no map in the classic tree matches the predicate).
    // Only the three configstrings written so far (CS_NAME, airaccel,
    // models+1) exist at this point, and the relocation pass moves them.
    if (svs.csr === CS_REMAP_OLD) {
      const verdict = SV_ContentNeedsWideLayout(CM_EntityString());
      if (verdict.needed) SV_WidenConfigstringSpace(verdict.reason);
    }
  }
  sv.configstrings[svs.csr.mapchecksum] = `${checksum}`;

  // clear physics interaction links
  SV_ClearWorld();

  const numInline = CM_NumInlineModels();
  for (let i = 1; i < numInline; i++) {
    sv.configstrings[svs.csr.models + 1 + i] = `*${i}`;
    sv.models[i + 1] = CM_InlineModel(sv.configstrings[svs.csr.models + 1 + i]);
  }

  //
  // spawn the rest of the entities on the map
  //

  // precache and static commands can be issued during map initialization
  sv.state = ServerStateT.ss_loading;
  Com_SetServerState(sv.state);

  // load and spawn all other entities
  const ge = requireGe();
  ge.SpawnEntities(sv.name, CM_EntityString(), spawnpoint);
  SV_RunGamePostFrameHook();

  // run two frames to allow everything to settle -- mainLoop=false per
  // q2repro init.c's explicit ge->RunFrame(false) here, bypassing the kex
  // game's no-player-spawned early-out (see game.ts RunFrame's doc comment;
  // hardcoded true in the binding meant these frames settled nothing).
  // init.c:202-203 also advances sv.framenum alongside each of these two
  // calls (`for (i = 0; i < 2; i++, sv.framenum++) ge->RunFrame(false);`).
  ge.RunFrame(false);
  SV_RunGamePostFrameHook();
  sv.framenum++;
  ge.RunFrame(false);
  SV_RunGamePostFrameHook();
  sv.framenum++;

  // all precaches are complete
  sv.state = serverstate;
  Com_SetServerState(sv.state);
  // Tell the in-process client which protocol this SESSION demands
  // (SVC_DirectConnect: kex accepts only 1038; a classic session that had to
  // widen accepts only PROTOCOL_VERSION_RERELEASE_CLASSIC; an unwidened
  // classic session negotiates per client, signaled as 0). The localhost
  // connect path skips getchallenge entirely, so this bridge is its only
  // source of that fact -- see Com_ServerConnectProtocol's doc comment for
  // the campaign-start connect loop this fixes.
  //
  // Read AFTER SpawnEntities and the two settle frames above, which is what
  // makes the escalation visible here: SV_WidenConfigstringSpace can only
  // fire while those are running, so svs.sessionProtocol is final by now.
  // Which protocol the in-process client is told to use -- see
  // SV_LocalConnectProtocol's own doc comment.
  Com_SetServerConnectProtocol(SV_LocalConnectProtocol());

  // create a baseline for more efficient communications
  SV_CreateBaseline();

  // check for a savegame
  SV_CheckForSavegame();

  // respawn dummy MVD client, rebuild the MVD delta-compressor's baseline,
  // etc. (init.c:216, right after SV_CheckForSavegame and before the
  // serverinfo update below -- matches the reference's ordering)
  SV_MvdMapChanged();

  // set serverinfo variable
  Cvar_FullSet("mapname", sv.name, CVAR_SERVERINFO | CVAR_NOSET);

  Com_Printf("-------------------------------------\n");
}

/*
==============
SV_LocalConnectProtocol

Which protocol the IN-PROCESS (localhost) client is told to connect with.
Published through the Com_SetServerConnectProtocol bridge at the end of
SV_SpawnServer and read by cl_main.ts's CL_SendConnectPacket.
==============
*/
export function SV_LocalConnectProtocol(): number {
  // A session that demands one specific protocol (the kex family's 1038, or
  // PROTOCOL_VERSION_RERELEASE_CLASSIC for a classic session that had to
  // widen its configstring space) is answered with exactly that -- unchanged.
  if (svs.sessionProtocol !== 0) return svs.sessionProtocol;

  // A session that demands nothing (the classic module on the classic
  // configstring layout) still has to name ONE protocol here, because the
  // localhost connect path has no challenge exchange to negotiate over.
  // q2repro's own client does exactly this, and overrides the user's cvar to
  // do it (src/client/main.c:414-419, CL_CheckForResend):
  //
  //     if (cls.state < ca_connecting && sv_running->integer > ss_loading) {
  //         strcpy(cls.servername, "localhost");
  //         cls.serverAddress.type = NA_LOOPBACK;
  //         cls.serverProtocol = cl_protocol->integer;
  //         if (cls.serverProtocol != PROTOCOL_VERSION_RERELEASE)
  //             cls.serverProtocol = PROTOCOL_VERSION_RERELEASE;
  //         // we don't need a challenge on the localhost
  //
  // -- an in-process connect speaks whatever the local server speaks, never
  // what cl_protocol asked for. q2repro can hardcode 1038 there because its
  // server accepts nothing else; this server really does accept 34, 35 and 36
  // for a classic session, so "whatever the local server speaks" is the BEST
  // entry of the very list SVC_GetChallenge already advertises to remote
  // clients (`p=34,35,36`, sv_main.ts) -- Q2PRO/36. That is also the selection
  // rule cl_main.ts's CL_SendConnectPacket already applies to that list on the
  // challenge-driven path (`Math.max(...usable)`); returning it here is what
  // finally applies it to the ONE client that bypasses the challenge.
  //
  // Load-bearing, not tidiness. Protocol 34 has no packet_length field at all
  // (q2proto_server.c:159 gates the token on `protocol >= Q2P_PROTOCOL_R1Q2`),
  // so a 34 session is pinned to MAX_PACKETLEN_WRITABLE_DEFAULT (1390)
  // forever AND runs NETCHAN_OLD, which has no fragmentation to fall back on
  // (src/common/net/chan.c gives Netchan_TransmitNextFragment to NETCHAN_NEW
  // only). Call of the Machine's mgu5m1 builds per-frame datagrams well past
  // 1390 under the CLASSIC ruleset, so on 34 its frames were dropped every
  // tick and the map rendered black; on 36 the same session negotiates the
  // loopback budget (MAX_PACKETLEN_WRITABLE, 4086) and fragments anything
  // above it.
  //
  // Remote clients are untouched: SVC_GetChallenge still advertises
  // `p=34,35,36` and SVC_DirectConnect still accepts all three, so a genuine
  // vanilla client still gets vanilla's wire -- and, on content this size,
  // vanilla's own inability to carry it.
  return PROTOCOL_VERSION_Q2PRO;
}

/*
==============
SV_InitGame

A brand new game has been started
==============
*/
export async function SV_InitGame(): Promise<void> {
  if (svs.initialized) {
    // cause any connected clients to reconnect
    SV_Shutdown("Server restarted\n", true);
  } else {
    // make sure the client is down
    CL_DropHook();
    SCR_BeginLoadingPlaqueHook();
  }

  // get any latched variable changes (maxclients, etc)
  Cvar_GetLatchedVars();

  // C sets svs.initialized here, at the top. It is set at the bottom instead
  // because this function is async (NET_Config has to await a socket bind):
  // svs.initialized is what SV_Frame tests before touching the game library,
  // so setting it before the await lets a frame reach SV_RunGameFrame while
  // SV_InitGameProgs has not run yet. Nothing between here and the bottom
  // reads svs.initialized, so the move is behaviour-preserving.

  if (Cvar_VariableValue("coop") && Cvar_VariableValue("deathmatch")) {
    Com_Printf("Deathmatch and Coop both set, disabling Coop\n");
    Cvar_FullSet("coop", "0", CVAR_SERVERINFO | CVAR_LATCH);
  }

  // dedicated servers are can't be single player and are usually DM
  // so unless they explicity set coop, force it to deathmatch
  if (dedicated && dedicated.value) {
    if (!Cvar_VariableValue("coop")) Cvar_FullSet("deathmatch", "1", CVAR_SERVERINFO | CVAR_LATCH);
  }

  // init clients
  if (Cvar_VariableValue("deathmatch")) {
    if (!maxclients || maxclients.value <= 1) Cvar_FullSet("maxclients", "8", CVAR_SERVERINFO | CVAR_LATCH);
    else if (maxclients.value > MAX_CLIENTS) Cvar_FullSet("maxclients", `${MAX_CLIENTS}`, CVAR_SERVERINFO | CVAR_LATCH);
  } else if (Cvar_VariableValue("coop")) {
    // q2repro init.c:449-455 only floors coop maxclients to 4 when it's
    // <=1 (a config with no maxclients set at all); above that it's
    // clamped to MAX_CLIENTS like every other mode, not forced back down
    // to 4 -- the rerelease-era engine supports coop beyond 4 players.
    if (!maxclients || maxclients.value <= 1) Cvar_FullSet("maxclients", "4", CVAR_SERVERINFO | CVAR_LATCH);
    else if (maxclients.value > MAX_CLIENTS) Cvar_FullSet("maxclients", `${MAX_CLIENTS}`, CVAR_SERVERINFO | CVAR_LATCH);
    // Sys_CopyProtect() under #ifdef COPYPROTECT -- dropped, dead in every
    // real build (PORTING.md's #ifdef rule).
  } else {
    // non-deathmatch, non-coop is one player
    Cvar_FullSet("maxclients", "1", CVAR_SERVERINFO | CVAR_LATCH);
    // Sys_CopyProtect() under #ifdef COPYPROTECT -- dropped, see above.
  }

  const maxc = maxclients ? maxclients.value : 0;

  // init network stuff. This is the function's only await, and it must run
  // here, before any of svs' shared fields are touched below -- matching
  // q2repro's init.c:455-471, where NET_Config(NET_SERVER) runs before the
  // client pool (svs.client_pool) is allocated. q2repro's SV_InitGame is
  // fully synchronous end to end (init.c), so nothing there can ever be
  // observably interrupted mid-initialization; callers here (SV_Frame,
  // console commands, connectionless packet handling) can run in between
  // our awaits, and several of them read/mutate svs.clients without
  // checking svs.initialized (e.g. sv_ccmds.ts:1117's `!svs.clients.length`
  // free-slot scan, sv_main.ts's connectionless "connect" handler). Putting
  // the await before svs.clients/svs.spawncount/svs.num_client_entities/
  // svs.client_entities are (re)built means every one of those fields
  // changes in a single synchronous slice with no yield point in the
  // middle, so an interleaved caller either sees the fully-old state or
  // the fully-new state -- never a half-built svs.clients array with
  // unwired edicts.
  await NET_Config(maxc > 1);

  svs.spawncount = Math.floor(Math.random() * 0x7fffffff);
  svs.clients = Array.from({ length: maxc }, () => new ClientT());
  svs.num_client_entities = maxc * UPDATE_BACKUP * 64;
  svs.client_entities = Array.from({ length: svs.num_client_entities }, () => new EntityStateT());

  // heartbeats will always be sent to the id master
  svs.last_heartbeat = -99999; // send immediately
  NET_StringToAdr(`192.246.40.37:${PORT_MASTER}`, master_adr[0]);

  // init game
  SV_InitGameProgs(); // sv_game.ts is a real implementation now (no longer a throwing stub)

  const ge = requireGe();
  for (let i = 0; i < maxc; i++) {
    const ent = ge.edicts[i + 1];
    ent.s.number = i + 1;
    svs.clients[i].edict = ent;
    svs.clients[i].lastcmd = new UsercmdT();
  }

  svs.initialized = true;
}

/*
======================
SV_Map

  the full syntax is:

  map [*]<map>$<startspot>+<nextserver>

command from the console or progs.
Map can also be a.cin, .pcx, or .dm2 file
Nextserver is used to allow a cinematic to play, then proceed to
another level:

	map tram.cin+jail_e3
======================
*/
export async function SV_Map(attractloop: boolean, levelstring: string, loadgame: boolean): Promise<void> {
  sv.loadgame = loadgame;
  sv.attractloop = attractloop;

  if (sv.state === ServerStateT.ss_dead && !sv.loadgame) await SV_InitGame(); // the game is just starting

  let level = levelstring;

  // if there is a + in the map, set nextserver to the remainder
  const plus = level.indexOf("+");
  if (plus >= 0) {
    const rest = level.slice(plus + 1);
    level = level.slice(0, plus);
    Cvar_Set("nextserver", `gamemap "${rest}"`);
  } else {
    Cvar_Set("nextserver", "");
  }

  // ZOID special hack for end game screen in coop mode
  if (Cvar_VariableValue("coop") && Q_stricmp(level, "victory.pcx") === 0) {
    Cvar_Set("nextserver", 'gamemap "*base1"');
  }

  // if there is a $, use the remainder as a spawnpoint
  let spawnpoint = "";
  const dollar = level.indexOf("$");
  if (dollar >= 0) {
    spawnpoint = level.slice(dollar + 1);
    level = level.slice(0, dollar);
  }

  // skip the end-of-unit flag if necessary
  if (level.startsWith("*")) level = level.slice(1);

  const l = level.length;
  if (l > 4 && level.slice(l - 4) === ".cin") {
    SCR_BeginLoadingPlaqueHook(); // for local system
    SV_BroadcastCommand("changing\n");
    SV_SpawnServer(level, spawnpoint, ServerStateT.ss_cinematic, attractloop, loadgame);
  } else if (l > 4 && level.slice(l - 4) === ".dm2") {
    SV_BroadcastCommand("changing\n");
    SV_SpawnServer(level, spawnpoint, ServerStateT.ss_demo, attractloop, loadgame);
  } else if (l > 4 && level.slice(l - 4) === ".pcx") {
    SV_BroadcastCommand("changing\n");
    SV_SpawnServer(level, spawnpoint, ServerStateT.ss_pic, attractloop, loadgame);
  } else {
    SV_BroadcastCommand("changing\n");
    SV_SendClientMessages();
    SV_SpawnServer(level, spawnpoint, ServerStateT.ss_game, attractloop, loadgame);
    Cbuf_CopyToDefer();
  }

  SV_BroadcastCommand("reconnect\n");
}
