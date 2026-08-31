/*
Parser for .bnvib ("binary NX vibration"), the Nintendo Switch HD-rumble
data format. The re-release ships 53 of these under baseq2/pak0.pak's
tactile/ tree (tactile/weapons/*.bnvib, tactile/players/{cyborg,female,male}/
*.bnvib) -- console haptic assets carried over onto the PC build even though
this port's platform layer (src/platform/haptics.ts, this file's only
caller) is the first thing in this codebase to actually play them back.

FORMAT, reverse-engineered publicly by the Switch homebrew community
(switchbrew.org/wiki/BNVIB via the Wexos's Wiki mirror -- switchbrew.org
itself 403s automated fetches) and independently confirmed here against all
53 retail files (see this module's test/bnvib.test.ts for the survey code
and test/bnvib_retail.test.ts for the retail-gated assertions). Little-
endian throughout.

  offset  size  field
  0x00    u32   metadataSize -- byte length of the metadata section that
                follows this field, EXCLUDING this field itself. Only three
                values are documented/observed:
                  0x04 -- "raw": formatId + sampleRateHz only, no loop.
                  0x0c -- "loop": raw fields + loopStart/loopEnd sample
                          indices.
                  0x10 -- "loop+interval": loop fields + an interval sample
                          count from the end of the loop back to its start.
                This is the field this port's task brief calls the
                "magic/format field"; switchbrew's own doc calls it
                metadata size. Both names refer to the same 4 bytes.
  0x04    u16   formatId -- documented "Always 3". Every one of the 53
                retail files carries exactly 3; anything else is rejected
                as an unsupported/unknown variant rather than guessed at.
  0x06    u16   sampleRateHz -- documented "Always 200"; all 53 retail
                files agree (200 Hz -- a 5ms sample period).
  0x08    u32   loopStart (sample index) -- present only if metadataSize
                is 0x0c or 0x10.
  0x0c    u32   loopEnd (sample index) -- present only if metadataSize is
                0x0c or 0x10.
  0x10    u32   loopIntervalSamples -- present only if metadataSize is
                0x10: silence gap, in samples, from the end of the loop
                back to its start before it repeats.
  4+metadataSize
          u32   dataSize -- byte length of the sample array that follows,
                EXCLUDING this field itself. Always a multiple of 4 (one
                4-byte sample per entry).
  ...     ...   dataSize bytes of 4-byte samples (dataSize/4 of them):
                  +0 u8  ampLow   -- low-band amplitude,  physical = B/255
                  +1 u8  freqLow  -- low-band frequency,  physical =
                                     10 * 2^(B/32) Hz
                  +2 u8  ampHigh  -- high-band amplitude, physical = B/255
                  +3 u8  freqHigh -- high-band frequency, physical =
                                     10 * 2^(B/32) Hz

RETAIL SURVEY FINDING: all 53 shipped files use metadataSize = 0x04 ("raw").
None of them carry loop data -- every weapon-fire and player-pain/fall
tactile cue in this game is a single-shot pattern, never a looped one (unlike,
say, a sustained idle-hum cue would need). The loop/loop+interval branches
below are exercised only by this module's hand-built test vectors, not by
any real asset in this game's retail set.

Sample counts run from 20 (tactile/weapons/hyprbf1a.bnvib, 80 body bytes /
4 = 20 samples = 100ms at 200Hz) up to 479 (tactile/weapons/bfg__f1y.bnvib,
1916 body bytes / 4 = 479 samples = ~2.4s at 200Hz), tracking each cue's
real-world duration (a hyperblaster shot's short punch vs. the BFG's long
windup-and-fire).
*/

export interface BnvibSampleT {
  ampLow: number; // raw byte 0-255
  freqLow: number; // raw byte 0-255
  ampHigh: number; // raw byte 0-255
  freqHigh: number; // raw byte 0-255
}

export interface BnvibLoopT {
  startSample: number;
  endSample: number;
  // present only when metadataSize === BNVIB_METADATA_LOOP_INTERVAL (0x10)
  intervalSamples?: number;
}

export interface BnvibPatternT {
  sampleRateHz: number;
  loop?: BnvibLoopT;
  samples: BnvibSampleT[];
}

export type ParseBnvibResultT = { ok: true; pattern: BnvibPatternT } | { ok: false; reason: string };

export const BNVIB_METADATA_RAW = 0x04;
export const BNVIB_METADATA_LOOP = 0x0c;
export const BNVIB_METADATA_LOOP_INTERVAL = 0x10;

// "Always 3" per the documented format; every retail file agrees. Nothing
// else is known about what other values would mean, so they are rejected
// rather than silently misinterpreted.
const BNVIB_FORMAT_ID = 3;

/*
Converts a raw amplitude byte (0-255) to the documented physical fraction
(0.0-1.0). Exported so src/platform/haptics.ts's downmix and this module's
own tests share one definition.
*/
export function bnvibAmplitude(byte: number): number {
  return byte / 255;
}

/*
Converts a raw frequency byte (0-255) to the documented physical frequency
in Hz: 10 * 2^(B/32). At B=0 this is 10Hz; at B=255 it is ~2503Hz.
*/
export function bnvibFrequencyHz(byte: number): number {
  return 10 * Math.pow(2, byte / 32);
}

/*
Parses one .bnvib file's bytes into a typed pattern. Never throws --
malformed/unrecognized input comes back as { ok: false, reason } the same
shape src/qcommon/png.ts's decodePNG uses for "recognized format, out of
scope" inputs, so a caller (src/platform/haptics.ts) can degrade to a no-op
instead of taking down the client over a bad or future-format asset.
*/
export function parseBnvib(data: Uint8Array): ParseBnvibResultT {
  if (data.length < 4) return { ok: false, reason: "too short for metadata size field" };

  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const metadataSize = dv.getUint32(0, true);

  if (metadataSize !== BNVIB_METADATA_RAW && metadataSize !== BNVIB_METADATA_LOOP && metadataSize !== BNVIB_METADATA_LOOP_INTERVAL) {
    return { ok: false, reason: `unsupported metadata size 0x${metadataSize.toString(16)} (expected 0x04 raw, 0x0c loop, or 0x10 loop+interval)` };
  }

  const metadataEnd = 4 + metadataSize;
  if (data.length < metadataEnd + 4) return { ok: false, reason: "truncated before metadata section end" };

  const formatId = dv.getUint16(4, true);
  if (formatId !== BNVIB_FORMAT_ID) return { ok: false, reason: `unsupported formatId ${formatId} (expected ${BNVIB_FORMAT_ID})` };

  const sampleRateHz = dv.getUint16(6, true);

  let loop: BnvibLoopT | undefined;
  if (metadataSize === BNVIB_METADATA_LOOP || metadataSize === BNVIB_METADATA_LOOP_INTERVAL) {
    const startSample = dv.getUint32(8, true);
    const endSample = dv.getUint32(12, true);
    loop = { startSample, endSample };
    if (metadataSize === BNVIB_METADATA_LOOP_INTERVAL) {
      loop.intervalSamples = dv.getUint32(16, true);
    }
  }

  const dataSize = dv.getUint32(metadataEnd, true);
  if (dataSize % 4 !== 0) return { ok: false, reason: `sample data size ${dataSize} is not a multiple of 4` };

  const bodyStart = metadataEnd + 4;
  if (data.length < bodyStart + dataSize) return { ok: false, reason: "truncated sample data" };

  const sampleCount = dataSize / 4;
  const samples: BnvibSampleT[] = new Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const off = bodyStart + i * 4;
    samples[i] = {
      ampLow: data[off],
      freqLow: data[off + 1],
      ampHigh: data[off + 2],
      freqHigh: data[off + 3],
    };
  }

  return { ok: true, pattern: { sampleRateHz, loop, samples } };
}
