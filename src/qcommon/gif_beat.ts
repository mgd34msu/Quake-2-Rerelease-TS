// Frame-selection cadence for animated GIFs used in the 2D/UI draw paths --
// NOT a port of anything in the original id Quake II source (no classic
// engine has any concept of an animated GIF at all). See qcommon/gif.ts's
// own header comment for the full design ruling this is one piece of:
// gif.ts decodes and composites every frame; THIS module decides which one
// of those composited frames is on screen right now.
//
// Mike's settled design (2026-08-31 session, same as gif.ts's animation
// ruling): a FIXED 10Hz cadence derived from TIME, not tick counting. This
// is deliberate, not an approximation of "the server's tick rate":
//   - it is IDENTICAL whether the connected server runs classic 10Hz or
//     KEX's 40Hz -- the animation never speeds up or slows down when the
//     game's own simulation rate changes, because it never reads the
//     game's simulation rate at all;
//   - it keeps working with NO server connected at all (menu/console 2D
//     draws), where there is no tick to count.
// GIF delay time and loop-count metadata are read by gif.ts's parser (to
// stay well-formed) but their VALUES are discarded everywhere -- every
// animated GIF loops forever at this fixed rate, full stop.
//
// Caller-side time source (src/ref_gl/gl_draw.ts's Draw_Pic and friends):
// in-game 2D draws use cl.time-derived seconds; menu/console context uses
// cls.realtime-derived seconds. Both are plain milliseconds counters in
// this codebase (q_shared.ts convention) -- callers pass `ms / 1000`.
export const GIF_BEAT_HZ = 10;

// Returns the index (0..frameCount-1) of the composited GIF frame that
// should be on screen at `beatSeconds`. Pure and total: every finite real
// `beatSeconds` value works, for every frameCount >= 1.
export function gifBeatFrame(beatSeconds: number, frameCount: number): number {
  if (frameCount <= 1) return 0;

  const beat = Math.floor(beatSeconds * GIF_BEAT_HZ);
  // JS's `%` keeps the sign of the dividend, so a negative `beat` (not
  // expected from cl.time/cls.realtime in practice -- both are monotonic
  // non-negative millisecond counters -- but this function is a general
  // pure helper, not one that trusts its caller) is folded back into
  // [0, frameCount) with a floor-mod instead of a truncating one.
  return ((beat % frameCount) + frameCount) % frameCount;
}
