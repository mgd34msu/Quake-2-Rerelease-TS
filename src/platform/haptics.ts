/*
Controller haptics: schedules .bnvib patterns (src/qcommon/bnvib.ts) onto a
real gamepad's dual rumble motors, mapping client-side gameplay events to
the retail tactile/*.bnvib assets baseq2/pak0.pak actually ships. This is
new engine behavior -- the original id Quake II engine and this port's
pre-existing platform layer had no controller-haptics surface at all -- so
every design choice below is this file's own, documented plainly rather
than presented as a port of anything.

=============================================================================
WHY THIS EXISTS / WHAT THE RETAIL ASSETS ARE

The KEX re-release engine ships its console (Nintendo Switch) haptic assets
inside the PC build's pak0.pak too: 53 .bnvib files under tactile/, all
using the format src/qcommon/bnvib.ts documents and parses (see that file's
header comment for the byte layout and the retail survey backing it).

Every one of the 53 files' paths mirrors a real sound/*.wav asset path
one-for-one, with "sound/" (implicit -- .wav paths are relative to it)
swapped for "tactile/" and ".wav" swapped for ".bnvib":

  weapons/bfg__f1y.wav              <-> tactile/weapons/bfg__f1y.bnvib
  weapons/grapple/grfire.wav        <-> tactile/weapons/grapple/grfire.bnvib
  players/male/pain100_1.wav        <-> tactile/players/male/pain100_1.bnvib
  players/female/fall1.wav          <-> tactile/players/female/fall1.bnvib

This was verified against all 53 real filenames, not assumed: 22 weapon-fire
cues plus tactile/weapons/grapple/grfire.bnvib (23 total, one per distinct
MZ_* muzzleflash sound src/client/cl_fx.ts's CL_ParseMuzzleFlash/
CL_ParseMuzzleFlash2 already play) and 30 player cues -- 3 player models
(cyborg/female/male, the exact three directories under players/ that
src/client/cl_parse.ts's CL_ParseClientinfo resolves a player's model name
to, "male" being its own documented fallback) x 10 filenames each (fall1,
fall2, pain25_1, pain25_2, pain50_1, pain50_2, pain75_1, pain75_2,
pain100_1, pain100_2 -- exactly the health-bucketed pain_sounds array
src/kexgame/p_view.ts's damage handler already selects from, plus the
EV_FALL/EV_FALLFAR fall cues src/client/cl_fx.ts's CL_EntityEvent already
plays).

THERE IS NO tactile/items/ OR ANY PICKUP-SHAPED ASSET IN THE RETAIL SET.
This task's brief speculated item pickups might be represented; the actual
53 files refute that -- only weapon fire and player pain/fall have haptic
cues. This module does not invent a pickup mapping.

=============================================================================
TRIGGER MODEL (original engineering -- KEX's own engine-side trigger logic
is closed-source, not ported)

The game DLL API (src/kexapi/game.ts) and the rerelease game source
(quake2-rerelease-dll/rerelease) expose no rumble/haptic/vibration call at
all -- grepped for all three terms, no hits beyond an unrelated
"world/rumble.wav" sound effect name in g_items.cpp. Haptics are therefore
engine-side and this port's own to build.

Rather than hand-maintaining a second, parallel event table (one entry per
MZ_* weapon constant, one per pain bucket, one per fall variant -- all of
which already exist as *sound* dispatch tables in src/client/cl_fx.ts and
src/kexgame/p_view.ts), this module hooks the ONE place all of those sound
triggers already funnel through: src/client/snd_dma.ts's S_StartSound,
right after it resolves a sexed ("*name.wav") sound name to the concrete
per-model path (S_RegisterSexedSound already turns "*pain100_1.wav" into
"#players/male/pain100_1.wav", i.e. it has already done the player-model
resolution this module would otherwise have needed to duplicate via
src/client/cl_parse.ts's clientinfo table). Haptics_TriggerSound (below)
takes that resolved sound name and the entity number S_StartSound already
has, derives the mirrored tactile/ path via normalizeSoundNameToTactilePath,
and plays it if a matching .bnvib exists and the sound belongs to the LOCAL
player (entnum === cl.playernum + 1, the same check src/client/snd_dma.ts
already uses at lines 367/455/679/1012 for "is this our own sound").

This one hook point automatically covers weapon fire (CL_ParseMuzzleFlash's
S_StartSound calls), player pain (kexgame's gi.sound -> svc_sound ->
S_StartSound), and player fall (CL_EntityEvent's S_StartSound calls) without
needing three separate call sites, and degrades safely if a future KEX
content update ships tactile assets for sounds this game doesn't yet know
about (FS_LoadFile just misses and nothing plays).

REQUESTED HOOK (src/client/snd_dma.ts's S_StartSound is outside this task's
territory -- see this task's own report for the exact patch): immediately
after `if (sfx.name[0] === "*") { sfx = S_RegisterSexedSound(...); }`
resolves `sfx`, call `Haptics_TriggerSound(sfx.name, entnum)`.

=============================================================================
DOWNMIX: bnvib's 2-band amplitude+frequency data -> SDL_GameControllerRumble

SDL_GameControllerRumble(controller, low_frequency_rumble,
high_frequency_rumble, duration_ms) takes two AMPLITUDE values for two
fixed-frequency motors (a real Xbox/PlayStation-style gamepad's strong
low-frequency ERM motor and weak high-frequency one) -- there is no
frequency parameter at all. Nintendo's own HD rumble hardware (Joy-Con /
Pro Controller) uses genuinely variable-frequency LRA actuators instead
(low band ~40.9-626.3Hz, high band ~81.8-1252.6Hz, per the frequency
encoding documented at github.com/greggersaurus/OpenSteamController/issues/10),
which is strictly richer than what SDL's generic dual-motor API can drive.

There is no publicly documented formula for folding a band's amplitude AND
frequency into one motor-intensity value, and this file does not invent
one. Precedent from real Switch emulators handling exactly this same
donwstream problem: Ryujinx's own docs state HD rumble is "Emulated via
standard rumble" with no frequency-aware conversion described
(yakushabb-mirror-ryujinx.mintlify.app/features/input-support, "standard
rumble motors can't reproduce the fine haptic detail of real Joy-Cons");
the OpenSteamController issue above -- an attempt to build exactly this
kind of converter for a different third-party adapter -- confirms even the
amplitude encoding needed reverse-engineering and never arrived at a
published amp+freq combining formula either. This module follows that same
amplitude-only precedent: downmixBnvibSample maps ampLow/ampHigh straight
to SDL's low/high motor intensities (via bnvib.ts's own bnvibAmplitude,
byte/255) and drops freqLow/freqHigh entirely for motor-intensity purposes
(bnvibFrequencyHz is still exported by bnvib.ts and usable by any future
caller that wants the decoded Hz value for something else, e.g. a visual
debug overlay).

=============================================================================
SCHEDULING

BnvibScheduler.play() latches a pattern and a start timestamp;
BnvibScheduler.update(nowMs), meant to be called once per client frame (see
Haptics_Frame below and this task's report for the requested per-frame call
site), computes which 5ms-at-200Hz sample index "now" falls into and, if it
changed since the last update, downmixes that sample and reissues
SDL_GameControllerRumble with a duration slightly longer than one sample
period -- so an occasional late frame doesn't cause an audible/felt gap
before the next update() call arrives, without needing precise sub-frame
timers. Looping patterns (metadataSize 0x0c/0x10 -- see bnvib.ts; NONE of
the 53 retail files actually use this, only this module's own tests do)
wrap back to loop.startSample after loop.endSample, holding the motors at
zero during any loopIntervalSamples silence gap.

=============================================================================
HEADLESS SAFETY

Nothing is dlopen()ed at module load, mirroring src/platform/sdl.ts's own
rule. HAPTICS_SetBackendEnabled(true) must be called (client path only,
same as SDL_SetBackendEnabled) before Haptics_TriggerSound/Haptics_Frame do
anything beyond returning immediately; even then, every SDL call is
wrapped so a missing library, a headless SDL_VIDEODRIVER=dummy session, or
simply no connected controller all degrade to a silent no-op rather than an
error. HAPTICS_SetSinkForTests lets a test replace the real SDL-backed sink
with a fake one and drive the scheduler with synthetic timestamps, so
test/haptics.test.ts never touches real hardware or the real SDL library.
*/

import { dlopen, type Pointer } from "bun:ffi";
import { SDL_GetActiveGameController } from "./sdl";
import { FS_LoadFile } from "../qcommon/files";
import { Cvar_Get } from "../qcommon/cvar";
import type { CvarT } from "../shared/q_shared";
import { CVAR_ARCHIVE } from "../shared/q_shared";
import { Com_DPrintf } from "../qcommon/common";
import { cl } from "../client/client";
import { parseBnvib, bnvibAmplitude, type BnvibPatternT, type BnvibSampleT } from "../qcommon/bnvib";

//=============================================================================
// pure helpers -- no I/O, fully unit-testable

/*
"weapons/bfg__f1y.wav" -> "tactile/weapons/bfg__f1y.bnvib"
"#players/male/pain100_1.wav" -> "tactile/players/male/pain100_1.bnvib"
Anything not ending in ".wav" (or with nothing before it) has no possible
tactile counterpart and returns null; this does NOT check that the tactile
file actually exists -- that's loadTactilePattern's job (FS_LoadFile
returning null is the "doesn't exist" signal, since this port's VFS has no
directory-listing API to check against).
*/
export function normalizeSoundNameToTactilePath(soundName: string): string | null {
  if (!soundName.endsWith(".wav")) return null;
  const rest = soundName[0] === "#" ? soundName.slice(1) : soundName;
  const base = rest.slice(0, -4);
  if (!base) return null;
  return `tactile/${base}.bnvib`;
}

// See this file's header "DOWNMIX" section for the design rationale and
// citations. low/high are fractions in [0,1].
export function downmixBnvibSample(sample: BnvibSampleT): { low: number; high: number } {
  return { low: bnvibAmplitude(sample.ampLow), high: bnvibAmplitude(sample.ampHigh) };
}

//=============================================================================
// scheduler -- pattern + wall-clock timestamp in, motor intensities out

export interface RumbleSinkT {
  // low/high in [0,1]; durationMs is how long the caller should assume the
  // motors stay at this intensity if no further call arrives.
  setMotors(low: number, high: number, durationMs: number): void;
  stop(): void;
}

// test seam: records every call instead of touching SDL. Exported so
// test/haptics.test.ts (and any future caller) doesn't need to
// hand-roll one.
export class FakeRumbleSinkT implements RumbleSinkT {
  calls: Array<{ low: number; high: number; durationMs: number }> = [];
  stopped = 0;
  setMotors(low: number, high: number, durationMs: number): void {
    this.calls.push({ low, high, durationMs });
  }
  stop(): void {
    this.stopped++;
  }
}

const IDLE_HOLD_MS = 50;
// re-issued rumble duration padding over one sample period, so a late next
// frame doesn't cause a felt dropout before the following update() call.
const DURATION_PAD_MS = 20;

export class BnvibScheduler {
  private sink: RumbleSinkT;
  private pattern: BnvibPatternT | null = null;
  private startMs = 0;
  // -1: nothing applied yet; -2: holding idle (in a loop's silence gap)
  private lastAppliedIndex = -1;

  constructor(sink: RumbleSinkT) {
    this.sink = sink;
  }

  setSink(sink: RumbleSinkT): void {
    this.sink = sink;
  }

  play(pattern: BnvibPatternT, nowMs: number): void {
    this.pattern = pattern;
    this.startMs = nowMs;
    this.lastAppliedIndex = -1;
    this.update(nowMs);
  }

  stop(): void {
    if (this.pattern === null && this.lastAppliedIndex === -1) return;
    this.pattern = null;
    this.lastAppliedIndex = -1;
    this.sink.stop();
  }

  isPlaying(): boolean {
    return this.pattern !== null;
  }

  update(nowMs: number): void {
    const pattern = this.pattern;
    if (!pattern || pattern.samples.length === 0) return;

    const samplePeriodMs = 1000 / pattern.sampleRateHz;
    const total = pattern.samples.length;
    let index = Math.floor((nowMs - this.startMs) / samplePeriodMs);

    if (index >= total) {
      const loop = pattern.loop;
      const loopLen = loop ? loop.endSample - loop.startSample : 0;
      if (loop && loopLen > 0) {
        const cycleLen = loopLen + (loop.intervalSamples ?? 0);
        const posInCycle = (index - total) % cycleLen;
        if (posInCycle < loopLen) {
          index = loop.startSample + posInCycle;
        } else {
          if (this.lastAppliedIndex !== -2) {
            this.lastAppliedIndex = -2;
            this.sink.setMotors(0, 0, IDLE_HOLD_MS);
          }
          return;
        }
      } else {
        this.stop();
        return;
      }
    }

    if (index === this.lastAppliedIndex) return;
    this.lastAppliedIndex = index;

    const { low, high } = downmixBnvibSample(pattern.samples[index]);
    this.sink.setMotors(low, high, Math.ceil(samplePeriodMs) + DURATION_PAD_MS);
  }
}

//=============================================================================
// SDL binding -- deliberately a SEPARATE dlopen from src/platform/sdl.ts
// (that file's own header comment calls itself "the only dlopen in the
// port"; this task's brief explicitly asks for an independent
// implementation here rather than an edit to that file, so that comment is
// now describing sdl.ts's own scope, not the whole port's). A second
// dlopen() of the same shared object is safe -- the dynamic linker maps a
// given .so once per process and hands out refcounted handles to it, and
// SDL's internal subsystem init is itself refcounted, so this module's own
// SDL_Init/SDL_InitSubSystem calls compose safely with sdl.ts's regardless
// of which one runs first.

const SDL_INIT_GAMECONTROLLER = 0x00002000;
const SDL_INIT_NOPARACHUTE = 0x00100000;

const symbols = {
  SDL_Init: { args: ["u32"], returns: "i32" },
  SDL_InitSubSystem: { args: ["u32"], returns: "i32" },
  SDL_NumJoysticks: { args: [], returns: "i32" },
  SDL_IsGameController: { args: ["i32"], returns: "i32" },
  SDL_GameControllerOpen: { args: ["i32"], returns: "ptr" },
  SDL_GameControllerClose: { args: ["ptr"], returns: "void" },
  SDL_GameControllerGetAttached: { args: ["ptr"], returns: "i32" },
  SDL_GameControllerRumble: { args: ["ptr", "u16", "u16", "u32"], returns: "i32" },
} as const;

type HapticsLib = ReturnType<typeof dlopen<typeof symbols>>;

function libraryName(): string {
  switch (process.platform) {
    case "win32":
      return "SDL2.dll";
    case "darwin":
      return "libSDL2.dylib";
    default:
      return "libSDL2-2.0.so.0";
  }
}

let enabled = false;
let library: HapticsLib | null = null;
let libraryFailed = false;
let subsystemArmed = false;

export function HAPTICS_SetBackendEnabled(value: boolean): void {
  enabled = value;
}

export function HAPTICS_BackendEnabled(): boolean {
  return enabled;
}

function lib(): HapticsLib | null {
  if (!enabled || libraryFailed) return null;
  if (library) return library;
  try {
    library = dlopen(libraryName(), symbols);
  } catch (err) {
    libraryFailed = true;
    const msg = err instanceof Error ? err.message : String(err);
    Com_DPrintf("Haptics: could not load %s: %s\n", libraryName(), msg);
    return null;
  }
  return library;
}

function ensureGameControllerSubsystem(l: HapticsLib): boolean {
  if (subsystemArmed) return true;
  if (l.symbols.SDL_Init(SDL_INIT_NOPARACHUTE) < 0) return false;
  if (l.symbols.SDL_InitSubSystem(SDL_INIT_GAMECONTROLLER) < 0) return false;
  subsystemArmed = true;
  return true;
}

//=============================================================================
// controller lifecycle -- opportunistic: try to hold one open controller,
// rescanning occasionally rather than on every call so a controller-less
// machine doesn't pay a per-frame SDL cost forever.
//
// REUSE, DON'T DUPLICATE (the SDL gamepad INPUT layer's own task brief):
// src/platform/sdl.ts now owns an event-driven SDL_GameController
// open/close/hotplug lifecycle of its own (SDL_CONTROLLERDEVICEADDED/
// REMOVED, read off the same SDL_PollEvent loop that already pumps
// keyboard/mouse), so ensureController below asks SDL_GetActiveGameController
// FIRST and only falls back to this file's own independent
// scan-and-poll-GetAttached loop when that comes back null -- either because
// sdl.ts's backend was never armed (a caller that enables haptics without
// ever calling SDL_SetBackendEnabled(true); test/haptics.test.ts's own
// "headless, no controller required" suite is exactly this case, since it
// never touches src/platform/sdl.ts at all) or because no controller is
// currently open there either. In the real client (src/main.ts's
// Qcommon_Init arms both backends together, in that order, whenever
// `dedicated 0`) this means the fallback path below is normally cold: the
// controller sdl.ts already opened for button/stick input is the exact same
// handle this file rumbles, with no second SDL_GameControllerOpen() of the
// same physical device and no second periodic rescan loop running.

let controller: Pointer | bigint | null = null;
// true only when THIS file opened `controller` itself (the fallback path
// below) -- a handle borrowed from sdl.ts's SDL_GetActiveGameController is
// owned and closed by that file, never by this one.
let controllerOwnedByUs = false;
const CONTROLLER_RESCAN_INTERVAL_MS = 2000;
let lastScanAttemptMs = -Infinity;

function ensureController(nowMs: number): Pointer | bigint | null {
  const shared = SDL_GetActiveGameController();
  if (shared) {
    if (controller && controllerOwnedByUs && controller !== shared) {
      // sdl.ts's own handle became available after this file had already
      // opened its own fallback one (e.g. a hotplug event landed between
      // this file's rescans) -- drop ours in favor of the canonical one.
      const l = lib();
      if (l) l.symbols.SDL_GameControllerClose(controller);
    }
    controller = shared;
    controllerOwnedByUs = false;
    return controller;
  }

  const l = lib();
  if (!l) return null;

  if (controller) {
    if (!controllerOwnedByUs) {
      // sdl.ts's handle just disappeared (disconnected); fall through to
      // this file's own scan below instead of trusting a stale pointer.
      controller = null;
    } else if (l.symbols.SDL_GameControllerGetAttached(controller)) {
      return controller;
    } else {
      l.symbols.SDL_GameControllerClose(controller);
      controller = null;
    }
  }

  if (nowMs - lastScanAttemptMs < CONTROLLER_RESCAN_INTERVAL_MS) return null;
  lastScanAttemptMs = nowMs;

  if (!ensureGameControllerSubsystem(l)) return null;

  const count = l.symbols.SDL_NumJoysticks();
  for (let i = 0; i < count; i++) {
    if (!l.symbols.SDL_IsGameController(i)) continue;
    const handle = l.symbols.SDL_GameControllerOpen(i);
    if (handle) {
      controller = handle;
      controllerOwnedByUs = true;
      return controller;
    }
  }
  return null;
}

let currentNowMs = 0;

const sdlRumbleSink: RumbleSinkT = {
  setMotors(low, high, durationMs) {
    const l = lib();
    if (!l) return;
    const handle = ensureController(currentNowMs);
    if (!handle) return;
    const lowMag = Math.round(Math.max(0, Math.min(1, low)) * 0xffff);
    const highMag = Math.round(Math.max(0, Math.min(1, high)) * 0xffff);
    l.symbols.SDL_GameControllerRumble(handle, lowMag, highMag, Math.max(0, Math.round(durationMs)));
  },
  stop() {
    const l = lib();
    if (!l || !controller) return;
    l.symbols.SDL_GameControllerRumble(controller, 0, 0, 0);
  },
};

//=============================================================================
// pattern cache -- FS_LoadFile + parseBnvib, memoized (including misses, so
// a sound with no tactile counterpart only costs one failed lookup ever)

const patternCache = new Map<string, BnvibPatternT | null>();

function loadTactilePattern(path: string): BnvibPatternT | null {
  const cached = patternCache.get(path);
  if (cached !== undefined) return cached;

  let pattern: BnvibPatternT | null = null;
  const bytes = FS_LoadFile(path);
  if (bytes) {
    const result = parseBnvib(bytes);
    if (result.ok) pattern = result.pattern;
    else Com_DPrintf("Haptics: %s: %s\n", path, result.reason);
  }
  patternCache.set(path, pattern);
  return pattern;
}

//=============================================================================
// public API

let in_haptics: CvarT | null = null;
const scheduler = new BnvibScheduler(sdlRumbleSink);

/*
Registers the in_haptics cvar (default "1", CVAR_ARCHIVE -- matches
src/platform/sdl.ts's in_mouse convention: on by default, and only ever
produces real output once a controller is actually present, so "on by
default" and "default on only when a controller with rumble is present"
are the same observable behavior). Cvar_Get's own contract (first call
wins the default, later calls just OR in flags -- see
test/support/cvar_snapshot.ts's header comment) makes repeat calls safe.

REQUESTED HOOK: call this once during client startup, e.g. alongside
src/platform/sdl.ts's IN_Init (which registers this port's other in_*
cvars) or src/client/cl_main.ts's CL_InitLocal.
*/
export function Haptics_Init(): void {
  in_haptics = Cvar_Get("in_haptics", "1", CVAR_ARCHIVE);
}

function hapticsWanted(): boolean {
  return enabled && !!in_haptics && in_haptics.value !== 0;
}

/*
Called from the requested S_StartSound hook (see this file's header
comment) with the resolved sound name (post sexed-sound substitution) and
the entity number that sound belongs to. No-ops unless: the backend is
armed, in_haptics is on, the sound belongs to the LOCAL player
(entnum === cl.playernum + 1, matching src/client/snd_dma.ts's own
"is this our own sound" checks), and a same-named tactile/*.bnvib asset
actually exists.
*/
export function Haptics_TriggerSound(soundName: string, entnum: number): void {
  if (!hapticsWanted()) return;
  if (entnum !== cl.playernum + 1) return;

  const tactilePath = normalizeSoundNameToTactilePath(soundName);
  if (!tactilePath) return;

  const pattern = loadTactilePattern(tactilePath);
  if (!pattern) return;

  scheduler.play(pattern, currentNowMs);
}

/*
REQUESTED HOOK: call once per client frame (e.g. from src/client/cl_main.ts's
CL_Frame, or anywhere else that already runs unconditionally once per
client frame -- src/platform/sdl.ts's own SDL_PumpInput/IN_Move comments
document the same "which file actually owns the per-frame hook" tension
this task's brief flags). Drives the scheduler's sample-index timing and
opportunistically (re)connects a controller even when nothing is currently
playing, so the first haptic cue after a controller is plugged in doesn't
eat the ~2s controller rescan interval on top of its own latency.
*/
export function Haptics_Frame(nowMs: number): void {
  currentNowMs = nowMs;
  if (!hapticsWanted()) {
    scheduler.stop();
    return;
  }
  ensureController(nowMs);
  scheduler.update(nowMs);
}

export function HAPTICS_IsPlaying(): boolean {
  return scheduler.isPlaying();
}

// test seam: swap the real SDL-backed sink for a fake one (or back).
export function HAPTICS_SetSinkForTests(sink: RumbleSinkT | null): void {
  scheduler.setSink(sink ?? sdlRumbleSink);
}

// test seam: forget every cached pattern, close any open controller, and
// reset the backend to its just-loaded state, mirroring
// src/platform/sdl.ts's own SDL_ResetBackendForTests.
export function HAPTICS_ResetForTests(): void {
  scheduler.stop();
  scheduler.setSink(sdlRumbleSink);
  patternCache.clear();

  const l = library;
  // Only close a handle THIS file opened -- one borrowed from sdl.ts's
  // SDL_GetActiveGameController is that file's to close (see ensureController's
  // own "REUSE, DON'T DUPLICATE" doc comment above).
  if (l && controller && controllerOwnedByUs) l.symbols.SDL_GameControllerClose(controller);
  controller = null;
  controllerOwnedByUs = false;
  lastScanAttemptMs = -Infinity;

  enabled = false;
  library = null;
  libraryFailed = false;
  subsystemArmed = false;
  currentNowMs = 0;
  in_haptics = null;
}
