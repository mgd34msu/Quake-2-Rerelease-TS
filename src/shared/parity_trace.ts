/*
Parity trace -- an OFF-BY-DEFAULT observation hook for the cross-module map
sweep (test/parity_map_sweep.test.ts).

WHY THIS EXISTS
---------------
The sweep boots every shipped map under BOTH game modules (classic
src/game/ and re-release src/kexgame/) and compares what actually happens
in the first ~100 server frames. Almost everything it needs -- live entity
counts by classname, mover state (moveinfo.state) and position, entities
freed -- is readable from the outside by walking g_edicts once per frame,
and dprintf/Com_Print warnings are readable from the dedicated server's own
stdout. Exactly one signal is not observable from outside the module:
G_UseTargets firing. It has no persistent trace -- it fires a target's
.use, and by the next frame boundary all that survives is the downstream
effect. So the two G_UseTargets implementations (src/game/g_utils.ts and
src/kexgame/g_utils.ts) each carry ONE guarded call into this file.

COST WHEN OFF
-------------
`PARITY_TRACE_ENABLED` is a module-level const read once at import from
the environment. Both call sites are `if (PARITY_TRACE_ENABLED) ...`, so
with the variable unset the branch is a constant-false test on a value the
JIT resolves at first tier-up; no allocation, no formatting, no call. This
is deliberately NOT a cvar: cvars are per-session mutable state that would
have to be threaded into the game modules and saved/restored, and the hook
must be provably inert in normal play.

HOW TO TURN IT ON
-----------------
Set `Q2_PARITY_TRACE=1` in the environment before the process starts, then
install a sink with ParityTrace_SetSink(). Both are required: the env var
alone only opens the branch, and with no sink installed the trace call
returns immediately. Nothing in src/ ever installs a sink -- only
test/support/parity_boot_driver.ts does.

The recorded event is intentionally plain data (numbers and strings, no
edict references), so a sink can serialise a whole boot to JSON without
retaining any game state.
*/

/** Opened by `Q2_PARITY_TRACE=1` in the environment. Read once, at import. */
export const PARITY_TRACE_ENABLED: boolean = process.env["Q2_PARITY_TRACE"] === "1";

/** One G_UseTargets firing, flattened to plain data. */
export interface ParityUseTargetsEventT {
  /** Entity number of the firing entity (`ent.s.number`). */
  readonly ent: number;
  readonly classname: string | null;
  readonly targetname: string | null;
  readonly target: string | null;
  readonly killtarget: string | null;
  /** Entity number of the activator, or -1 when the activator was null. */
  readonly activator: number;
  readonly activator_classname: string | null;
}

/**
 * The structural shape this hook reads. Both modules' EdictT satisfy it --
 * src/game/g_local.ts's EdictT class and src/kexgame/g_local_types.ts's
 * EdictT interface (its `inuse`/`s.number` come from KexEdictT in
 * src/kexapi/game.ts) -- so neither module needs a cast at its call site.
 */
export interface ParityTraceEdictT {
  readonly classname: string | null;
  readonly targetname: string | null;
  readonly target: string | null;
  readonly killtarget: string | null;
  readonly s: { readonly number: number };
}

type SinkFn = (event: ParityUseTargetsEventT) => void;

let sink: SinkFn | null = null;

/** Install (or, with null, remove) the trace sink. No-op unless the env var is set. */
export function ParityTrace_SetSink(fn: SinkFn | null): void {
  sink = fn;
}

/**
 * Record one G_UseTargets firing. Called ONLY from the two G_UseTargets
 * implementations, and only behind `if (PARITY_TRACE_ENABLED)`.
 */
export function ParityTrace_UseTargets(ent: ParityTraceEdictT, activator: ParityTraceEdictT | null): void {
  if (sink === null) return;
  sink({
    ent: ent.s.number,
    classname: ent.classname,
    targetname: ent.targetname,
    target: ent.target,
    killtarget: ent.killtarget,
    activator: activator === null ? -1 : activator.s.number,
    activator_classname: activator === null ? null : activator.classname,
  });
}
