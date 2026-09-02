// lmctf60/p_weapon.c -- COMPLETE port of the player weapon machinery.
//
// HISTORY: this file was previously a deliberate SUBSET -- only
// P_ProjectSource plus the offhand grapple chain (hook_touch,
// Grapple_Bolt_Think, hook_die, fire_hook, Draw_Hook, Weapon_Hook_Fire),
// with Weapon_Hook itself a throwing stub because Weapon_Generic /
// ChangeWeapon / NoAmmoWeaponChange did not exist. The whole id weapon set
// is now ported, Weapon_Hook is real, and the SKWiD plasma rifle's
// weapon_plasma_fire/Weapon_Plasma entry points are here too (their frame
// driver Weapon_PLASMA_Generic stays in plasma.ts, which is where
// lmctf60/plasma.c defines it).
//
// PROVENANCE ROUTE: LM-CTF is a fork of ZOID's CTF, and
// `diff -u quake-2-c/ctf/p_weapon.c lmctf60/p_weapon.c` is ~1200 lines of
// which the great bulk is (a) the removed GPL header, (b) never-#define'd
// `#ifdef WEAP_BALANCE_OK` tuning blocks, and (c) the appended LM_JORM
// grapple + SKWiD plasma sections. This port is therefore the faithful
// sibling port in src/ctf/p_weapon.ts with LM-CTF's deltas applied at their
// sites; each delta is cited inline. The substantive LM-CTF deltas are:
//
//   D1. Weapon_Generic is a REWRITE, not ZOID's Weapon_Generic/
//       Weapon_Generic2 haste-rerun pair. LM-CTF deletes ZOID's haste and
//       strength-sound hooks entirely, swaps the `instantweap` cvar for
//       `fastswitch`, and adds an isfiring flag plus a "change the weapon
//       right away" out-of-ammo check at the end of the FIRING branch. See
//       Weapon_Generic's own doc comment for the point-by-point list.
//   D2. Pickup_Weapon refuses every pickup while
//       `matchstate == MATCH_RAILGUN_INPLAY` (the railgun-only round).
//   D3. ChangeWeapon force-selects the railgun during MATCH_RAILGUN_INPLAY
//       for any live player, before doing anything else.
//   D4. Think_Weapon hoists `is_quad` out of the has-a-weapon branch (so it
//       is refreshed even for a dead/weaponless client) and calls
//       g_runes.ts's RuneWeaponThinkHook after the weapon's own think.
//   D5. Use_Weapon/Drop_Weapon print through g_ctffunc.ts's ctf_SafePrint
//       instead of gi.cprintf directly.
//   D6. weapon_grenade_fire adds an `ent->health <= 0` early return before
//       the throw animation.
//   D7. Weapon_Grenade zeroes grenade_time after the gunframe-12 throw.
//   D8. weapon_railgun_fire deals 5000/5000 damage/kick during
//       MATCH_RAILGUN_INPLAY (one-shot railgun rounds).
//   D9. weapon_bfg_fire's gunframe-9 PlayerNoise passes `start` rather than
//       `ent->s.origin` -- see that function's comment; `start` is an
//       UNINITIALIZED C stack local at that point, so LM-CTF turned a
//       correct call into id's classic uninitialized read.
//
// NOT PORTED, deliberately: `fire_fieldgun` (lmctf60/p_weapon.c:1386) and
// `weapon_fieldgun_fire` (:1455). Both are complete, compiled functions but
// nothing references them anywhere in lmctf60 -- no ITEMLIST row, no
// weaponthink, no extern (`grep -rn fieldgun lmctf60` finds only their two
// definitions). They are dead code that never runs, and porting them would
// add a second, conflicting reader/writer of `client.hooklength` for no
// observable behavior. Reported rather than reproduced.
//
// m_player.h frame split: lmctf60/m_player.h is a 200+ constant
// qdata-generated header with no TS home in src/lmctf yet; the handful of
// frames this file needs are declared locally with their C line numbers,
// exactly the way plasma.ts already does for its own frame set. Reported as
// a follow-up to relocate into a shared src/lmctf/m_player_frames.ts.

import {
  AngleVectors,
  crandom,
  random,
  type Vec3,
  vec3,
  vec3_origin,
  VectorAdd,
  VectorClear,
  VectorCopy,
  VectorLength,
  VectorMA,
  VectorNormalize,
  VectorScale,
  VectorSet,
  VectorSubtract,
} from "../shared/math";
import {
  ATTN_IDLE,
  ATTN_NORM,
  BUTTON_ATTACK,
  CHAN_AUTO,
  CHAN_ITEM,
  CHAN_VOICE,
  CHAN_WEAPON,
  type CplaneT,
  type CsurfaceT,
  type CvarT,
  DF_INFINITE_AMMO,
  DF_WEAPONS_STAY,
  EF_BLASTER,
  EF_HYPERBLASTER,
  MASK_SHOT,
  MulticastT,
  MZ_BFG,
  MZ_BLASTER,
  MZ_CHAINGUN1,
  MZ_GRENADE,
  MZ_HYPERBLASTER,
  MZ_MACHINEGUN,
  MZ_RAILGUN,
  MZ_ROCKET,
  MZ_SHOTGUN,
  MZ_SILENCED,
  MZ_SSHOTGUN,
  PITCH,
  PMF_DUCKED,
  PRINT_HIGH,
  ROLL,
  SURF_SKY,
  TempEventT,
  YAW,
} from "../shared/q_shared";
import { type Edict, SolidT, SVF_NOCLIENT } from "./game";
import { T_Damage } from "./g_combat";
import { CTF_TEAM_ANYTEAM, ctf_hook_abort, ctf_SafePrint, ctf_validateplayer } from "./g_ctffunc";
import { Add_Ammo, Drop_Item, FindItem, ITEM_INDEX, SetRespawn } from "./g_items";
import {
  ANIM_ATTACK,
  ANIM_PAIN,
  ANIM_REVERSE,
  CENTER_HANDED,
  CTF_NO_GRAP_DAMAGE,
  DAMAGE_ENERGY,
  DAMAGE_TIME,
  DROPPED_ITEM,
  DROPPED_PLAYER_ITEM,
  type EdictT,
  FL_NOTARGET,
  FL_RESPAWN,
  g_edicts,
  gameCvars,
  type GClientT,
  gi,
  type GItemT,
  IT_AMMO,
  LEFT_HANDED,
  level,
  MOD_CHAINGUN,
  MOD_CTF_GRAPPLE,
  MOD_MACHINEGUN,
  MOD_SHOTGUN,
  MOD_SSHOTGUN,
  MovetypeT,
  PNOISE_SELF,
  PNOISE_WEAPON,
  svc_muzzleflash,
  svc_temp_entity,
  WeaponstateT,
  world,
} from "./g_local";
import { RuneWeaponThinkHook } from "./g_runes";
import { MatchStatesT, matchstate } from "./g_tourney";
import { G_ProjectSource, G_Spawn, vectoangles } from "./g_utils";
import { fire_bfg, fire_blaster, fire_bullet, fire_grenade, fire_grenade2, fire_rail, fire_rocket, fire_shotgun } from "./g_weapon";
import { fire_plasma, PLASMA_SOUND_EMPTY, PLASMA_SOUND_FIRE1, PLASMA_SOUND_FIRE2, Weapon_PLASMA_Generic } from "./plasma";

// ---------------------------------------------------------------------
// lmctf60/m_player.h frame constants (see file header for why they live
// here). Values verified against the C header line-for-line.
// ---------------------------------------------------------------------
const FRAME_attack1 = 46; // lmctf60/m_player.h:51
const FRAME_attack8 = 53; // lmctf60/m_player.h:58
const FRAME_pain301 = 62; // lmctf60/m_player.h:67
const FRAME_pain304 = 65; // lmctf60/m_player.h:70
const FRAME_wave01 = 112; // lmctf60/m_player.h:117
const FRAME_wave08 = 119; // lmctf60/m_player.h:124
const FRAME_crattak1 = 160; // lmctf60/m_player.h:165
const FRAME_crattak3 = 162; // lmctf60/m_player.h:167
const FRAME_crattak9 = 168; // lmctf60/m_player.h:173
const FRAME_crpain1 = 169; // lmctf60/m_player.h:174
const FRAME_crpain4 = 172; // lmctf60/m_player.h:177

// lmctf60/g_local.h's DEFAULT_BULLET_HSPREAD/VSPREAD and DEFAULT_*SHOTGUN*
// family live in g_local.h, but this unit's SCOPE does not include
// g_local.ts (which is already a complete port of that header and does not
// carry them); ported as local consts here, same treatment as the
// m_player.h frame split above, and reported as a follow-up to relocate.
const DEFAULT_BULLET_HSPREAD = 300;
const DEFAULT_BULLET_VSPREAD = 500;
const DEFAULT_SHOTGUN_HSPREAD = 1000;
const DEFAULT_SHOTGUN_VSPREAD = 500;
const DEFAULT_DEATHMATCH_SHOTGUN_COUNT = 12;
const DEFAULT_SHOTGUN_COUNT = 12;
const DEFAULT_SSHOTGUN_COUNT = 20;

// `static qboolean is_quad; static byte is_silenced;` -- file-static
// globals in the C, so plain (unexported) module-locals here.
let is_quad = false;
let is_silenced = 0;

function cvarNum(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}

function dmFlags(): number {
  return cvarNum(gameCvars.dmflags) | 0;
}

function requireItem(item: GItemT | null): GItemT {
  if (item !== null) return item;
  gi.error("p_weapon: expected item lookup to succeed");
}

function requireNoise(noise: EdictT | null): EdictT {
  if (noise !== null) return noise;
  gi.error("PlayerNoise: noise entity not initialized");
}

// Recovers the game-private EdictT from a trace's game-visible `Edict`, per
// PORTING.md's EDICT_NUM idiom (`g_edicts[ent.s.number]`, never a cast) --
// identical to g_weapon.ts's traceEdict, including its NULL -> world-edict
// fallback (matches EdictT.touch's non-nullable `other` parameter;
// `fire_hook` only invokes touch when `tr.fraction < 1.0`, i.e. something
// was actually hit, so this fallback is defensive, not a path exercised in
// practice).
function traceEdict(ent: Edict | null): EdictT {
  if (ent === null) return world();
  return g_edicts[ent.s.number] ?? world();
}

// lmctf60/p_weapon.c: `#define GRAPPLE_FIRE_HOOK_SPEED 800` /
// `#define GRAPPLE_PULL_SPEED 800` / `#define GRAPPLE_PULL_BALANCED_SPEED 800`
// (file-local #defines, ported as module-scoped consts). The "balanced"
// variant is dead code: it is only read under `#ifdef WEAP_BALANCE_OK`,
// which the Makefile never defines (see g_local.ts's CTF_WEAP_BALANCE
// comment) -- and even if it were live, it is numerically identical to
// GRAPPLE_PULL_SPEED (both 800), so there would be no observable difference
// either way.
export const GRAPPLE_FIRE_HOOK_SPEED = 800;
export const GRAPPLE_PULL_SPEED = 800;

/*
=================
P_ProjectSource (lmctf60/p_weapon.c:26)

`static` in the C (LM-CTF made it static; ZOID's is extern) -- exported
here anyway so it is directly testable and so g_ctffunc.ts/plasma.ts can
share the one implementation, the same call this port's ctf sibling makes.
=================
*/
export function P_ProjectSource(client: GClientT, point: Vec3, distance: Vec3, forward: Vec3, right: Vec3, result: Vec3): void {
  const _distance = vec3();
  VectorCopy(distance, _distance);
  if (client.pers.hand === LEFT_HANDED) _distance[1] *= -1;
  else if (client.pers.hand === CENTER_HANDED) _distance[1] = 0;
  G_ProjectSource(point, _distance, forward, right, result);
}

/*
===============
PlayerNoise (lmctf60/p_weapon.c:51) -- unchanged from ctf.

Each player can have two noise objects associated with it:
a personal noise (jumping, pain, weapon firing), and a weapon
target noise (bullet wall impacts)

Monsters that don't directly see the player can move
to a noise in hopes of seeing the player from there.

(With no monster subsystem in this game family the noise entities are never
consumed, but the function still runs its silencer_shots decrement and its
two-entity allocation exactly as the C does -- both are observable.)
===============
*/
export function PlayerNoise(who: EdictT, where: Vec3, noiseType: number): void {
  if (noiseType === PNOISE_WEAPON) {
    const client = who.client;
    if (client !== null && client.silencer_shots) {
      client.silencer_shots--;
      return;
    }
  }

  if (cvarNum(gameCvars.deathmatch)) return;

  if (who.flags & FL_NOTARGET) return;

  if (who.mynoise === null) {
    const noise1 = G_Spawn();
    noise1.classname = "player_noise";
    VectorSet(noise1.mins, -8, -8, -8);
    VectorSet(noise1.maxs, 8, 8, 8);
    noise1.owner = who;
    noise1.svflags = SVF_NOCLIENT;
    who.mynoise = noise1;

    const noise2 = G_Spawn();
    noise2.classname = "player_noise";
    VectorSet(noise2.mins, -8, -8, -8);
    VectorSet(noise2.maxs, 8, 8, 8);
    noise2.owner = who;
    noise2.svflags = SVF_NOCLIENT;
    who.mynoise2 = noise2;
  }

  let noise: EdictT;
  if (noiseType === PNOISE_SELF || noiseType === PNOISE_WEAPON) {
    noise = requireNoise(who.mynoise);
    level.sound_entity = noise;
    level.sound_entity_framenum = level.framenum;
  } else {
    // type == PNOISE_IMPACT
    noise = requireNoise(who.mynoise2);
    level.sound2_entity = noise;
    level.sound2_entity_framenum = level.framenum;
  }

  VectorCopy(where, noise.s.origin);
  VectorSubtract(where, noise.maxs, noise.absmin);
  VectorAdd(where, noise.maxs, noise.absmax);
  noise.teleport_time = level.time;
  gi.linkentity(noise);
}

/*
=================
Pickup_Weapon (lmctf60/p_weapon.c:111)

LM-CTF DELTA D2: the `matchstate == MATCH_RAILGUN_INPLAY` early-false at the
top -- during a railgun-only round no weapon on the floor can be picked up
at all (the round hands everyone a railgun via ChangeWeapon instead).
Everything below it is ZOID's/id's, unchanged.
=================
*/
export function Pickup_Weapon(ent: EdictT, other: EdictT): boolean {
  if (matchstate === MatchStatesT.MATCH_RAILGUN_INPLAY) return false;

  const client = other.client;
  const item = ent.item;
  if (client === null || item === null) return false;

  const index = ITEM_INDEX(item);

  if ((dmFlags() & DF_WEAPONS_STAY || cvarNum(gameCvars.coop)) && client.pers.inventory[index]) {
    if ((ent.spawnflags & (DROPPED_ITEM | DROPPED_PLAYER_ITEM)) === 0) return false; // leave the weapon for others to pickup
  }

  client.pers.inventory[index]++;

  if ((ent.spawnflags & DROPPED_ITEM) === 0) {
    // give them some ammo with it
    if (item.ammo !== null && item.ammo.length > 0) {
      const ammo = requireItem(FindItem(item.ammo));
      if (dmFlags() & DF_INFINITE_AMMO) Add_Ammo(other, ammo, 1000);
      else Add_Ammo(other, ammo, ammo.quantity);
    }

    if ((ent.spawnflags & DROPPED_PLAYER_ITEM) === 0) {
      if (cvarNum(gameCvars.deathmatch)) {
        if (dmFlags() & DF_WEAPONS_STAY) ent.flags |= FL_RESPAWN;
        else SetRespawn(ent, 30);
      }
      if (cvarNum(gameCvars.coop)) ent.flags |= FL_RESPAWN;
    }
  }

  if (
    client.pers.weapon !== item &&
    client.pers.inventory[index] === 1 &&
    (!cvarNum(gameCvars.deathmatch) || client.pers.weapon === FindItem("blaster"))
  ) {
    client.newweapon = item;
  }

  return true;
}

/*
===============
ChangeWeapon (lmctf60/p_weapon.c:171)

The old weapon has been dropped all the way, so make the new one
current.

LM-CTF DELTA D3: during MATCH_RAILGUN_INPLAY a live player (`health > 0`)
has `newweapon` forced to the railgun and the function RETURNS -- the
switch itself never completes on that frame, so Weapon_Generic will call
ChangeWeapon again next frame and hit the same branch. That is the C
behavior: a player in a railgun round is pinned holding whatever they had,
with newweapon permanently reasserted as the railgun, until the round ends
or they die. Preserved exactly; the dead-player path (health <= 0) falls
through to the normal switch, which is how Think_Weapon's "just died, put
the weapon away" still works during a railgun round.
===============
*/
export function ChangeWeapon(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if (matchstate === MatchStatesT.MATCH_RAILGUN_INPLAY && ent.health > 0) {
    client.newweapon = FindItem("railgun");
    return;
  }

  if (client.grenade_time) {
    client.grenade_time = level.time;
    client.weapon_sound = 0;
    weapon_grenade_fire(ent, false);
    client.grenade_time = 0;
  }

  client.pers.lastweapon = client.pers.weapon;
  client.pers.weapon = client.newweapon;
  client.newweapon = null;
  client.machinegun_shots = 0;

  // set visible model
  if (ent.s.modelindex === 255) {
    let i: number;
    if (client.pers.weapon !== null) i = (client.pers.weapon.weapmodel & 0xff) << 8;
    else i = 0;
    // C: `ent - g_edicts - 1` (pointer offset); `s.number` is stamped at
    // allocation time, so this is `ent.s.number - 1`, same convention the
    // rest of this port uses.
    ent.s.skinnum = (ent.s.number - 1) | i;
  }

  if (client.pers.weapon !== null && client.pers.weapon.ammo !== null && client.pers.weapon.ammo.length > 0) {
    client.ammo_index = ITEM_INDEX(requireItem(FindItem(client.pers.weapon.ammo)));
  } else {
    client.ammo_index = 0;
  }

  if (client.pers.weapon === null) {
    // dead
    client.ps.gunindex = 0;
    return;
  }

  client.weaponstate = WeaponstateT.WEAPON_ACTIVATING;
  client.ps.gunframe = 0;
  client.ps.gunindex = gi.modelindex(client.pers.weapon.view_model ?? "");

  client.anim_priority = ANIM_PAIN;
  if (client.ps.pmove.pm_flags & PMF_DUCKED) {
    ent.s.frame = FRAME_crpain1;
    client.anim_end = FRAME_crpain4;
  } else {
    ent.s.frame = FRAME_pain301;
    client.anim_end = FRAME_pain304;
  }
}

/*
=================
NoAmmoWeaponChange (lmctf60/p_weapon.c:239) -- unchanged from ctf/id.

Note this ladder never mentions the LM-CTF plasma rifle or the grapple:
running dry on cells with a plasma rifle in hand falls through to the
hyperblaster (also cells) if you own one, and otherwise keeps walking down
to the blaster. That is the C's behavior, not an omission here.
=================
*/
export function NoAmmoWeaponChange(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const slugs = requireItem(FindItem("slugs"));
  const railgun = requireItem(FindItem("railgun"));
  if (client.pers.inventory[ITEM_INDEX(slugs)] && client.pers.inventory[ITEM_INDEX(railgun)]) {
    client.newweapon = railgun;
    return;
  }
  const cells = requireItem(FindItem("cells"));
  const hyperblaster = requireItem(FindItem("hyperblaster"));
  if (client.pers.inventory[ITEM_INDEX(cells)] && client.pers.inventory[ITEM_INDEX(hyperblaster)]) {
    client.newweapon = hyperblaster;
    return;
  }
  const bullets = requireItem(FindItem("bullets"));
  const chaingun = requireItem(FindItem("chaingun"));
  if (client.pers.inventory[ITEM_INDEX(bullets)] && client.pers.inventory[ITEM_INDEX(chaingun)]) {
    client.newweapon = chaingun;
    return;
  }
  const machinegun = requireItem(FindItem("machinegun"));
  if (client.pers.inventory[ITEM_INDEX(bullets)] && client.pers.inventory[ITEM_INDEX(machinegun)]) {
    client.newweapon = machinegun;
    return;
  }
  const shells = requireItem(FindItem("shells"));
  const supershotgun = requireItem(FindItem("super shotgun"));
  if (client.pers.inventory[ITEM_INDEX(shells)] > 1 && client.pers.inventory[ITEM_INDEX(supershotgun)]) {
    client.newweapon = supershotgun;
    return;
  }
  const shotgun = requireItem(FindItem("shotgun"));
  if (client.pers.inventory[ITEM_INDEX(shells)] && client.pers.inventory[ITEM_INDEX(shotgun)]) {
    client.newweapon = shotgun;
    return;
  }
  client.newweapon = requireItem(FindItem("blaster"));
}

/*
=================
Think_Weapon (lmctf60/p_weapon.c:287)

Called by ClientBeginServerFrame and ClientThink.

LM-CTF DELTA D4, two parts:
  - `is_quad` is assigned on the FIRST line, outside the has-a-weapon
    branch, where ctf/id assign it inside. Observable: a client with no
    pers.weapon (dead, or mid-switch) still refreshes the file-global, so
    the NEXT weapon that fires sees this client's quad state instead of
    whatever the previously-thinking client left behind.
  - `RuneWeaponThinkHook(ent)` runs immediately after the weapon's own
    weaponthink (g_runes.ts) -- this is what makes the rune powers that key
    off `client.isfiring` fire on the same frame the weapon did.
The two commented-out LM_JORM experiments in the C (auto-weapon-switch on
empty via Cmd_WeapNext_f, and a 4x weapon speed-up) are comments in the
source, so nothing to port.
=================
*/
export function Think_Weapon(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  is_quad = client.quad_framenum > level.framenum;

  // if just died, put the weapon away
  if (ent.health < 1) {
    client.newweapon = null;
    ChangeWeapon(ent);
  }

  // call active weapon think routine
  if (client.pers.weapon !== null && client.pers.weapon.weaponthink !== null) {
    is_silenced = client.silencer_shots ? MZ_SILENCED : 0;
    client.pers.weapon.weaponthink(ent);
    RuneWeaponThinkHook(ent);
  }
}

/*
================
Use_Weapon (lmctf60/p_weapon.c:345)

Make the weapon ready if there is ammo.

LM-CTF DELTA D5: both "no ammo" messages go through ctf_SafePrint (which
suppresses printing to a disconnected/bot client) instead of gi.cprintf.
The C builds the string with sprintf into a MAX_INFO_STRING buffer first;
a template literal is the direct equivalent.
================
*/
export function Use_Weapon(ent: EdictT, item: GItemT): void {
  const client = ent.client;
  if (client === null) return;

  // see if we're already using it
  if (item === client.pers.weapon) return;

  if (item.ammo !== null && item.ammo.length > 0 && !cvarNum(gameCvars.g_select_empty) && (item.flags & IT_AMMO) === 0) {
    const ammo_item = requireItem(FindItem(item.ammo));
    const ammo_index = ITEM_INDEX(ammo_item);

    if (!client.pers.inventory[ammo_index]) {
      ctf_SafePrint(ent, PRINT_HIGH, `No ${ammo_item.pickup_name} for ${item.pickup_name}.\n`);
      return;
    }

    if (client.pers.inventory[ammo_index] < item.quantity) {
      ctf_SafePrint(ent, PRINT_HIGH, `Not enough ${ammo_item.pickup_name} for ${item.pickup_name}.\n`);
      return;
    }
  }

  // change to this weapon when down
  client.newweapon = item;
}

/*
================
Drop_Weapon (lmctf60/p_weapon.c:386) -- LM-CTF DELTA D5 (ctf_SafePrint).
================
*/
export function Drop_Weapon(ent: EdictT, item: GItemT): void {
  if (dmFlags() & DF_WEAPONS_STAY) return;

  const client = ent.client;
  if (client === null) return;

  const index = ITEM_INDEX(item);
  // see if we're already using it
  if ((item === client.pers.weapon || item === client.newweapon) && client.pers.inventory[index] === 1) {
    ctf_SafePrint(ent, PRINT_HIGH, "Can't drop current weapon\n");
    return;
  }

  Drop_Item(ent, item);
  client.pers.inventory[index]--;
}

/*
================
Weapon_Generic (lmctf60/p_weapon.c:417)

A generic function to handle the basics of weapon thinking.

LM-CTF DELTA D1 -- this is a REWRITE of ZOID's version, not a tweak. Point
by point against src/ctf/p_weapon.ts:

  a. ZOID's Weapon_Generic/Weapon_Generic2 split is GONE. There is one flat
     function. The haste-driven "run the weapon frame again" second call,
     CTFApplyHaste, CTFApplyHasteSound and CTFApplyStrengthSound are all
     deleted along with it, as is the Grapple pickup_name special-case that
     kept the grapple from double-stepping. LM-CTF has runes, not techs, so
     there is no haste to re-run for.
  b. `ent->client->isfiring = 0;` is the FIRST statement, before even the
     deadflag/VWep guard -- so a corpse's client also gets isfiring cleared
     every frame. It is set back to 1 only on a frame that actually calls
     `fire`.
  c. The `instantweap` cvar is replaced by `fastswitch` everywhere, and its
     WEAPON_ACTIVATING handling is different: ZOID checks
     `gunframe == FRAME_ACTIVATE_LAST || instantweap->value` and then
     recurses into Weapon_Generic2 to instant-ready. LM-CTF instead ASSIGNS
     `gunframe = FRAME_ACTIVATE_LAST` when fastswitch is on and falls into
     the ordinary equality test, no recursion. Same end state, one frame
     of gunframe bookkeeping different.
  d. In the FIRING branch, after the fire-frame scan, LM-CTF adds a
     fastswitch fast-path in BOTH arms (matched and unmatched): if a
     newweapon is pending, zero weapon_sound and ChangeWeapon immediately
     rather than waiting for the deactivate animation.
  e. The C's post-loop test is `if (!fire_frames[n])`, reading the array
     element the loop stopped on: 0 (the terminator) means no fire frame
     matched. The TS array carries no terminator, so a `matched` boolean
     expresses the identical condition.
  f. NEW at the end of the FIRING branch ("//bat - Change the weapon right
     away!"): if the client has an ammo type and now holds less than the
     weapon's per-shot quantity, play the noammo voice (pain_debounce_time
     gated) and call NoAmmoWeaponChange. In ctf/id this check only exists
     in the READY branch on a trigger pull; here it also runs immediately
     after the shot that emptied you, so LM-CTF switches you off a dry
     weapon a full trigger-pull earlier than vanilla.
  g. ZOID guards the pause_frames scan with `if (pause_frames)`; LM-CTF
     keeps that guard. Every call site in this file passes a real array
     (Weapon_HyperBlaster passes an empty one), so the guard is always
     true here -- an empty array simply scans nothing.
================
*/
export function Weapon_Generic(
  ent: EdictT,
  FRAME_ACTIVATE_LAST: number,
  FRAME_FIRE_LAST: number,
  FRAME_IDLE_LAST: number,
  FRAME_DEACTIVATE_LAST: number,
  pause_frames: number[],
  fire_frames: number[],
  fire: (ent: EdictT) => void,
): void {
  const client = ent.client;
  if (client === null) return;

  client.isfiring = 0; // By default, we aren't firing;

  const FRAME_FIRE_FIRST = FRAME_ACTIVATE_LAST + 1;
  const FRAME_IDLE_FIRST = FRAME_FIRE_LAST + 1;
  const FRAME_DEACTIVATE_FIRST = FRAME_IDLE_LAST + 1;

  if (ent.deadflag || ent.s.modelindex !== 255) {
    // VWep animations screw up corpses
    return;
  }

  if (client.weaponstate === WeaponstateT.WEAPON_DROPPING) {
    if (client.ps.gunframe === FRAME_DEACTIVATE_LAST) {
      ChangeWeapon(ent);
      return;
    } else if (FRAME_DEACTIVATE_LAST - client.ps.gunframe === 4) {
      client.anim_priority = ANIM_REVERSE;
      if (client.ps.pmove.pm_flags & PMF_DUCKED) {
        ent.s.frame = FRAME_crpain4 + 1;
        client.anim_end = FRAME_crpain1;
      } else {
        ent.s.frame = FRAME_pain304 + 1;
        client.anim_end = FRAME_pain301;
      }
    }

    client.ps.gunframe++;
    return;
  }

  if (client.weaponstate === WeaponstateT.WEAPON_ACTIVATING) {
    // LM-CTF (D1c): fastswitch jumps straight to the last activate frame
    // instead of ctf's recursive instant-ready.
    if (cvarNum(gameCvars.fastswitch) !== 0) {
      client.ps.gunframe = FRAME_ACTIVATE_LAST;
    }

    if (client.ps.gunframe === FRAME_ACTIVATE_LAST) {
      client.weaponstate = WeaponstateT.WEAPON_READY;
      client.ps.gunframe = FRAME_IDLE_FIRST;
      return;
    }

    client.ps.gunframe++;
    return;
  }

  if (client.newweapon !== null && client.weaponstate !== WeaponstateT.WEAPON_FIRING) {
    client.weaponstate = WeaponstateT.WEAPON_DROPPING;
    if (cvarNum(gameCvars.fastswitch) !== 0) {
      ChangeWeapon(ent);
      return;
    } else {
      client.ps.gunframe = FRAME_DEACTIVATE_FIRST;
    }

    if (FRAME_DEACTIVATE_LAST - FRAME_DEACTIVATE_FIRST < 4) {
      client.anim_priority = ANIM_REVERSE;
      if (client.ps.pmove.pm_flags & PMF_DUCKED) {
        ent.s.frame = FRAME_crpain4 + 1;
        client.anim_end = FRAME_crpain1;
      } else {
        ent.s.frame = FRAME_pain304 + 1;
        client.anim_end = FRAME_pain301;
      }
    }
    return;
  }

  if (client.weaponstate === WeaponstateT.WEAPON_READY) {
    if ((client.latched_buttons | client.buttons) & BUTTON_ATTACK) {
      client.latched_buttons &= ~BUTTON_ATTACK;
      const weaponQuantity = client.pers.weapon === null ? 0 : client.pers.weapon.quantity;
      if (!client.ammo_index || client.pers.inventory[client.ammo_index] >= weaponQuantity) {
        client.ps.gunframe = FRAME_FIRE_FIRST;
        client.weaponstate = WeaponstateT.WEAPON_FIRING;

        // start the animation
        client.anim_priority = ANIM_ATTACK;
        if (client.ps.pmove.pm_flags & PMF_DUCKED) {
          ent.s.frame = FRAME_crattak1 - 1;
          client.anim_end = FRAME_crattak9;
        } else {
          ent.s.frame = FRAME_attack1 - 1;
          client.anim_end = FRAME_attack8;
        }
      } else {
        if (level.time >= ent.pain_debounce_time) {
          gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/noammo.wav"), 1, ATTN_NORM, 0);
          ent.pain_debounce_time = level.time + 1;
        }
        NoAmmoWeaponChange(ent);
      }
    } else {
      if (client.ps.gunframe === FRAME_IDLE_LAST) {
        client.ps.gunframe = FRAME_IDLE_FIRST;
        return;
      }

      for (const pf of pause_frames) {
        if (client.ps.gunframe === pf) {
          // `rand()&15` -- no integer rand() helper exists in math.ts (only
          // random()/crandom()); approximated with an equivalent uniform
          // pick: ~15/16 chance to pause, ~1/16 chance to fall through.
          if (Math.floor(Math.random() * 16) !== 0) return;
        }
      }

      client.ps.gunframe++;
      return;
    }
  }

  if (client.weaponstate === WeaponstateT.WEAPON_FIRING) {
    let matched = false;
    for (const ff of fire_frames) {
      if (client.ps.gunframe === ff) {
        // LM-CTF (D1a): ZOID's CTFApplyStrengthSound wrapper around this
        // quad sound, and the CTFApplyHasteSound call after it, are both
        // deleted -- the quad sound plays unconditionally.
        if (client.quad_framenum > level.framenum) {
          gi.sound(ent, CHAN_ITEM, gi.soundindex("items/damage3.wav"), 1, ATTN_NORM, 0);
        }

        client.isfiring = 1; // We are firing this frame
        fire(ent);
        matched = true;
        break;
      }
    }

    // LM-CTF (D1d/D1e): both arms of the C's `if (!fire_frames[n])` get the
    // same fastswitch fast-path; only the gunframe advance differs.
    if (!matched) {
      client.ps.gunframe++;
      if (client.newweapon !== null && cvarNum(gameCvars.fastswitch) !== 0) {
        client.weapon_sound = 0;
        ChangeWeapon(ent);
        return;
      }
    } else {
      if (client.newweapon !== null && cvarNum(gameCvars.fastswitch) !== 0) {
        client.weapon_sound = 0;
        ChangeWeapon(ent);
        return;
      }
    }

    if (client.ps.gunframe === FRAME_IDLE_FIRST + 1) client.weaponstate = WeaponstateT.WEAPON_READY;

    // LM-CTF (D1f) //bat - Change the weapon right away!
    if (client.ammo_index && client.pers.inventory[client.ammo_index] < (client.pers.weapon === null ? 0 : client.pers.weapon.quantity)) {
      if (level.time >= ent.pain_debounce_time) {
        gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/noammo.wav"), 1, ATTN_NORM, 0);
        ent.pain_debounce_time = level.time + 1;
      }
      NoAmmoWeaponChange(ent);
    }
  }
}

/*
======================================================================

GRENADE

======================================================================
*/

// lmctf60/p_weapon.c:614-616 -- `3.0f`/`400.0f`/`800.0f` in LM-CTF vs
// `3.0`/`400`/`800` in ctf. C float-literal suffixes only; no numeric
// difference in TS, where every number is already a double.
const GRENADE_TIMER = 3.0;
const GRENADE_MINSPEED = 400;
const GRENADE_MAXSPEED = 800;

/*
=================
weapon_grenade_fire (lmctf60/p_weapon.c:619)

LM-CTF DELTA D6: an `if (ent->health <= 0) return;` guard sits between the
deadflag/VWep guard and the throw animation. Reachable in practice: a
player killed on the exact frame their held grenade cooks off still has
deadflag/modelindex intact for one frame, and this stops the corpse from
starting a wave animation.
=================
*/
function weapon_grenade_fire(ent: EdictT, held: boolean): void {
  const client = ent.client;
  if (client === null) return;

  let damage = 125;
  const radius = damage + 40;
  if (is_quad) damage *= 4;

  const offset = vec3(8, 8, ent.viewheight - 8);
  const forward = vec3();
  const right = vec3();
  AngleVectors(client.v_angle, forward, right, null);
  const start = vec3();
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);

  const timer = client.grenade_time - level.time;
  const speed = (GRENADE_MINSPEED + (GRENADE_TIMER - timer) * ((GRENADE_MAXSPEED - GRENADE_MINSPEED) / GRENADE_TIMER)) | 0;
  fire_grenade2(ent, start, forward, damage, speed, timer, radius, held);

  if (!(dmFlags() & DF_INFINITE_AMMO)) client.pers.inventory[client.ammo_index]--;

  client.grenade_time = level.time + 1.0;

  if (ent.deadflag || ent.s.modelindex !== 255) {
    // VWep animations screw up corpses
    return;
  }

  if (ent.health <= 0) return; // LM-CTF D6

  if (client.ps.pmove.pm_flags & PMF_DUCKED) {
    client.anim_priority = ANIM_ATTACK;
    ent.s.frame = FRAME_crattak1 - 1;
    client.anim_end = FRAME_crattak3;
  } else {
    client.anim_priority = ANIM_REVERSE;
    ent.s.frame = FRAME_wave08;
    client.anim_end = FRAME_wave01;
  }
}

/*
=================
Weapon_Grenade (lmctf60/p_weapon.c:668)

LM-CTF DELTA D7: `ent->client->grenade_time = 0;` is added right after the
gunframe-12 throw. In ctf/id, grenade_time keeps the `level.time + 1.0`
weapon_grenade_fire just wrote, and the gunframe-15 hold ("don't advance
while level.time < grenade_time") stalls the animation for a second. With
it zeroed, that stall never triggers, so LM-CTF's hand grenade completes
its throw animation and returns to READY roughly a second sooner.

This function drives its own frames and never goes through Weapon_Generic,
so none of D1's changes apply here.
=================
*/
export function Weapon_Grenade(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if (client.newweapon !== null && client.weaponstate === WeaponstateT.WEAPON_READY) {
    ChangeWeapon(ent);
    return;
  }

  if (client.weaponstate === WeaponstateT.WEAPON_ACTIVATING) {
    client.weaponstate = WeaponstateT.WEAPON_READY;
    client.ps.gunframe = 16;
    return;
  }

  if (client.weaponstate === WeaponstateT.WEAPON_READY) {
    if ((client.latched_buttons | client.buttons) & BUTTON_ATTACK) {
      client.latched_buttons &= ~BUTTON_ATTACK;
      if (client.pers.inventory[client.ammo_index]) {
        client.ps.gunframe = 1;
        client.weaponstate = WeaponstateT.WEAPON_FIRING;
        client.grenade_time = 0;
      } else {
        if (level.time >= ent.pain_debounce_time) {
          gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/noammo.wav"), 1, ATTN_NORM, 0);
          ent.pain_debounce_time = level.time + 1;
        }
        NoAmmoWeaponChange(ent);
      }
      return;
    }

    if (client.ps.gunframe === 29 || client.ps.gunframe === 34 || client.ps.gunframe === 39 || client.ps.gunframe === 48) {
      // rand()&15, see the comment in Weapon_Generic
      if (Math.floor(Math.random() * 16) !== 0) return;
    }

    if (++client.ps.gunframe > 48) client.ps.gunframe = 16;
    return;
  }

  if (client.weaponstate === WeaponstateT.WEAPON_FIRING) {
    if (client.ps.gunframe === 5) gi.sound(ent, CHAN_WEAPON, gi.soundindex("weapons/hgrena1b.wav"), 1, ATTN_NORM, 0);

    if (client.ps.gunframe === 11) {
      if (!client.grenade_time) {
        client.grenade_time = level.time + GRENADE_TIMER + 0.2;
        client.weapon_sound = gi.soundindex("weapons/hgrenc1b.wav");
      }

      // they waited too long, detonate it in their hand
      if (!client.grenade_blew_up && level.time >= client.grenade_time) {
        client.weapon_sound = 0;
        weapon_grenade_fire(ent, true);
        client.grenade_blew_up = true;
      }

      if (client.buttons & BUTTON_ATTACK) return;

      if (client.grenade_blew_up) {
        if (level.time >= client.grenade_time) {
          client.ps.gunframe = 15;
          client.grenade_blew_up = false;
        } else {
          return;
        }
      }
    }

    if (client.ps.gunframe === 12) {
      client.weapon_sound = 0;
      weapon_grenade_fire(ent, false);
      client.grenade_time = 0; // LM-CTF D7
    }

    if (client.ps.gunframe === 15 && level.time < client.grenade_time) return;

    client.ps.gunframe++;

    if (client.ps.gunframe === 16) {
      client.grenade_time = 0;
      client.weaponstate = WeaponstateT.WEAPON_READY;
    }
  }
}

/*
======================================================================

GRENADE LAUNCHER

======================================================================
*/

// lmctf60/p_weapon.c:783 -- identical to ctf apart from a dropped
// WEAP_BALANCE_OK block that would have scaled radius by 1.5 and cut
// damage by 10 (never compiled; see file header).
function weapon_grenadelauncher_fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  let damage = 120;
  const radius = damage + 40;
  if (is_quad) damage *= 4;

  const offset = vec3(8, 8, ent.viewheight - 8);
  const forward = vec3();
  const right = vec3();
  AngleVectors(client.v_angle, forward, right, null);
  const start = vec3();
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);

  VectorScale(forward, -2, client.kick_origin);
  client.kick_angles[0] = -1;

  fire_grenade(ent, start, forward, damage, 600, 2.5, radius);

  gi.WriteByte(svc_muzzleflash);
  gi.WriteShort(ent.s.number);
  gi.WriteByte(MZ_GRENADE | is_silenced);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  client.ps.gunframe++;

  PlayerNoise(ent, start, PNOISE_WEAPON);

  if (!(dmFlags() & DF_INFINITE_AMMO)) client.pers.inventory[client.ammo_index]--;
}

export function Weapon_GrenadeLauncher(ent: EdictT): void {
  const pause_frames = [34, 51, 59];
  const fire_frames = [6];

  Weapon_Generic(ent, 5, 16, 59, 64, pause_frames, fire_frames, weapon_grenadelauncher_fire);
}

/*
======================================================================

ROCKET

======================================================================
*/

// lmctf60/p_weapon.c:843 -- identical to ctf apart from dropped
// WEAP_BALANCE_OK blocks (radius_damage 75 / damage_radius 240 / rocket
// speed 750; never compiled, see file header).
function Weapon_RocketLauncher_Fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  let damage = 100 + ((random() * 20.0) | 0);
  let radius_damage = 120;
  const damage_radius = 120;
  if (is_quad) {
    damage *= 4;
    radius_damage *= 4;
  }

  const forward = vec3();
  const right = vec3();
  AngleVectors(client.v_angle, forward, right, null);

  VectorScale(forward, -2, client.kick_origin);
  client.kick_angles[0] = -1;

  const offset = vec3(8, 8, ent.viewheight - 8);
  const start = vec3();
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);
  fire_rocket(ent, start, forward, damage, 650, damage_radius, radius_damage);

  // send muzzle flash
  gi.WriteByte(svc_muzzleflash);
  gi.WriteShort(ent.s.number);
  gi.WriteByte(MZ_ROCKET | is_silenced);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  client.ps.gunframe++;

  PlayerNoise(ent, start, PNOISE_WEAPON);

  if (!(dmFlags() & DF_INFINITE_AMMO)) client.pers.inventory[client.ammo_index]--;
}

export function Weapon_RocketLauncher(ent: EdictT): void {
  const pause_frames = [25, 33, 42, 50];
  const fire_frames = [5];

  Weapon_Generic(ent, 4, 12, 50, 54, pause_frames, fire_frames, Weapon_RocketLauncher_Fire);
}

/*
======================================================================

BLASTER / HYPERBLASTER

======================================================================
*/

// lmctf60/p_weapon.c:923 -- unchanged from ctf.
function Blaster_Fire(ent: EdictT, g_offset: Vec3, damage: number, hyper: boolean, effect: number): void {
  const client = ent.client;
  if (client === null) return;

  if (is_quad) damage *= 4;
  const forward = vec3();
  const right = vec3();
  AngleVectors(client.v_angle, forward, right, null);
  const offset = vec3(24, 8, ent.viewheight - 8);
  VectorAdd(offset, g_offset, offset);
  const start = vec3();
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);

  VectorScale(forward, -2, client.kick_origin);
  client.kick_angles[0] = -1;

  fire_blaster(ent, start, forward, damage, 1000, effect, hyper);

  // send muzzle flash
  gi.WriteByte(svc_muzzleflash);
  gi.WriteShort(ent.s.number);
  if (hyper) gi.WriteByte(MZ_HYPERBLASTER | is_silenced);
  else gi.WriteByte(MZ_BLASTER | is_silenced);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  PlayerNoise(ent, start, PNOISE_WEAPON);
}

// lmctf60/p_weapon.c:954 -- identical to ctf apart from a dropped
// WEAP_BALANCE_OK block that would have double-stepped the first gunframe.
function Weapon_Blaster_Fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const damage = cvarNum(gameCvars.deathmatch) ? 15 : 10;
  Blaster_Fire(ent, vec3_origin, damage, false, EF_BLASTER);
  client.ps.gunframe++;
}

export function Weapon_Blaster(ent: EdictT): void {
  const pause_frames = [19, 32];
  const fire_frames = [5];

  Weapon_Generic(ent, 4, 8, 52, 55, pause_frames, fire_frames, Weapon_Blaster_Fire);
}

// lmctf60/p_weapon.c:993 -- identical to ctf apart from (a) the rotation
// expression written with float literals (`(gunframe - 5.0) * 2.0 * M_PI /
// 6.0`), same value, and (b) a dropped WEAP_BALANCE_OK `damage = 12`.
function Weapon_HyperBlaster_Fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  client.weapon_sound = gi.soundindex("weapons/hyprbl1a.wav");

  if (!(client.buttons & BUTTON_ATTACK)) {
    client.ps.gunframe++;
  } else {
    if (!client.pers.inventory[client.ammo_index]) {
      if (level.time >= ent.pain_debounce_time) {
        gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/noammo.wav"), 1, ATTN_NORM, 0);
        ent.pain_debounce_time = level.time + 1;
      }
      NoAmmoWeaponChange(ent);
    } else {
      const rotation = ((client.ps.gunframe - 5.0) * 2.0 * Math.PI) / 6.0;
      const offset = vec3(-4 * Math.sin(rotation), 0, 4 * Math.cos(rotation));

      const effect = client.ps.gunframe === 6 || client.ps.gunframe === 9 ? EF_HYPERBLASTER : 0;
      const damage = cvarNum(gameCvars.deathmatch) ? 15 : 20;
      Blaster_Fire(ent, offset, damage, true, effect);
      if (!(dmFlags() & DF_INFINITE_AMMO)) client.pers.inventory[client.ammo_index]--;

      client.anim_priority = ANIM_ATTACK;
      if (client.ps.pmove.pm_flags & PMF_DUCKED) {
        ent.s.frame = FRAME_crattak1 - 1;
        client.anim_end = FRAME_crattak9;
      } else {
        ent.s.frame = FRAME_attack1 - 1;
        client.anim_end = FRAME_attack8;
      }
    }

    client.ps.gunframe++;
    if (client.ps.gunframe === 12 && client.pers.inventory[client.ammo_index]) client.ps.gunframe = 6;
  }

  if (client.ps.gunframe === 12) {
    gi.sound(ent, CHAN_AUTO, gi.soundindex("weapons/hyprbd1a.wav"), 1, ATTN_NORM, 0);
    client.weapon_sound = 0;
  }
}

export function Weapon_HyperBlaster(ent: EdictT): void {
  const pause_frames: number[] = [];
  const fire_frames = [6, 7, 8, 9, 10, 11];

  Weapon_Generic(ent, 5, 20, 49, 53, pause_frames, fire_frames, Weapon_HyperBlaster_Fire);
}

/*
======================================================================

MACHINEGUN / CHAINGUN

======================================================================
*/

/*
=================
Machinegun_Fire (lmctf60/p_weapon.c:1084)

Identical to ctf apart from dropped WEAP_BALANCE_OK blocks (damage 9 and
+100/+100 extra bullet spread; never compiled, see file header).

Exported because the item table names it directly as the machinegun's
weaponthink in some builds, and because this unit's test brief covers it.
=================
*/
export function Machinegun_Fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  let damage = 8;
  let kick = 2;

  if (!(client.buttons & BUTTON_ATTACK)) {
    client.machinegun_shots = 0;
    client.ps.gunframe++;
    return;
  }

  if (client.ps.gunframe === 5) client.ps.gunframe = 4;
  else client.ps.gunframe = 5;

  if (client.pers.inventory[client.ammo_index] < 1) {
    client.ps.gunframe = 6;
    if (level.time >= ent.pain_debounce_time) {
      gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/noammo.wav"), 1, ATTN_NORM, 0);
      ent.pain_debounce_time = level.time + 1;
    }
    NoAmmoWeaponChange(ent);
    return;
  }

  if (is_quad) {
    damage *= 4;
    kick *= 4;
  }

  for (let i = 1; i < 3; i++) {
    client.kick_origin[i] = crandom() * 0.35;
    client.kick_angles[i] = crandom() * 0.7;
  }
  client.kick_origin[0] = crandom() * 0.35;
  client.kick_angles[0] = client.machinegun_shots * -1.5;

  // raise the gun as it is firing
  if (!cvarNum(gameCvars.deathmatch)) {
    client.machinegun_shots++;
    if (client.machinegun_shots > 9) client.machinegun_shots = 9;
  }

  // get start / end positions
  const angles = vec3();
  VectorAdd(client.v_angle, client.kick_angles, angles);
  const forward = vec3();
  const right = vec3();
  AngleVectors(angles, forward, right, null);
  const offset = vec3(0, 8, ent.viewheight - 8);
  const start = vec3();
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);
  fire_bullet(ent, start, forward, damage, kick, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, MOD_MACHINEGUN);

  gi.WriteByte(svc_muzzleflash);
  gi.WriteShort(ent.s.number);
  gi.WriteByte(MZ_MACHINEGUN | is_silenced);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  PlayerNoise(ent, start, PNOISE_WEAPON);

  if (!(dmFlags() & DF_INFINITE_AMMO)) client.pers.inventory[client.ammo_index]--;

  client.anim_priority = ANIM_ATTACK;
  if (client.ps.pmove.pm_flags & PMF_DUCKED) {
    ent.s.frame = FRAME_crattak1 - ((random() + 0.25) | 0);
    client.anim_end = FRAME_crattak9;
  } else {
    ent.s.frame = FRAME_attack1 - ((random() + 0.25) | 0);
    client.anim_end = FRAME_attack8;
  }
}

export function Weapon_Machinegun(ent: EdictT): void {
  const pause_frames = [23, 45];
  const fire_frames = [4, 5];

  Weapon_Generic(ent, 3, 5, 45, 49, pause_frames, fire_frames, Machinegun_Fire);
}

// lmctf60/p_weapon.c:1194 -- unchanged from ctf.
function Chaingun_Fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  let kick = 2;
  let damage = cvarNum(gameCvars.deathmatch) ? 6 : 8;

  if (client.ps.gunframe === 5) gi.sound(ent, CHAN_AUTO, gi.soundindex("weapons/chngnu1a.wav"), 1, ATTN_IDLE, 0);

  if (client.ps.gunframe === 14 && !(client.buttons & BUTTON_ATTACK)) {
    client.ps.gunframe = 32;
    client.weapon_sound = 0;
    return;
  } else if (client.ps.gunframe === 21 && client.buttons & BUTTON_ATTACK && client.pers.inventory[client.ammo_index]) {
    client.ps.gunframe = 15;
  } else {
    client.ps.gunframe++;
  }

  if (client.ps.gunframe === 22) {
    client.weapon_sound = 0;
    gi.sound(ent, CHAN_AUTO, gi.soundindex("weapons/chngnd1a.wav"), 1, ATTN_IDLE, 0);
  } else {
    client.weapon_sound = gi.soundindex("weapons/chngnl1a.wav");
  }

  client.anim_priority = ANIM_ATTACK;
  if (client.ps.pmove.pm_flags & PMF_DUCKED) {
    ent.s.frame = FRAME_crattak1 - (client.ps.gunframe & 1);
    client.anim_end = FRAME_crattak9;
  } else {
    ent.s.frame = FRAME_attack1 - (client.ps.gunframe & 1);
    client.anim_end = FRAME_attack8;
  }

  let shots: number;
  if (client.ps.gunframe <= 9) shots = 1;
  else if (client.ps.gunframe <= 14) shots = client.buttons & BUTTON_ATTACK ? 2 : 1;
  else shots = 3;

  if (client.pers.inventory[client.ammo_index] < shots) shots = client.pers.inventory[client.ammo_index];

  if (!shots) {
    if (level.time >= ent.pain_debounce_time) {
      gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/noammo.wav"), 1, ATTN_NORM, 0);
      ent.pain_debounce_time = level.time + 1;
    }
    NoAmmoWeaponChange(ent);
    return;
  }

  if (is_quad) {
    damage *= 4;
    kick *= 4;
  }

  for (let i = 0; i < 3; i++) {
    client.kick_origin[i] = crandom() * 0.35;
    client.kick_angles[i] = crandom() * 0.7;
  }

  const forward = vec3();
  const right = vec3();
  const up = vec3();
  let start = vec3();
  for (let i = 0; i < shots; i++) {
    // get start / end positions
    AngleVectors(client.v_angle, forward, right, up);
    const r = 7 + crandom() * 4;
    const u = crandom() * 4;
    const offset = vec3(0, r, u + ent.viewheight - 8);
    start = vec3();
    P_ProjectSource(client, ent.s.origin, offset, forward, right, start);

    fire_bullet(ent, start, forward, damage, kick, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, MOD_CHAINGUN);
  }

  // send muzzle flash
  gi.WriteByte(svc_muzzleflash);
  gi.WriteShort(ent.s.number);
  gi.WriteByte((MZ_CHAINGUN1 + shots - 1) | is_silenced);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  PlayerNoise(ent, start, PNOISE_WEAPON);

  if (!(dmFlags() & DF_INFINITE_AMMO)) client.pers.inventory[client.ammo_index] -= shots;
}

export function Weapon_Chaingun(ent: EdictT): void {
  const pause_frames = [38, 43, 51, 61];
  const fire_frames = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];

  Weapon_Generic(ent, 4, 31, 61, 64, pause_frames, fire_frames, Chaingun_Fire);
}

/*
======================================================================

SHOTGUN / SUPERSHOTGUN

======================================================================
*/

// lmctf60/p_weapon.c:1331 -- identical to ctf apart from a dropped
// WEAP_BALANCE_OK block (+1 damage, +2 pellets via a `count` local that,
// with the block dead, stays 0 and adds nothing).
function weapon_shotgun_fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  let damage = 4;
  let kick = 8;

  if (client.ps.gunframe === 9) {
    client.ps.gunframe++;
    return;
  }

  const forward = vec3();
  const right = vec3();
  AngleVectors(client.v_angle, forward, right, null);

  VectorScale(forward, -2, client.kick_origin);
  client.kick_angles[0] = -2;

  const offset = vec3(0, 8, ent.viewheight - 8);
  const start = vec3();
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);

  if (is_quad) {
    damage *= 4;
    kick *= 4;
  }

  if (cvarNum(gameCvars.deathmatch)) {
    fire_shotgun(ent, start, forward, damage, kick, 500, 500, DEFAULT_DEATHMATCH_SHOTGUN_COUNT, MOD_SHOTGUN);
  } else {
    fire_shotgun(ent, start, forward, damage, kick, 500, 500, DEFAULT_SHOTGUN_COUNT, MOD_SHOTGUN);
  }

  // send muzzle flash
  gi.WriteByte(svc_muzzleflash);
  gi.WriteShort(ent.s.number);
  gi.WriteByte(MZ_SHOTGUN | is_silenced);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  client.ps.gunframe++;
  PlayerNoise(ent, start, PNOISE_WEAPON);

  if (!(dmFlags() & DF_INFINITE_AMMO)) client.pers.inventory[client.ammo_index]--;
}

export function Weapon_Shotgun(ent: EdictT): void {
  const pause_frames = [22, 28, 34];
  const fire_frames = [8, 9];

  Weapon_Generic(ent, 7, 18, 36, 39, pause_frames, fire_frames, weapon_shotgun_fire);
}

// lmctf60/p_weapon.c:1517 -- identical to ctf apart from a dropped
// WEAP_BALANCE_OK block (count 12 / damage -3 via a `count` local that
// stays 0 with the block dead).
function weapon_supershotgun_fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  let damage = 6;
  let kick = 12;

  const forward = vec3();
  const right = vec3();
  AngleVectors(client.v_angle, forward, right, null);

  VectorScale(forward, -2, client.kick_origin);
  client.kick_angles[0] = -2;

  const offset = vec3(0, 8, ent.viewheight - 8);
  const start = vec3();
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);

  if (is_quad) {
    damage *= 4;
    kick *= 4;
  }

  const v = vec3();
  v[PITCH] = client.v_angle[PITCH];
  v[YAW] = client.v_angle[YAW] - 5;
  v[ROLL] = client.v_angle[ROLL];
  AngleVectors(v, forward, null, null);
  fire_shotgun(ent, start, forward, damage, kick, DEFAULT_SHOTGUN_HSPREAD, DEFAULT_SHOTGUN_VSPREAD, DEFAULT_SSHOTGUN_COUNT / 2, MOD_SSHOTGUN);
  v[YAW] = client.v_angle[YAW] + 5;
  AngleVectors(v, forward, null, null);
  fire_shotgun(ent, start, forward, damage, kick, DEFAULT_SHOTGUN_HSPREAD, DEFAULT_SHOTGUN_VSPREAD, DEFAULT_SSHOTGUN_COUNT / 2, MOD_SSHOTGUN);

  // send muzzle flash
  gi.WriteByte(svc_muzzleflash);
  gi.WriteShort(ent.s.number);
  gi.WriteByte(MZ_SSHOTGUN | is_silenced);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  client.ps.gunframe++;
  PlayerNoise(ent, start, PNOISE_WEAPON);

  if (!(dmFlags() & DF_INFINITE_AMMO)) client.pers.inventory[client.ammo_index] -= 2;
}

export function Weapon_SuperShotgun(ent: EdictT): void {
  const pause_frames = [29, 42, 57];
  const fire_frames = [7];

  Weapon_Generic(ent, 6, 17, 57, 61, pause_frames, fire_frames, weapon_supershotgun_fire);
}

/*
======================================================================

RAILGUN

======================================================================
*/

/*
=================
weapon_railgun_fire (lmctf60/p_weapon.c:1589)

LM-CTF DELTA D8: a new FIRST branch -- during MATCH_RAILGUN_INPLAY the shot
does 5000 damage and 5000 kick, i.e. an instant kill with an enormous
launch. This is the whole point of the railgun round; it takes priority
over the deathmatch/single-player damage split below it. Quad still
multiplies it by 4 (20000/20000), exactly as the C does.

The dead WEAP_BALANCE_OK dm tuning (82/125) is dropped; the live dm values
stay id's 100/200.
=================
*/
function weapon_railgun_fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  let damage: number;
  let kick: number;
  if (matchstate === MatchStatesT.MATCH_RAILGUN_INPLAY) {
    damage = 5000;
    kick = 5000;
  } else if (cvarNum(gameCvars.deathmatch)) {
    // normal damage is too extreme in dm
    damage = 100;
    kick = 200;
  } else {
    damage = 150;
    kick = 250;
  }

  if (is_quad) {
    damage *= 4;
    kick *= 4;
  }

  const forward = vec3();
  const right = vec3();
  AngleVectors(client.v_angle, forward, right, null);

  VectorScale(forward, -3, client.kick_origin);
  client.kick_angles[0] = -3;

  const offset = vec3(0, 7, ent.viewheight - 8);
  const start = vec3();
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);
  fire_rail(ent, start, forward, damage, kick);

  // send muzzle flash
  gi.WriteByte(svc_muzzleflash);
  gi.WriteShort(ent.s.number);
  gi.WriteByte(MZ_RAILGUN | is_silenced);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  client.ps.gunframe++;
  PlayerNoise(ent, start, PNOISE_WEAPON);

  if (!(dmFlags() & DF_INFINITE_AMMO)) client.pers.inventory[client.ammo_index]--;
}

export function Weapon_Railgun(ent: EdictT): void {
  const pause_frames = [56];
  const fire_frames = [4];

  Weapon_Generic(ent, 3, 18, 56, 61, pause_frames, fire_frames, weapon_railgun_fire);
}

/*
======================================================================

BFG10K

======================================================================
*/

/*
=================
weapon_bfg_fire (lmctf60/p_weapon.c:1674)

LM-CTF DELTA D9: the gunframe-9 windup branch calls
`PlayerNoise(ent, start, PNOISE_WEAPON)` where ctf/id call
`PlayerNoise(ent, ent->s.origin, PNOISE_WEAPON)`. `start` is a bare
`vec3_t` local that P_ProjectSource has not written yet on that code path,
so LM-CTF replaced a correct origin with an UNINITIALIZED C stack read.
A zero vector is the closest deterministic TS stand-in (same treatment
src/ctf/p_weapon.ts already applies to the identical uninitialized-`start`
read further down its own version of this function). Preserved on purpose.

The dead WEAP_BALANCE_OK tuning (damage 180, radius 1200, speed 180) is
dropped; live values stay id's.
=================
*/
function weapon_bfg_fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  // C: `vec3_t offset, start;` declared at the top of the function; the
  // gunframe===9 branch below reads `start` before P_ProjectSource ever
  // assigns it -- see this function's doc comment.
  const start = vec3();

  const damage_radius = 1000;
  let damage = cvarNum(gameCvars.deathmatch) ? 200 : 500;

  if (client.ps.gunframe === 9) {
    // send muzzle flash
    gi.WriteByte(svc_muzzleflash);
    gi.WriteShort(ent.s.number);
    gi.WriteByte(MZ_BFG | is_silenced);
    gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

    client.ps.gunframe++;

    PlayerNoise(ent, start, PNOISE_WEAPON); // LM-CTF D9
    return;
  }

  // cells can go down during windup (from power armor hits), so
  // check again and abort firing if we don't have enough now
  if (client.pers.inventory[client.ammo_index] < 50) {
    client.ps.gunframe++;
    return;
  }

  if (is_quad) damage *= 4;

  const forward = vec3();
  const right = vec3();
  AngleVectors(client.v_angle, forward, right, null);

  VectorScale(forward, -2, client.kick_origin);

  // make a big pitch kick with an inverse fall
  client.v_dmg_pitch = -40;
  client.v_dmg_roll = crandom() * 8;
  client.v_dmg_time = level.time + DAMAGE_TIME;

  const offset = vec3(8, 8, ent.viewheight - 8);
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);
  fire_bfg(ent, start, forward, damage, 400, damage_radius);

  client.ps.gunframe++;

  PlayerNoise(ent, start, PNOISE_WEAPON);

  if (!(dmFlags() & DF_INFINITE_AMMO)) client.pers.inventory[client.ammo_index] -= 50;
}

export function Weapon_BFG(ent: EdictT): void {
  const pause_frames = [39, 45, 50, 55];
  const fire_frames = [9, 17];

  Weapon_Generic(ent, 8, 32, 55, 58, pause_frames, fire_frames, weapon_bfg_fire);
}

//======================================================================

// CTF CODE -- LM_JORM
// (lmctf60/p_weapon.c:1760 onward -- the grapple. Unchanged from the prior
// partial port of this file except that Weapon_Hook is now real.)

/*
=================
hook_touch (lmctf60/p_weapon.c:1772)

Touch handler for the flying/attached hook bolt. Ignores touching its own
owner. Once a hook_target is locked, ignores touches from anything else
(ctf_touch is exclusive to whatever it first grabbed). Aborts (frees the
hook) if what it touched is not a player, bodyque, worldspawn, a "func"-
prefixed classname, or an "info_flag"-prefixed classname, or if it hit the
sky, a teammate, or a dead body.
Otherwise: zeroes the bolt's velocity, transitions the owner's hookstate to
2 ("pulling") the first time it registers a hit, deals damage (gated by
CTF_NO_GRAP_DAMAGE, always allowed against non-clients) -- 8/8 bonus damage
on the FIRST hit of a given target, or 1/1 every 7th frame while
continuously latched onto the SAME target -- aborts again if the target
died from that damage, and otherwise (first-ever touch of this target)
captures `hook_offset` (the bolt's current offset from the target's
absmin) and switches the bolt to SOLID_TRIGGER so it can keep "touching"
a target it is now riding along with. Always broadcasts a TE_BLASTER
sprite at the impact point.
=================
*/
export function hook_touch(self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  // C: `if (!other) return;` -- defensive; EdictT.touch's signature is
  // non-nullable (see traceEdict's world-edict fallback above), so this
  // condition cannot occur through this port's call paths. Preserved as a
  // citation, not a live branch.
  if (other === self.owner) return; // we hit ourselves, ignore us
  if (self.hook_target !== null && self.hook_target !== other) return; // already have a target

  const classname = other.classname ?? "";
  if (
    classname !== "bodyque" &&
    !ctf_validateplayer(other, CTF_TEAM_ANYTEAM) &&
    classname !== "worldspawn" &&
    !classname.startsWith("func") &&
    !classname.startsWith("info_flag")
  ) {
    ctf_hook_abort(self.owner);
    return;
  }

  const owner = self.owner;
  if (
    (surf !== null && (surf.flags & SURF_SKY) !== 0) ||
    (other.client !== null && owner !== null && owner.client !== null && owner.client.ctf.teamnum === other.client.ctf.teamnum) ||
    other.deadflag !== 0
  ) {
    ctf_hook_abort(owner);
    return;
  }

  VectorClear(self.velocity);

  if (owner !== null && owner.client !== null) {
    if (owner.client.hookstate === 1) {
      // have we just hit? (sound cues commented out in the C source itself)
    }
    owner.client.hookstate = 2;
  }

  const ctfflags = gameCvars.ctfflags?.value ?? 0;
  if ((ctfflags & CTF_NO_GRAP_DAMAGE) === 0 || other.client === null) {
    if (self.hook_target === other) {
      if (level.framenum % 7 === 0 && level.framenum !== self.hook_lastframe) {
        if (ctf_validateplayer(other, CTF_TEAM_ANYTEAM)) {
          gi.sound(self, CHAN_AUTO, gi.soundindex("weapons/grapple/gkilling.wav"), 1, ATTN_NORM, 0);
        }
        if (owner !== null) {
          T_Damage(other, self, owner, self.velocity, self.s.origin, plane !== null ? plane.normal : vec3_origin, 1, 1, DAMAGE_ENERGY, MOD_CTF_GRAPPLE);
        }
        self.hook_lastframe = level.framenum;
      }
    } else {
      if (ctf_validateplayer(other, CTF_TEAM_ANYTEAM)) {
        gi.sound(self, CHAN_AUTO, gi.soundindex("weapons/grapple/ghit.wav"), 1, ATTN_NORM, 0);
      } else {
        gi.sound(self, CHAN_AUTO, gi.soundindex("weapons/grapple/ghitwall.wav"), 0.8, ATTN_NORM, 0);
      }
      if (owner !== null) {
        T_Damage(other, self, owner, self.velocity, self.s.origin, plane !== null ? plane.normal : vec3_origin, 8, 8, DAMAGE_ENERGY, MOD_CTF_GRAPPLE);
      }
    }
  }

  if (other.deadflag !== 0) {
    ctf_hook_abort(owner);
    return;
  }

  if (self.hook_target === null) {
    self.hook_target = other;
    const dest = vec3();
    VectorSubtract(self.s.origin, other.absmin, dest);
    VectorCopy(dest, self.hook_offset);
    self.solid = SolidT.SOLID_TRIGGER;
    gi.linkentity(self);
  }

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_BLASTER);
  gi.WritePosition(self.s.origin);
  gi.WriteDir(plane === null ? vec3_origin : plane.normal);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);
}

/*
=================
Grapple_Bolt_Think (lmctf60/p_weapon.c:1877)

Periodic sound-cue think, independent of the actual physics: plays an
"in flight" sound every 0.4s while nothing is latched and hooklength > 126,
a "retracting" sound every 0.8s once something IS latched and
hooklength > 126, and stops re-scheduling itself entirely (no sound) once
hooklength drops to <= 126 -- so a hook fired and immediately retrieved at
close range goes silent, matching the C source exactly (this is NOT tied to
the live current distance during pulling, only to the last value
Weapon_Hook_Fire wrote into hooklength).
=================
*/
export function Grapple_Bolt_Think(self: EdictT): void {
  const owner = self.owner;
  const hooklength = owner !== null && owner.client !== null ? owner.client.hooklength : 0;

  if (self.hook_target === null && hooklength > 126) {
    gi.sound(self, CHAN_AUTO, gi.soundindex("weapons/grapple/gflyair.wav"), 1, ATTN_NORM, 0);
    self.nextthink = level.time + 0.4;
    self.think = Grapple_Bolt_Think;
  } else if (hooklength > 126) {
    gi.sound(self, CHAN_AUTO, gi.soundindex("weapons/grapple/gpulling.wav"), 1, ATTN_NORM, 0);
    self.nextthink = level.time + 0.8;
    self.think = Grapple_Bolt_Think;
  } else {
    self.nextthink = 0;
    self.think = null;
  }
}

/*
=================
hook_die (lmctf60/p_weapon.c:1903) -- shot down (health 59, dmg 2): just
aborts the owner's hook.
=================
*/
export function hook_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3): void {
  ctf_hook_abort(self.owner);
}

/*
=================
fire_hook (lmctf60/p_weapon.c:1908)

Spawns the hook bolt: MOVETYPE_FLYMISSILE, MASK_SHOT clipmask, zero-size
bbox, 59 health / takes 2 damage per hit (so 30 direct hits would down it),
1-tick-delayed Grapple_Bolt_Think. If the initial trace from the firer to
the spawn point is already blocked (`tr.fraction < 1.0`), immediately backs
the bolt up 10 units along `dir` and calls hook_touch on whatever it hit
right there -- this is how a hook fired point-blank into a wall/player
registers on the very first frame instead of waiting for its next physics
tick.
=================
*/
export function fire_hook(self: EdictT, start: Vec3, dirIn: Vec3, speed: number): EdictT {
  const dir = vec3();
  VectorCopy(dirIn, dir);
  VectorNormalize(dir);

  const bolt = G_Spawn();
  VectorCopy(start, bolt.s.origin);
  VectorCopy(start, bolt.s.old_origin);
  vectoangles(dir, bolt.s.angles);
  bolt.s.angles[PITCH] += 90;
  VectorScale(dir, speed, bolt.velocity);
  bolt.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  bolt.clipmask = MASK_SHOT;
  bolt.solid = SolidT.SOLID_BBOX;
  VectorClear(bolt.mins);
  VectorClear(bolt.maxs);
  bolt.s.modelindex = gi.modelindex("models/objects/ghook/tris.md2");
  bolt.owner = self;
  bolt.touch = hook_touch;
  bolt.die = hook_die;
  bolt.nextthink = level.time + 1;
  bolt.think = Grapple_Bolt_Think;
  bolt.dmg = 2;
  bolt.takedamage = 1; // DamageT.DAMAGE_YES
  bolt.health = 59;
  gi.linkentity(bolt);

  gi.sound(self, CHAN_AUTO, gi.soundindex("weapons/grapple/grfire.wav"), 0.8, ATTN_NORM, 0);

  const tr = gi.trace(self.s.origin, null, null, bolt.s.origin, self, MASK_SHOT);
  if (tr.fraction < 1.0) {
    VectorMA(bolt.s.origin, -10, dir, bolt.s.origin);
    if (bolt.touch) bolt.touch(bolt, traceEdict(tr.ent), null, null);
  }
  return bolt;
}

/*
=================
Draw_Hook (lmctf60/p_weapon.c:1971)

Broadcasts the TE_GRAPPLE_CABLE temp-entity effect from `start` to `end`,
but ONLY once the cable is longer than 64 units -- a hook that has already
reeled the player in close stops drawing its line, matching the C source's
early-out. `ent` identifies whose cable this is on the wire (the owning
player's edict index).

The C source also computes `mins`/`maxs` (-15/15 cube) via its local `tv()`
helper but never reads them anywhere in the function body -- genuinely dead
local computation, not an #ifdef branch, so per the same reasoning this
port already applies to Draw_Hook's sibling dead-write fields (see
g_local.ts's hookend comment), it is not reproduced.
=================
*/
export function Draw_Hook(ent: EdictT, start: Vec3, end: Vec3): void {
  const dir = vec3();
  const offset = vec3();
  VectorSubtract(end, start, dir);
  VectorSet(offset, 0, 0, 0);

  if (VectorLength(dir) > 64) {
    gi.WriteByte(svc_temp_entity);
    gi.WriteByte(TempEventT.TE_GRAPPLE_CABLE);
    // `ent - g_edicts` (pointer offset) -- see G_InitEdict's identical note;
    // `s.number` is stamped at allocation time, matching the rest of this
    // port's `ent - g_edicts -> ent.s.number` convention.
    gi.WriteShort(ent.s.number);
    gi.WritePosition(start);
    gi.WritePosition(end);
    gi.WritePosition(offset);
    gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);
  }
}

/*
=================
Weapon_Hook_Fire (lmctf60/p_weapon.c:1999) -- THE OFFHAND HOOK'S FIRE/PULL
STATE MACHINE.

Called every server frame while `client.hookstate !== 0`, from EITHER:
  - Cmd_Hook_f (g_cmds.ts), the very first time (hookstate transitions
    0 -> 1 inside this function itself), when the hook is fired offhand;
  - p_view.ts's ClientEndServerFrame, every subsequent frame, as long as
    hookstate stays non-zero (this is what makes it "offhand": it runs
    independent of the equipped weapon's own think dispatch);
  - Weapon_Generic's fire callback, when the grapple is the EQUIPPED weapon
    (Weapon_Hook passes this function as `fire`).

`client.isfiring` is unconditionally zeroed at the top and only set back to
1 in the hookstate-0 branch -- so despite running every frame, this only
counts as "firing" (for g_runes.ts's isfiring-gated hooks) on the exact
frame the hook launches, not while it is flying or pulling.

State machine (`client.hookstate`):
  0 (idle/starting): capture `hookangle` from the current view angle (a
     write-only field -- see g_local.ts's GClientT.hookangle comment, it is
     never read again anywhere in lmctf60), apply a small view-kick
     (`kick_origin`/`kick_angles[0] = -1`), advance to state 1, spawn the
     bolt via fire_hook at GRAPPLE_FIRE_HOOK_SPEED (800 u/s), and draw the
     cable immediately (falls through to case 1 in the same call -- the C
     source has no `break` after case 0, preserved here as an explicit
     fallthrough).
  1 (bolt in flight): just keep drawing the cable from the player to the
     bolt's current position.
  2 (pulling, hook_target locked): recompute the bolt's rendered position
     from `hook_target.absmin + hook_offset` (tracks a moving target),
     redraw the cable, then compute `dir` = bolt position - muzzle start
     and `speed` = |dir| (this is DISTANCE, reused as a velocity-shaping
     input, not literally a speed). `hooklength` is updated to this
     distance every frame (there is no smoothing). Velocity is then banded
     by distance:
       > 120:  dir scaled to GRAPPLE_FIRE_HOOK_SPEED magnitude (800); this
               branch also calls addGravity(ent) (SV_AddGravity in the C
               source), BUT -- confirmed by direct testing, a real,
               preserved C-source bug, not a porting error -- addGravity's
               write to `ent.velocity[2]` is unconditionally overwritten a
               few lines later by `VectorCopy(dir, ent.velocity)`, which
               every band (including this one) falls through to. Gravity is
               genuinely invoked here but its effect on velocity never
               survives to the end of the function; only in this band, and
               nowhere else, is gravity even nominally attempted.
       100-120: dir scaled to distance*5 (grows with distance, no gravity)
       80-100:  dir scaled to distance*4
       40-80:   dir scaled to distance*3
       20-40:   dir scaled to distance*2
       10-20:   dir scaled to distance*1
       <=10:    no band matches; `dir` stays a UNIT vector (magnitude ~1)
                from the prior VectorNormalize -- an intentionally tiny
                but non-zero pull that never fully "locks" the player in
                place the way ThreeWave's HANG state does.
     The result is copied into both `ent.velocity` and
     `client.oldvelocity` (the latter specifically to suppress fall
     damage on release, per the C comment).
  default: treated as a bug in the C source; aborts the hook.
=================
*/
export function Weapon_Hook_Fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  client.isfiring = 0;

  if (client.hookstate === 0) {
    VectorCopy(client.v_angle, client.hookangle);
  }

  const forward = vec3();
  const right = vec3();
  const offset = vec3();
  const start = vec3();
  AngleVectors(client.v_angle, forward, right, null);
  VectorSet(offset, 8, 8, ent.viewheight - 8);
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);

  switch (client.hookstate) {
    case 0: {
      VectorScale(forward, -2, client.kick_origin);
      client.kick_angles[0] = -1;
      client.hookstate = 1;
      client.isfiring = 1;

      client.hook = fire_hook(ent, start, forward, GRAPPLE_FIRE_HOOK_SPEED);
      Draw_Hook(ent, start, client.hook.s.origin);
      // fallthrough to case 1, exactly like the C source (no `break`)
    }
    // eslint-disable-next-line no-fallthrough
    case 1: {
      if (client.hook !== null) {
        Draw_Hook(ent, start, client.hook.s.origin);
      }
      break;
    }
    case 2: {
      const hook = client.hook;
      if (hook !== null) {
        if (hook.hook_target !== null) {
          const dest = vec3();
          VectorAdd(hook.hook_target.absmin, hook.hook_offset, dest);
          VectorCopy(dest, hook.s.origin);
        }
        Draw_Hook(ent, start, hook.s.origin);

        const dir = vec3();
        VectorSubtract(hook.s.origin, start, dir);
        const speed = VectorLength(dir);

        if (!client.hooklength) client.hooklength = speed;
        client.hooklength = speed;
        VectorNormalize(dir);

        if (speed > 120) {
          VectorScale(dir, GRAPPLE_PULL_SPEED, dir);
          addGravity(ent);
        } else if (speed > 100) {
          VectorScale(dir, speed * 5, dir);
        } else if (speed > 80) {
          VectorScale(dir, speed * 4, dir);
        } else if (speed > 40) {
          VectorScale(dir, speed * 3, dir);
        } else if (speed > 20) {
          VectorScale(dir, speed * 2, dir);
        } else if (speed > 10) {
          VectorScale(dir, speed * 1, dir);
        }

        VectorCopy(dir, ent.velocity);
        VectorCopy(ent.velocity, client.oldvelocity);
      } else {
        client.hookstate = 0;
      }
      break;
    }
    default:
      ctf_hook_abort(ent);
      break;
  }
}

// `SV_AddGravity` (g_phys.c, not yet ported to src/lmctf) -- ported inline
// here as the one-line function it is everywhere else in this codebase
// (see src/ctf/g_phys.ts's SV_AddGravity), rather than pulling in the rest
// of g_phys.c for a single call site. Reported as a follow-up to replace
// with a real import once src/lmctf/g_phys.ts exists.
function addGravity(ent: EdictT): void {
  const sv_gravity = gameCvars.sv_gravity;
  const gravityValue = sv_gravity === null ? 800 : sv_gravity.value;
  ent.velocity[2] -= ent.gravity * gravityValue * 0.1; // FRAMETIME
}

/*
=================
Weapon_Hook (lmctf60/p_weapon.c:2116) -- the grapple as an EQUIPPED weapon.

Previously a throwing stub in this port (Weapon_Generic did not exist);
now real. Reached when the grapple is the client's current weapon, i.e.
after "use Grappling Hook" in non-offhand mode, or if a player manually
switches to it even while CTF_OFFHAND_HOOK is on.

Three things happen before the generic frame driver runs:
  - WEAPON_ACTIVATING gets an extra `gunframe += 1` ("Speed up activation"),
    on top of the increment Weapon_Generic itself will do this frame.
  - a pending newweapon forces WEAPON_DROPPING and jumps straight to
    gunframe 36 (the C hard-codes 36 with a `//FRAME_DEACTIVATE_FIRST`
    comment -- FRAME_IDLE_LAST is 34, so FRAME_DEACTIVATE_FIRST would be
    35; the literal 36 is off by one from the macro it cites. Preserved as
    written).
  - releasing +attack (neither latched nor held) calls ctf_hook_abort
    EVERY frame, which is what makes the equipped grapple retract the
    instant you let go.
The commented-out `weaponstate == WEAPON_READY -> hookstate = 0` line in
the C is a comment; nothing to port.
=================
*/
export function Weapon_Hook(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const pause_frames = [14, 18, 26, 30];
  const fire_frames = [8, 9, 10, 11];

  if (client.weaponstate === WeaponstateT.WEAPON_ACTIVATING) {
    // Speed up activation
    client.ps.gunframe += 1;
  }

  if (client.newweapon !== null && client.weaponstate !== WeaponstateT.WEAPON_DROPPING) {
    client.weaponstate = WeaponstateT.WEAPON_DROPPING;
    client.ps.gunframe = 36; //FRAME_DEACTIVATE_FIRST;
    return;
  }

  if (!((client.latched_buttons | client.buttons) & BUTTON_ATTACK)) {
    ctf_hook_abort(ent);
  }

  Weapon_Generic(ent, 9, 13, 34, 38, pause_frames, fire_frames, Weapon_Hook_Fire);
}
// END CTF CODE

/*	SKWiD MOD
======================================================================

Plasma Rifle

======================================================================
*/

/*
=================
weapon_plasma_fire (lmctf60/p_weapon.c:2155)

LM-CTF's own weapon (weapon_plasma, placed by 8 stock maps). Fires only on
gunframe 4; `plasma_mode` picks the bouncing ("reflect", mode 1) or
spreading (mode 0) variant, each with its own sound. Costs exactly 1 cell
per shot regardless of the item's `quantity` -- the C decrements by a
literal 1, not by pers.weapon->quantity.

The muzzle-flash block is commented out in the C ("-bat Silence??"), so
this weapon deliberately produces NO muzzle flash; not ported.

C QUIRK PRESERVED: `PlayerNoise(ent, start, PNOISE_WEAPON)` at the bottom
reads `start` unconditionally, but `start` is only written inside the
gunframe===4 branch -- on every other frame it is an uninitialized C stack
read, exactly like weapon_bfg_fire's D9. A zero vector is the deterministic
TS stand-in; declaring `start` once at the top reproduces the same "stale
or zero" shape (TS gives it a stable zero instead of C's stack garbage).
=================
*/
function weapon_plasma_fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const start = vec3();

  // if outa ammo, don't fire
  if (client.pers.inventory[client.ammo_index] < 1) {
    client.ps.gunframe++;

    if (level.time >= ent.pain_debounce_time) {
      gi.sound(ent, CHAN_VOICE, gi.soundindex(PLASMA_SOUND_EMPTY), 1, ATTN_NORM, 0);
      ent.pain_debounce_time = level.time + 1;
    }

    NoAmmoWeaponChange(ent);
    return;
  }

  if (client.ps.gunframe === 4) {
    const forward = vec3();
    const right = vec3();
    AngleVectors(client.v_angle, forward, right, null);
    VectorScale(forward, -2, client.kick_origin);

    // fire weapon
    const offset = vec3(8, 8, ent.viewheight - 8);
    P_ProjectSource(client, ent.s.origin, offset, forward, right, start);

    if (client.plasma_mode) {
      gi.sound(ent, CHAN_WEAPON, gi.soundindex(PLASMA_SOUND_FIRE1), 1, ATTN_NORM, 0);
      fire_plasma(ent, start, forward, 1);
    } else {
      gi.sound(ent, CHAN_WEAPON, gi.soundindex(PLASMA_SOUND_FIRE2), 1, ATTN_NORM, 0);
      fire_plasma(ent, start, forward, 0);
    }

    if (!(dmFlags() & DF_INFINITE_AMMO)) client.pers.inventory[client.ammo_index] -= 1;

    // make a big pitch kick with an inverse fall
    client.v_dmg_pitch = -2;
    client.v_dmg_roll = crandom() * 2;
    client.v_dmg_time = level.time + DAMAGE_TIME;
  }

  client.ps.gunframe++;

  PlayerNoise(ent, start, PNOISE_WEAPON);
}

/*
=================
Weapon_Plasma (lmctf60/p_weapon.c:2216)

Drives through plasma.ts's Weapon_PLASMA_Generic, NOT this file's
Weapon_Generic -- lmctf60/plasma.c defines its own frame driver with a
different quad global (`quadmeister`) and a plasma_mode announcement on
activate. The C has two commented-out earlier tunings of the FIRE_LAST
argument (5, then 8); the live call uses 11 ("-bat make the time to fire
next shot longer"), which is what this port passes.
=================
*/
export function Weapon_Plasma(ent: EdictT): void {
  const pause_frames = [16, 46];
  const fire_frames = [4, 5];

  Weapon_PLASMA_Generic(ent, 3, 11, 46, 51, pause_frames, fire_frames, weapon_plasma_fire);
}
// END
