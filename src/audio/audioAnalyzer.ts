import type { AudioFrameFeatures } from "../types";

/**
 * Wraps the Web Audio API plumbing needed to analyze a <video>'s audio track
 * without muting or altering it.
 *
 * Graph shape:
 *   video --(createMediaElementSource)--> AnalyserNode --> destination
 *
 * Gotchas this class exists to hide:
 *  1. `createMediaElementSource` can be called AT MOST ONCE per media
 *     element for its entire lifetime. Calling it twice throws
 *     "already connected". We cache the node on the element itself so a
 *     re-run of the content script (SPA navigation, HMR, etc.) doesn't
 *     crash. See `getOrCreateSource`.
 *  2. Once you create a MediaElementSourceNode, the element's audio is
 *     rerouted through the Web Audio graph — if you don't connect the
 *     node onward to `destination`, the video goes silent. We always do.
 *  3. Autoplay policies suspend new AudioContexts until a user gesture.
 *     `ensureRunning()` resumes it on the first play/interaction.
 *  4. Cross-origin video without CORS taints the audio graph: playback
 *     keeps working but analyser reads come back as all-zero. We can't
 *     detect this directly (no exception is thrown), so the README calls
 *     it out as a known limitation rather than pretending it's handled.
 */
export class AudioAnalyzer {
  private static sourceCache = new WeakMap<
    HTMLMediaElement,
    { ctx: AudioContext; source: MediaElementAudioSourceNode }
  >();

  private readonly ctx: AudioContext;
  private readonly analyser: AnalyserNode;
  // Explicitly parameterized over ArrayBuffer (not the default ArrayBufferLike):
  // AnalyserNode's read methods require the concrete-buffer variant, and an
  // unparameterized `Float32Array`/`Uint8Array` field widens to the
  // ArrayBufferLike default, which TS then rejects at the call site.
  private readonly timeData: Float32Array<ArrayBuffer>;
  private readonly freqData: Uint8Array<ArrayBuffer>;

  constructor(private readonly video: HTMLVideoElement) {
    const { ctx, source } = AudioAnalyzer.getOrCreateSource(video);
    this.ctx = ctx;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    // Low on purpose: this only smooths getByteFrequencyData (used for
    // voiceBandRatio) — getFloatTimeDomainData (used for RMS loudness) is
    // raw and unsmoothed regardless of this value. A higher constant here
    // measurably delayed voice detection on speech onset, on top of the
    // user's own minVoiceMs buffer, since voiceBandRatio would ramp up
    // over several frames instead of reflecting the current frame.
    this.analyser.smoothingTimeConstant = 0.15;

    source.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    this.timeData = new Float32Array(this.analyser.fftSize);
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
  }

  /** Creates (once) or reuses the MediaElementAudioSourceNode for `video`. */
  private static getOrCreateSource(video: HTMLVideoElement) {
    const cached = AudioAnalyzer.sourceCache.get(video);
    if (cached) return cached;

    const ctx = new AudioContext();
    const source = ctx.createMediaElementSource(video);
    const entry = { ctx, source };
    AudioAnalyzer.sourceCache.set(video, entry);
    return entry;
  }

  /** Resumes the AudioContext if a browser autoplay policy suspended it.
   *  Call this from a user-gesture-adjacent event (e.g. 'play'). */
  async ensureRunning(): Promise<void> {
    if (this.ctx.state === "suspended") {
      await this.ctx.resume().catch(() => {
        /* Will retry on the next call; not fatal. */
      });
    }
  }

  /**
   * Pulls one frame of features. Cheap enough to call from a rAF loop:
   * both getFloatTimeDomainData/getByteFrequencyData are typed-array
   * copies out of the browser's internal ring buffer, no allocation here.
   */
  sample(): AudioFrameFeatures {
    this.analyser.getFloatTimeDomainData(this.timeData);
    this.analyser.getByteFrequencyData(this.freqData);

    return {
      rmsDb: computeRmsDb(this.timeData),
      voiceBandRatio: computeVoiceBandRatio(
        this.freqData,
        this.ctx.sampleRate,
        this.analyser.fftSize
      ),
      zeroCrossingRate: computeZeroCrossingRate(this.timeData),
    };
  }

  dispose(): void {
    try {
      this.analyser.disconnect();
    } catch {
      /* already disconnected */
    }
    // Deliberately NOT closing `this.ctx` or disconnecting `source`: the
    // context is cached per-element and shared across analyzer instances
    // that might be recreated for the same element (e.g. settings toggle).
  }
}

/** RMS of a time-domain buffer, expressed in dBFS. -Infinity on true digital
 *  silence is clamped to -100 so downstream math never sees -Infinity. */
export function computeRmsDb(timeDomain: Float32Array): number {
  let sumSquares = 0;
  for (let i = 0; i < timeDomain.length; i++) {
    const sample = timeDomain[i] ?? 0;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / timeDomain.length);
  const db = 20 * Math.log10(rms || 1e-5);
  return Math.max(db, -100);
}

/**
 * Rough proxy for "does this sound like speech" using only an FFT bin
 * histogram (no ML): the fraction of spectral energy that falls inside the
 * human speech formant band (~300Hz-3.4kHz, the same band telephony uses).
 * Music and low rumble tend to spread energy outside this band; speech
 * concentrates inside it. It's a heuristic, not a classifier — see
 * README for how this compares to a real VAD model.
 */
export function computeVoiceBandRatio(
  freqData: Uint8Array,
  sampleRate: number,
  fftSize: number
): number {
  const binWidthHz = sampleRate / fftSize;
  const lowBin = Math.max(0, Math.floor(300 / binWidthHz));
  const highBin = Math.min(freqData.length - 1, Math.ceil(3400 / binWidthHz));

  let bandEnergy = 0;
  let totalEnergy = 0;
  for (let i = 0; i < freqData.length; i++) {
    const magnitude = freqData[i] ?? 0;
    totalEnergy += magnitude;
    if (i >= lowBin && i <= highBin) bandEnergy += magnitude;
  }

  if (totalEnergy <= 0) return 0;
  return bandEnergy / totalEnergy;
}

/**
 * Fraction of adjacent sample pairs that cross zero (change sign), in 0..1.
 * A cheap, allocation-free proxy for spectral texture: a single steady tone
 * or hum crosses zero at a fixed rate; real speech's rate wanders from
 * frame to frame as voiced (vowel, low ZCR) and unvoiced (consonant, high
 * ZCR) sounds alternate. The VAD tracks this value's *variability* over a
 * short window rather than its absolute level — see voiceActivity.ts.
 */
export function computeZeroCrossingRate(timeDomain: Float32Array): number {
  let crossings = 0;
  for (let i = 1; i < timeDomain.length; i++) {
    const prev = timeDomain[i - 1] ?? 0;
    const cur = timeDomain[i] ?? 0;
    if ((prev >= 0) !== (cur >= 0)) crossings++;
  }
  return crossings / (timeDomain.length - 1);
}