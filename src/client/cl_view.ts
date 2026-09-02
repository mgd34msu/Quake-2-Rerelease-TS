// cl_view.c -- player rendering positioning

import { CDAudio_Play } from "../platform/cd_ogg";
import { type Vec3, vec3, VectorAdd, VectorClear, VectorScale } from "../shared/math";
import { CS_CDTRACK, CVAR_ARCHIVE, CVAR_CHEAT, Com_sprintf, CS_SKY, CS_SKYAXIS, CS_SKYROTATE, type CvarT, MAX_CLIENTS, YAW } from "../shared/q_shared";
import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv } from "../qcommon/cmd";
import { Cvar_Get } from "../qcommon/cvar";
import { Com_Error, Com_Printf } from "../qcommon/common";
import { ERR_DROP } from "../qcommon/qcommon";
import { CM_InlineModel, CM_LoadMap } from "../qcommon/cmodel";
import { DlightT, EntityT, LightstyleT, MAX_DLIGHTS, MAX_ENTITIES, MAX_LIGHTSTYLES, MAX_PARTICLES, ParticleT } from "./ref";
import {
  cl,
  cls,
  clCvars,
  cl_weaponmodels,
  ConnstateT,
  gun_frame,
  gun_model,
  MAX_CLIENTWEAPONMODELS,
  num_cl_weaponmodels,
  re,
  setGunFrame,
  setGunModel,
  setNumClWeaponmodels,
  type ShadowLightT,
} from "./client";
import { CL_AddShadowLights } from "./cl_fx";
import { crosshair, crosshair_height, crosshair_pic, crosshair_width, scr_vrect, setCrosshair } from "./screen";
import { entitycmpfnc, SCR_AddDirtyPoint, SCR_TouchPics, SCR_UpdateScreen, SCR_DrawPOIs, SCR_DrawDamageDisplays } from "./cl_scrn";
import { CL_AddEntities, CL_ActiveSeatView } from "./cl_ents";
import { CL_CurrentFog } from "./cl_fog";
import { CL_WorldTexts } from "./cl_worldtext";
import { CL_RegisterTEntModels } from "./cl_tent";
import { CL_LoadClientinfo, CL_ParseClientinfo, CL_RegisterImage } from "./cl_parse";
import { Sys_SendKeyEvents } from "./cl_input";
import { Con_ClearNotify } from "./console_impl";
import { viddef } from "./vid";
import { Sys_Milliseconds } from "../platform/sys";
import { CG_HudUpscaleFactor } from "./cgame/host";

//=============
//
// development tools for weapons
//
//=============
// gun_frame/gun_model are extern in client.h, defined in cl_view.c in the
// original; owned by client.ts per that file's ownership note (this module
// reads/writes them through its setGunFrame/setGunModel setters).

let cl_testparticles: CvarT | null = null;
let cl_testentities: CvarT | null = null;
let cl_testlights: CvarT | null = null;
let cl_testblend: CvarT | null = null;

let cl_stats: CvarT | null = null;

export let r_numdlights = 0;
export const r_dlights: DlightT[] = Array.from({ length: MAX_DLIGHTS }, () => new DlightT());

export let r_numentities = 0;
export const r_entities: EntityT[] = Array.from({ length: MAX_ENTITIES }, () => new EntityT());

export let r_numparticles = 0;
export const r_particles: ParticleT[] = Array.from({ length: MAX_PARTICLES }, () => new ParticleT());

export const r_lightstyles: LightstyleT[] = Array.from({ length: MAX_LIGHTSTYLES }, () => new LightstyleT());

/*
====================
V_ClearScene

Specifies the model that will be used as the world
====================
*/
export function V_ClearScene(): void {
  r_numdlights = 0;
  r_numentities = 0;
  r_numparticles = 0;
}

/*
=====================
V_AddEntity

=====================
*/
export function V_AddEntity(ent: EntityT): void {
  if (r_numentities >= MAX_ENTITIES) return;
  const dst = r_entities[r_numentities++];
  dst.model = ent.model;
  dst.angles.set(ent.angles);
  dst.origin.set(ent.origin);
  dst.frame = ent.frame;
  dst.oldorigin.set(ent.oldorigin);
  dst.oldframe = ent.oldframe;
  dst.backlerp = ent.backlerp;
  dst.skinnum = ent.skinnum;
  dst.lightstyle = ent.lightstyle;
  dst.alpha = ent.alpha;
  dst.skin = ent.skin;
  dst.flags = ent.flags;
  // ref.ts's additive RF_FLARE fields (q2repro entity_t.rgba/.scale). The C
  // copies the whole struct (`clr.refdef.entities[clr.fd.num_entities++] =
  // *ent`), so these travel with everything else; this port's field-by-field
  // copy has to name them or a flare would reach the renderer with the
  // scene entity's stale tint/scale.
  dst.rgba.r = ent.rgba.r;
  dst.rgba.g = ent.rgba.g;
  dst.rgba.b = ent.rgba.b;
  dst.rgba.a = ent.rgba.a;
  dst.scale.set(ent.scale);
}

/*
=====================
V_AddParticle

=====================
*/
export function V_AddParticle(org: Vec3, color: number, alpha: number): void {
  if (r_numparticles >= MAX_PARTICLES) return;
  const p = r_particles[r_numparticles++];
  p.origin.set(org);
  p.color = color;
  p.alpha = alpha;
}

/*
=====================
V_AddLight

=====================
*/
export function V_AddLight(org: Vec3, intensity: number, r: number, g: number, b: number): void {
  if (r_numdlights >= MAX_DLIGHTS) return;
  const dl = r_dlights[r_numdlights++];
  dl.origin.set(org);
  dl.intensity = intensity;
  dl.color[0] = r;
  dl.color[1] = g;
  dl.color[2] = b;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/*
=====================
fade_distance_to_light

q2repro src/client/view.c's fade_distance_to_light -- CPU-side screen/
distance fade for CS_SHADOWLIGHTS-fed lights only. Classic V_AddLight
callers never set fade_start/fade_end (both default to 0), which this
function's first early-out treats as "no fade, always fully lit" -- a
no-op for every pre-existing V_AddLight call site.
=====================
*/
export function fadeDistanceToLight(fadeStart: number, fadeEnd: number, lightOrigin: Vec3, viewOrigin: Vec3): number {
  if (fadeStart <= 1 && fadeEnd <= 1) return 1;
  if (fadeStart > fadeEnd) return 1;

  const dx = lightOrigin[0] - viewOrigin[0];
  const dy = lightOrigin[1] - viewOrigin[1];
  const dz = lightOrigin[2] - viewOrigin[2];
  const distToLight = Math.hypot(dx, dy, dz);
  const fracToEnd = clamp01(distToLight / fadeEnd);
  const minFragDist = fadeStart / fadeEnd;

  if (minFragDist > 1) return 1;
  if (minFragDist <= 0) return fracToEnd;

  return 1 - smoothstep(minFragDist, 1, fracToEnd);
}

/*
=====================
V_AddLightEx

q2repro src/client/view.c's V_AddLightEx -- the CS_SHADOWLIGHTS-fed
counterpart to V_AddLight above, task #25 (v1.1.0). Populates the extra
DlightT fields (lightScale, cone) the shader path (gl_shader.ts) reads;
the fixed-function path never reads them, so this has no effect there.
=====================
*/
export function V_AddLightEx(light: ShadowLightT): void {
  if (r_numdlights >= MAX_DLIGHTS) return;

  const fade = fadeDistanceToLight(light.fade_start, light.fade_end, light.origin, cl.refdef.vieworg);
  if (fade <= 0) return;

  const dl = r_dlights[r_numdlights++];
  dl.origin.set(light.origin);
  dl.intensity = light.radius;
  dl.color[0] = light.color[0];
  dl.color[1] = light.color[1];
  dl.color[2] = light.color[2];

  // q2repro view.c:166 multiplies by `r_lightstyles[...].white`, but its own
  // V_AddLightStyle (view.c:217-224) takes ONE float and stores `ls->white =
  // value`. Vanilla's V_AddLightStyle -- which this port keeps faithfully,
  // cl_view.c:130-142 -- takes r,g,b and stores `ls->white = r+g+b`. Reading
  // `white` here would therefore apply q2repro's scale THREE times over
  // (CL_SetLightstyle gives all three channels the same value), which showed
  // up live as scale 6.0 on a light whose intensity is 2.0. rgb[0] is the
  // per-channel value, i.e. exactly q2repro's `white`, so it reconciles the
  // two conventions without disturbing either function's own fidelity.
  const styleScale = light.lightstyle === -1 ? 1 : r_lightstyles[light.lightstyle].rgb[0];
  dl.lightScale = light.intensity * styleScale * fade;
  dl.resolution = light.resolution;
  // marks this as a CS_SHADOWLIGHTS-fed light, which is what makes it
  // eligible for a shadow map at all (see DlightT.isShadowLight)
  dl.isShadowLight = true;

  if (light.coneangle) {
    const rad = (light.coneangle * Math.PI) / 180;
    dl.cone = { direction: vec3(light.conedirection[0], light.conedirection[1], light.conedirection[2]), cosHalfAngle: Math.cos(rad) };
  } else {
    dl.cone = null;
  }
}

/*
=====================
V_AddLightStyle

=====================
*/
export function V_AddLightStyle(style: number, r: number, g: number, b: number): void {
  if (style < 0 || style > MAX_LIGHTSTYLES) Com_Error(ERR_DROP, "Bad light style %i", style);
  const ls = r_lightstyles[style];
  ls.white = r + g + b;
  ls.rgb[0] = r;
  ls.rgb[1] = g;
  ls.rgb[2] = b;
}

/*
================
V_TestParticles

If cl_testparticles is set, create 4096 particles in the view
================
*/
function V_TestParticles(): void {
  r_numparticles = MAX_PARTICLES;
  for (let i = 0; i < r_numparticles; i++) {
    const d = i * 0.25;
    const r = 4 * ((i & 7) - 3.5);
    const u = 4 * (((i >> 3) & 7) - 3.5);
    const p = r_particles[i];

    for (let j = 0; j < 3; j++) {
      p.origin[j] = cl.refdef.vieworg[j] + cl.v_forward[j] * d + cl.v_right[j] * r + cl.v_up[j] * u;
    }

    p.color = 8;
    p.alpha = cl_testparticles?.value ?? 0;
  }
}

/*
================
V_TestEntities

If cl_testentities is set, create 32 player models
================
*/
function V_TestEntities(): void {
  r_numentities = 32;
  // memset(r_entities, 0, sizeof(r_entities)) in the C zeroes the whole
  // backing array; here only the active range (0..r_numentities) is reset
  // field-by-field since r_entities holds preallocated objects rather than
  // raw memory, and nothing ever reads past r_numentities.
  for (let i = 0; i < r_numentities; i++) {
    const ent = r_entities[i];
    ent.model = null;
    VectorClear(ent.angles);
    ent.frame = 0;
    VectorClear(ent.oldorigin);
    ent.oldframe = 0;
    ent.backlerp = 0;
    ent.skinnum = 0;
    ent.lightstyle = 0;
    ent.alpha = 0;
    ent.skin = null;
    ent.flags = 0;
  }

  for (let i = 0; i < r_numentities; i++) {
    const ent = r_entities[i];

    const r = 64 * ((i % 4) - 1.5);
    const f = 64 * Math.floor(i / 4) + 128;

    for (let j = 0; j < 3; j++) {
      ent.origin[j] = cl.refdef.vieworg[j] + cl.v_forward[j] * f + cl.v_right[j] * r;
    }

    ent.model = cl.baseclientinfo.model;
    ent.skin = cl.baseclientinfo.skin;
  }
}

/*
================
V_TestLights

If cl_testlights is set, create 32 lights models
================
*/
function V_TestLights(): void {
  r_numdlights = 32;
  for (let i = 0; i < r_numdlights; i++) {
    const dl = r_dlights[i];
    VectorClear(dl.origin);
    VectorClear(dl.color);
    dl.intensity = 0;

    const r = 64 * ((i % 4) - 1.5);
    const f = 64 * Math.floor(i / 4) + 128;

    for (let j = 0; j < 3; j++) {
      dl.origin[j] = cl.refdef.vieworg[j] + cl.v_forward[j] * f + cl.v_right[j] * r;
    }
    dl.color[0] = ((i % 6) + 1) & 1;
    dl.color[1] = (((i % 6) + 1) & 2) >> 1;
    dl.color[2] = (((i % 6) + 1) & 4) >> 2;
    dl.intensity = 200;
  }
}

//===================================================================

/*
=================
CL_SetSky

q2repro src/client/precache.c's CL_SetSky(): parses CS_SKYROTATE and
CS_SKYAXIS and hands the result to the renderer's SetSky. Extracted out of
CL_PrepRefresh (below) so cl_parse.ts's CL_ParseConfigString can call the
exact same parse path when a mid-level target_sky rewrites CS_SKYROTATE or
CS_SKYAXIS -- q2repro's own CL_UpdateConfigstring does the same (re-invokes
CL_SetSky() rather than duplicating its parse logic).

CS_SKYROTATE carries a single token ("<rotate>") under the classic/narrow
configstring layout, and two ("<rotate> <autorotate>") under the rerelease/
wide layout (cls.csr.extended) -- mirrors precache.c:380-383's
`cl.csr.extended ? sscanf(..., "%f %d", ...) : Q_atof(...)`. See
g_spawn.ts's SP_worldspawn for the write side of this same gate (the
classic game module only emits the two-token form when the session itself
is on the wide layout).
=================
*/
export function CL_SetSky(): void {
  if (!re) return;

  let rotate = 0;
  let autorotate = true;

  const rotateStr = cl.configstrings[CS_SKYROTATE].trim();
  if (cls.csr.extended) {
    const parts = rotateStr.split(/\s+/);
    if (parts[0]) {
      const r = parseFloat(parts[0]);
      if (!Number.isNaN(r)) rotate = r;
    }
    if (parts[1]) {
      const a = parseInt(parts[1], 10);
      if (!Number.isNaN(a)) autorotate = a !== 0;
    }
  } else {
    const r = parseFloat(rotateStr);
    if (!Number.isNaN(r)) rotate = r;
  }

  const axisParts = cl.configstrings[CS_SKYAXIS].trim().split(/\s+/).map(Number);
  const axis = vec3();
  axis[0] = axisParts[0] ?? 0;
  axis[1] = axisParts[1] ?? 0;
  axis[2] = axisParts[2] ?? 0;

  re.SetSky(cl.configstrings[CS_SKY], rotate, autorotate, axis);
}

/*
=================
CL_PrepRefresh

Call before entering a new level, or after changing dlls
=================
*/
export function CL_PrepRefresh(): void {
  if (!cl.configstrings[cls.csr.models + 1][0]) return; // no map loaded

  // ref_gl/ is not ported (PORTING.md); `re` stays null with no GL renderer
  // constructed, so this early-outs instead of null-derefing -- reported
  // deviation from the C, which never null-checks `re` (mirrors
  // CL_RegisterTEntModels's guard in cl_tent.ts).
  if (!re) return;

  SCR_AddDirtyPoint(0, 0);
  SCR_AddDirtyPoint(viddef.width - 1, viddef.height - 1);

  // let the render dll load the map
  const mapstring = cl.configstrings[cls.csr.models + 1];
  const mapname = mapstring.slice(5, mapstring.length - 4); // skip "maps/", cut off ".bsp"

  // Load the COLLISION model for this same map before the model loop below
  // resolves any "*N" inline-model configstring through CM_InlineModel --
  // that helper Com_Errors "CM_InlineModel: bad number" whenever cmodel.ts's
  // numcmodels is still 0, which is exactly the state a demo server leaves it
  // in (sv_init.ts's SV_SpawnServer calls CM_LoadMap("") for every non-
  // ss_game state, "no real map").
  //
  // NOT in cl_view.c: there, the CM_LoadMap always comes from the caller --
  // CL_Precache_f's "yet another hack to let old demos work" branch
  // (cl_main.c/cl_main.ts) runs `CM_LoadMap(cl.configstrings[CS_MODELS+1],
  // true)` immediately before calling here. That call still happens and this
  // one is a no-op behind cmodel.ts's map_name cache whenever it did (same
  // for a listen server, where SV_SpawnServer already loaded the very same
  // file). It is load-bearing only for CL_Frame's catch-up call
  // (`if (!cl.refresh_prepped && cls.state === ConnstateT.ca_active)
  // CL_PrepRefresh()`, cl_main.ts, itself straight out of cl_main.c): on a
  // `demomap` server the demo's own frames can push the client to ca_active
  // in the same client frame that queues the demo's stuffed "precache", and
  // any command already sitting in the command buffer (a `wait` from an
  // exec'd config, say) defers that "precache" past the catch-up call. id's
  // client only ever spoke one protocol and reached CL_PrepRefresh through
  // CL_Precache_f in practice; making the function load the map it is about
  // to register keeps that hazard from being fatal.
  CM_LoadMap(mapstring, true);

  // register models, pics, and skins
  Com_Printf(`Map: ${mapname}\r`);
  SCR_UpdateScreen();
  re.BeginRegistration(mapname);
  Com_Printf("                                     \r");

  // precache status bar pics
  Com_Printf("pics\r");
  SCR_UpdateScreen();
  SCR_TouchPics();
  Com_Printf("                                     \r");

  CL_RegisterTEntModels();

  setNumClWeaponmodels(1);
  cl_weaponmodels[0] = "weapon.md2";

  for (let i = 1; i < cls.csr.max_models && cl.configstrings[cls.csr.models + i][0]; i++) {
    const fullName = cl.configstrings[cls.csr.models + i];
    const name = fullName.slice(0, 37); // never go beyond one line
    if (name[0] !== "*") Com_Printf(`${name}\r`);
    SCR_UpdateScreen();
    Sys_SendKeyEvents(); // pump message loop
    if (name[0] === "#") {
      // special player weapon model
      if (num_cl_weaponmodels < MAX_CLIENTWEAPONMODELS) {
        cl_weaponmodels[num_cl_weaponmodels] = fullName.slice(1);
        setNumClWeaponmodels(num_cl_weaponmodels + 1);
      }
    } else {
      cl.model_draw[i] = re.RegisterModel(fullName);
      if (name[0] === "*") cl.model_clip[i] = CM_InlineModel(fullName);
      else cl.model_clip[i] = null;
    }
    if (name[0] !== "*") Com_Printf("                                     \r");
  }

  Com_Printf("images\r");
  SCR_UpdateScreen();
  for (let i = 1; i < cls.csr.max_images && cl.configstrings[cls.csr.images + i][0]; i++) {
    cl.image_precache[i] = CL_RegisterImage(cl.configstrings[cls.csr.images + i]);
    Sys_SendKeyEvents(); // pump message loop
  }

  Com_Printf("                                     \r");
  for (let i = 0; i < MAX_CLIENTS; i++) {
    if (!cl.configstrings[cls.csr.playerskins + i][0]) continue;
    Com_Printf(`client ${i}\r`);
    SCR_UpdateScreen();
    Sys_SendKeyEvents(); // pump message loop
    CL_ParseClientinfo(i);
    Com_Printf("                                     \r");
  }

  CL_LoadClientinfo(cl.baseclientinfo, "unnamed\\male/grunt");

  // set sky textures and speed
  Com_Printf("sky\r");
  SCR_UpdateScreen();
  CL_SetSky();
  Com_Printf("                                     \r");

  // the renderer can now free unneeded stuff
  re.EndRegistration();

  // clear any lines of console text
  Con_ClearNotify();

  SCR_UpdateScreen();
  cl.refresh_prepped = true;
  cl.force_refdef = true; // make sure we have a valid refdef

  // start the cd track
  CDAudio_Play(parseInt(cl.configstrings[CS_CDTRACK], 10) || 0, true);
  // dropped: no CD audio backend is ported. cdaudio.ts documents this as a
  // future src/platform/cdaudio.ts unit (none of CDAudio_Init/Play/Stop/
  // Update/Activate/Shutdown are defined anywhere in the C tree either --
  // they're per-platform: linux/cd_linux.c, win32/cd_win.c, null/cd_null.c).
}

/*
====================
CalcFov
====================
*/
export function CalcFov(fov_x: number, width: number, height: number): number {
  if (fov_x < 1 || fov_x > 179) Com_Error(ERR_DROP, "Bad fov: %f", fov_x);

  const x = width / Math.tan((fov_x / 360) * Math.PI);
  let a = Math.atan(height / x);
  a = (a * 360) / Math.PI;

  return a;
}

//============================================================================

// gun frame debugging functions
function V_Gun_Next_f(): void {
  setGunFrame(gun_frame + 1);
  Com_Printf("frame %i\n", gun_frame);
}

function V_Gun_Prev_f(): void {
  let frame = gun_frame - 1;
  if (frame < 0) frame = 0;
  setGunFrame(frame);
  Com_Printf("frame %i\n", gun_frame);
}

function V_Gun_Model_f(): void {
  if (Cmd_Argc() !== 2) {
    setGunModel(null);
    return;
  }
  const name = Com_sprintf("models/%s/tris.md2", Cmd_Argv(1));
  setGunModel(re?.RegisterModel(name) ?? null);
}

//============================================================================

// entitycmpfnc's true home is client/cl_scrn.c, and cl_scrn.ts (landed
// separately) already exports it for exactly this qsort call -- imported
// above rather than re-implemented here. See that file's own header for its
// reported deviation (ModelS/ImageS are opaque `unknown` handles with no
// address arithmetic in this port, so it returns a stable 0/equal instead
// of the C's pointer-difference comparison).

/*
=================
SCR_DrawCrosshair

SCR_DrawCrosshair's true home is also client/cl_view.c (confirmed here),
but the crosshair cvar and crosshair_pic/crosshair_width/crosshair_height
state were already declared in screen.ts by a prior unit anticipating
cl_scrn.c's real home for this state; V_Init registers the cvar through
screen.ts's setCrosshair rather than a new local binding to match that
placement.
=================
*/
export function SCR_DrawCrosshair(): void {
  if (!crosshair?.value) return;

  if (crosshair.modified) {
    crosshair.modified = false;
    SCR_TouchPics();
  }

  // q2repro screen.c:1960-1987's SCR_DrawCrosshair: POIs draw BEFORE the
  // crosshair pic itself (screen.c:1969), damage-direction wedges AFTER it
  // (screen.c:1986, past SCR_DrawHitMarker -- no hit-marker system exists
  // in this port, nothing to slot in there). Both live in cl_scrn.ts (this
  // unit's own store+draw home for those two systems -- see that file's
  // "DAMAGE INDICATORS / POINTS OF INTEREST / HELP PATH" section header);
  // called from here since this IS cl_view.c's own SCR_DrawCrosshair, the
  // exact call site the C uses.
  SCR_DrawPOIs();

  if (crosshair_pic) {
    // HUD SCALE. q2repro applies its whole 2D pass -- crosshair included --
    // through one renderer-level R_SetScale(1/scr.hud_scale) (screen.c's
    // SCR_Draw2D), so the crosshair pic has always grown with the HUD there.
    // This port has no SetScale primitive (host.ts's kexHudVrect note has the
    // full writeup on why, and does the same multiply one step earlier for
    // the kex HUD); the crosshair is the one 2D element outside either
    // cgame's DrawHUD, so it multiplies here instead, off the SAME factor
    // both cgames now use (CG_HudUpscaleFactor). Without it the rerelease
    // baseq2 "crosshair 1" asset -- pics/ch1.png, a 64x64 image whose only
    // opaque content is a 2x2 centre dot plus a near-transparent ring --
    // renders as a couple of pixels at 1280x960 and is effectively invisible
    // at 1080p, which is the "crosshair does not draw at all" play-test
    // report. Centring stays the C's `(width - w) >> 1` integer form, on the
    // SCALED size, so the pic still lands on scr_vrect's centre.
    //
    // scale === 1 forwards to the identical re.DrawPic call, so a sub-720p
    // render (a 640x480 mode, or 1280x960 at vid_scale 0.5) is unchanged.
    const scale = CG_HudUpscaleFactor();
    if (scale === 1) {
      re?.DrawPic(scr_vrect.x + ((scr_vrect.width - crosshair_width) >> 1), scr_vrect.y + ((scr_vrect.height - crosshair_height) >> 1), crosshair_pic);
    } else {
      const w = Math.round(crosshair_width * scale);
      const h = Math.round(crosshair_height * scale);
      re?.DrawStretchPic(scr_vrect.x + ((scr_vrect.width - w) >> 1), scr_vrect.y + ((scr_vrect.height - h) >> 1), w, h, crosshair_pic);
    }
  }

  // Not nested under the `if (crosshair_pic)` check above: that check is
  // this port's own pre-existing (non-C) guard against an unresolved
  // crosshair pic name, not something q2repro's SCR_DrawDamageDisplays
  // depends on -- the C only gates the whole function on scr_crosshair's
  // own on/off cvar (this function's own early return at the top).
  SCR_DrawDamageDisplays();
}

/*
==================
V_RenderView

==================
*/
export function V_RenderView(stereo_separation: number): void {
  if (cls.state !== ConnstateT.ca_active) return;

  if (!cl.refresh_prepped) return; // still loading

  if (clCvars.cl_timedemo?.value) {
    if (!cl.timedemo_start) cl.timedemo_start = Sys_Milliseconds();
    cl.timedemo_frames++;
  }

  // an invalid frame will just use the exact previous refdef
  // we can't use the old frame if the video mode has changed, though...
  if (cl.frame.valid && (cl.force_refdef || !clCvars.cl_paused?.value)) {
    cl.force_refdef = false;

    V_ClearScene();

    // build a refresh entity list and calc cl.sim*
    // this also calls CL_CalcViewValues which loads
    // v_forward, etc.
    CL_AddEntities();
    CL_AddShadowLights(); // task #25 (v1.1.0): CS_SHADOWLIGHTS-fed per-pixel lights

    if (cl_testparticles?.value) V_TestParticles();
    if (cl_testentities?.value) V_TestEntities();
    if (cl_testlights?.value) V_TestLights();
    if (cl_testblend?.value) {
      cl.refdef.blend[0] = 1;
      cl.refdef.blend[1] = 0.5;
      cl.refdef.blend[2] = 0.25;
      cl.refdef.blend[3] = 0.5;
    }

    // offset vieworg appropriately if we're doing stereo separation
    if (stereo_separation !== 0) {
      const tmp = vec3();
      VectorScale(cl.v_right, stereo_separation, tmp);
      VectorAdd(cl.refdef.vieworg, tmp, cl.refdef.vieworg);
    }

    // never let it sit exactly on a node line, because a water plane can
    // dissapear when viewed with the eye exactly on it.
    // the server protocol only specifies to 1/8 pixel, so add 1/16 in each axis
    cl.refdef.vieworg[0] += 1.0 / 16;
    cl.refdef.vieworg[1] += 1.0 / 16;
    cl.refdef.vieworg[2] += 1.0 / 16;

    cl.refdef.x = scr_vrect.x;
    cl.refdef.y = scr_vrect.y;
    cl.refdef.width = scr_vrect.width;
    cl.refdef.height = scr_vrect.height;
    cl.refdef.fov_y = CalcFov(cl.refdef.fov_x, cl.refdef.width, cl.refdef.height);
    cl.refdef.time = cl.time * 0.001;

    cl.refdef.areabits = cl.frame.areabits;

    if (!clCvars.cl_add_entities?.value) r_numentities = 0;
    if (!clCvars.cl_add_particles?.value) r_numparticles = 0;
    if (!clCvars.cl_add_lights?.value) r_numdlights = 0;
    if (!clCvars.cl_add_blend?.value) {
      VectorClear(cl.refdef.blend);
    }

    cl.refdef.num_entities = r_numentities;
    cl.refdef.entities = r_entities;
    cl.refdef.num_particles = r_numparticles;
    cl.refdef.particles = r_particles;
    cl.refdef.num_dlights = r_numdlights;
    cl.refdef.dlights = r_dlights;
    cl.refdef.lightstyles = r_lightstyles;

    // Per-viewport while a local splitscreen seat is being drawn: rdflags
    // carries RDF_UNDERWATER (the warp) and RDF_IRGOGGLES, which are
    // properties of where THAT seat's eyes are, not of the connection.
    // CL_ActiveSeatView() is null for every ordinary frame.
    const seatView = CL_ActiveSeatView();
    cl.refdef.rdflags = seatView ? seatView.ps.rdflags : cl.frame.playerstate.rdflags;

    // Resolve this frame's fog. q2repro view.c:616-650 does exactly this at
    // exactly this point (immediately after the entity/particle/dlight
    // handoff, immediately before the qsort): the client, not the server,
    // interpolates between the previous fog values and the ones the last
    // svc_fog asked for.
    CL_CurrentFog(cl.time, cl.refdef.fog, cl.refdef.heightfog);

    // info_world_text's draws for this frame. Filled by the server side of
    // this same process (sv_main.ts's SV_DeliverWorldText) rather than by a
    // network message -- see cl_worldtext.ts's header for why the
    // re-release has no such message to port.
    cl.refdef.worldtexts = CL_WorldTexts().slice();
    cl.refdef.num_worldtexts = cl.refdef.worldtexts.length;

    // sort entities for better cache locality
    const activeEntities = r_entities.slice(0, r_numentities);
    activeEntities.sort(entitycmpfnc);
    for (let i = 0; i < r_numentities; i++) r_entities[i] = activeEntities[i];
  }

  re?.RenderFrame(cl.refdef);
  if (cl_stats?.value) Com_Printf("ent:%i  lt:%i  part:%i\n", r_numentities, r_numdlights, r_numparticles);
  // log_stats_file is only written by the renderer (ref_gl/ref_soft's
  // R_RenderFrame), which this build does not link (PORTING.md: ref_gl is
  // not ported) -- dropped, mirrors common.ts's own note on log_stats_file.

  SCR_AddDirtyPoint(scr_vrect.x, scr_vrect.y);
  SCR_AddDirtyPoint(scr_vrect.x + scr_vrect.width - 1, scr_vrect.y + scr_vrect.height - 1);

  SCR_DrawCrosshair();
}

/*
=============
V_Viewpos_f
=============
*/
export function V_Viewpos_f(): void {
  Com_Printf(
    "(%i %i %i) : %i\n",
    Math.trunc(cl.refdef.vieworg[0]),
    Math.trunc(cl.refdef.vieworg[1]),
    Math.trunc(cl.refdef.vieworg[2]),
    Math.trunc(cl.refdef.viewangles[YAW]),
  );
}

/*
=============
V_Init
=============
*/
export function V_Init(): void {
  Cmd_AddCommand("gun_next", V_Gun_Next_f);
  Cmd_AddCommand("gun_prev", V_Gun_Prev_f);
  Cmd_AddCommand("gun_model", V_Gun_Model_f);

  Cmd_AddCommand("viewpos", V_Viewpos_f);

  // q2repro src/client/screen.c:1452 defaults crosshair to "3" (cvar-parity fix).
  setCrosshair(Cvar_Get("crosshair", "3", CVAR_ARCHIVE));

  cl_testblend = Cvar_Get("cl_testblend", "0", 0);
  cl_testparticles = Cvar_Get("cl_testparticles", "0", 0);
  cl_testentities = Cvar_Get("cl_testentities", "0", 0);
  // q2repro src/client/view.c:711 flags cl_testlights CVAR_CHEAT (cvar-parity fix).
  cl_testlights = Cvar_Get("cl_testlights", "0", CVAR_CHEAT);

  cl_stats = Cvar_Get("cl_stats", "0", 0);

  // q2repro src/client/view.c:722. Registered, consumer unported: this
  // port's FOV handling (fov cvar, cl_main.ts) has no automatic
  // widescreen/aspect adjustment pass.
  Cvar_Get("cl_adjustfov", "1", 0);
}
