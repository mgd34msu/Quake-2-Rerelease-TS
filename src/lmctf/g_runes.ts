// Ports a SUBSET of lmctf60/g_runes.c -- LM_CTF's power-up rune subsystem
// (631 lines; wholly new, no CTF-mod ancestor -- these are LM_CTF's
// replacement for ZOID's tech powerups, which lmctf60/g_local.h drops
// entirely, see g_local.ts's IT_TECH removal note).
//
// STATUS: only the two damage hooks g_combat.ts's T_Damage calls
// (DamageRuneHook/ResistRuneHook) plus the runetype bit constants they
// switch on are ported. Rune spawning (SpawnRune/SP_damage_rune), pickup
// (Pickup_Rune), dropping (Drop_Rune), and the haste/regen think hooks
// (RuneThinkHook/RuneWeaponThinkHook) are NOT ported -- reported as a
// follow-up, not silently completed. Because nothing yet spawns a rune
// pickup or ever sets `client.rune` to non-null, both hooks below are
// currently unreachable in their "rune equipped" branch and always fall
// through to "return damage unchanged", which is the correct behavior for
// every player until rune pickups exist.

import { ATTN_NORM, CHAN_ITEM } from "../shared/q_shared";
import { type EdictT, gi } from "./g_local";

// lmctf60/q_shared.h
export const RUNE_DAMAGE = 1;
export const RUNE_RESIST = 2;
export const RUNE_HASTE = 4;
export const RUNE_REGEN = 8;
export const RUNE_VAMP = 16; // added by Vampire

/*
=================
DamageRuneHook (lmctf60/g_runes.c:527)

1.75x outgoing damage while the attacker carries the damage rune. The C
source's own comment notes the "real" multiplier would be 2x but was tuned
down to 1.75x ("-bat"); preserved exactly, including the fact that this
truncates (C `int damage *= 1.75f` truncates the float back to int, so does
`| 0` here).
=================
*/
export function DamageRuneHook(
  _targ: EdictT,
  _inflictor: EdictT,
  attacker: EdictT | null,
  damage: number,
  _knockback: number,
  _dflags: number,
): number {
  if (attacker !== null && attacker.client !== null && attacker.client.rune !== null) {
    if (attacker.client.rune.runetype === RUNE_DAMAGE) {
      return (damage * 1.75) | 0;
    }
  }
  return damage;
}

/*
=================
ResistRuneHook (lmctf60/g_runes.c:541)

Incoming damage divided by 1.75 (not simply halved -- the C comment notes
this offsets DamageRuneHook's 1.75x exactly) while the target carries the
resist rune, plus a sound cue. `gi.soundindex` is looked up lazily via
g_local.ts's `gi` binding, matching every other sound call site in this
port.
=================
*/
export function ResistRuneHook(
  targ: EdictT,
  _inflictor: EdictT,
  _attacker: EdictT,
  damage: number,
  _knockback: number,
  _dflags: number,
): number {
  if (targ.client !== null && targ.client.rune !== null) {
    if (targ.client.rune.runetype === RUNE_RESIST) {
      gi.sound(targ, CHAN_ITEM, gi.soundindex("ctf/resist.wav"), 1, ATTN_NORM, 0);
      return (damage / 1.75) | 0;
    }
  }
  return damage;
}
