import type { AudioFrameFeatures } from "../types";
import { StreamingResampler } from "./resampler";
import { SILERO_CHUNK, SILERO_SAMPLE_RATE, type SileroWeights } from "./sileroVad";
import { NeuralVoiceStream, type VoiceSource } from "./neuralVad";

/** Live result from the model running inside the capture worklet. */
class WorkletVoice implements VoiceSource {
  isVoice = false;
  probability = 0;
  ready = false;
  update(d: { p: number; voice: boolean; ready: boolean }): void {
    this.probability = d.p;
    this.isVoice = d.voice;
    this.ready = d.ready;
  }
  reset(): void {
    this.isVoice = false;
    this.probability = 0;
    this.ready = false;
  }
}

/** One worklet module load per AudioContext, shared by all videos. */
const captureModules = new WeakMap<BaseAudioContext, Promise<boolean>>();
function loadCaptureModule(ctx: AudioContext, url: string): Promise<boolean> {
  let p = captureModules.get(ctx);
  if (!p) {
    p = ctx.audioWorklet
      ? ctx.audioWorklet.addModule(url).then(
          () => true,
          (err) => {
            console.warn("[AdaptiveSpeed] Audio-thread capture unavailable, using main-thread capture:", err);
            return false;
          }
        )
      : Promise.resolve(false);
    captureModules.set(ctx, p);
  }
  return p;
}

/**
 * One AudioContext for every <video> on the page.
 *
 * Previously each video created its own AudioContext. Each context owns an
 * audio rendering thread and an output stream, so pages with several
 * videos (feeds, course pages, YouTube's hover previews) paid that cost
 * many times over, which is a big part of why playback felt laggy.
 */
let sharedCtx: AudioContext | null = null;

export function getSharedAudioContext(): AudioContext {
  if (!sharedCtx || sharedCtx.state === "closed") sharedCtx = new AudioContext();
  return sharedCtx;
}

/** Ask the shared context to start. Never awaits: resume() stays pending
 *  until the page gets a user gesture, and callers must not block on it. */
export function resumeSharedAudioContext(): void {
  if (sharedCtx && sharedCtx.state === "suspended") {
    sharedCtx.resume().catch(() => {
      /* Retried on the next play / user gesture. */
    });
  }
}

export function isSharedAudioContextRunning(): boolean {
  return sharedCtx?.state === "running";
}

/**
 * Whether the browser will let us read this element's audio.
 *
 * A MediaElementAudioSourceNode on a cross-origin source without CORS
 * outputs pure silence. Because routing the element through Web Audio is
 * permanent, attaching to such a video would MUTE it for the user and the
 * all-zero readings would look like silence, pinning it at quietSpeed.
 * So we only attach when the source is readable.
 *
 * Returns null when the source isn't known yet (check again later).
 */
export function canAnalyzeAudio(video: HTMLVideoElement): boolean | null {
  if (video.srcObject) return true;
  const src = video.currentSrc || video.src;
  if (!src) return null;
  try {
    const url = new URL(src, location.href);
    if (url.protocol === "blob:" || url.protocol === "data:") return true;
    if (url.origin === location.origin) return true;
  } catch {
    return false;
  }
  // crossorigin="anonymous|use-credentials" means the load itself used CORS,
  // so if it's playing at all the audio is readable.
  return video.crossOrigin !== null;
}

/** How long a playing, unmuted video can report pure digital silence
 *  before we suspect the audio is unreadable and stop trusting it. */
const BLOCKED_AFTER_MS = 3000;

/**
 * Wraps the Web Audio API plumbing needed to analyze a <video>'s audio track
 * without muting or altering it.
 *
 * Graph shape:
 *   video --(createMediaElementSource)--> AnalyserNode --> destination
 *                                    \--> capture worklet (no output; runs the speech model)
 *
 * Gotchas this class exists to hide:
 *  1. `createMediaElementSource` can be called AT MOST ONCE per media
 *     element for its entire lifetime. We cache the node per element so a
 *     re-created pipeline (element moved in the DOM, settings toggle)
 *     reuses it instead of throwing.
 *  2. Once routed through Web Audio, the element is silent unless the
 *     graph reaches `destination`. On dispose we reconnect the source
 *     straight to `destination` so the video never goes quiet.
 *  3. Only construct this while the shared context is running (see
 *     VideoPipeline): a routed element on a suspended context is silent.
 *  4. Unreadable audio reads as all zeros. `looksBlocked` flags a source
 *     that has never produced a single non-silent frame after a few
 *     seconds of playback, so the pipeline can fail open.
 */
export class AudioAnalyzer {
  private static sourceCache = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

  private readonly ctx: AudioContext;
  private readonly source: MediaElementAudioSourceNode;
  private readonly analyser: AnalyserNode;
  // Explicitly parameterized over ArrayBuffer (not the default ArrayBufferLike):
  // AnalyserNode's read methods require the concrete-buffer variant.
  private readonly timeData: Float32Array<ArrayBuffer>;
  private readonly freqData: Uint8Array<ArrayBuffer>;

  private heardSignal = false;
  private firstSampleAt: number | null = null;

  // Neural voice detection: in the capture worklet (preferred) or, if the
  // page blocks worklets, on the main thread from stitched analyser reads.
  private captureNode: AudioWorkletNode | null = null;
  private workletVoice: WorkletVoice | null = null;
  private mainThreadVoice: NeuralVoiceStream | null = null;
  private fallbackResampler: StreamingResampler | null = null;
  private lastCtxTime = -1;
  private disposed = false;
  private modelGaveUp = false;
  private inputGain = 1;

  constructor(video: HTMLVideoElement) {
    this.ctx = getSharedAudioContext();
    this.source = AudioAnalyzer.getOrCreateSource(video, this.ctx);

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    // Low on purpose: only smooths getByteFrequencyData (voiceBandRatio).
    // A higher constant delayed voice detection on speech onset.
    this.analyser.smoothingTimeConstant = 0.15;

    // Drop any bypass connection left by a previous analyzer, then route
    // through the analyser.
    this.source.disconnect();
    this.source.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    this.timeData = new Float32Array(this.analyser.fftSize);
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
  }

  private static getOrCreateSource(video: HTMLVideoElement, ctx: AudioContext) {
    const cached = AudioAnalyzer.sourceCache.get(video);
    if (cached && cached.context === ctx) return cached;
    const source = ctx.createMediaElementSource(video);
    AudioAnalyzer.sourceCache.set(video, source);
    return source;
  }

  get isRunning(): boolean {
    return this.ctx.state === "running";
  }

  /** True while the source has only ever produced digital silence for a
   *  suspiciously long time. Clears itself as soon as any sound arrives. */
  looksBlocked(now = performance.now()): boolean {
    return !this.heardSignal && this.firstSampleAt !== null && now - this.firstSampleAt > BLOCKED_AFTER_MS;
  }

  /**
   * Starts neural voice detection for this video.
   *
   * Preferred path: the capture AudioWorklet resamples to 16 kHz and runs
   * the model on the audio thread, posting only results. If the page blocks
   * the worklet module, the model runs on the main thread instead, fed by
   * stitching the analyser's time-domain buffer on every `sample()` call
   * (using the audio clock to work out which samples are new). That path
   * can drop audio if the page stalls for more than ~40 ms, which the model
   * tolerates.
   */
  /** Average model cost per chunk reported by the worklet (diagnostics). */
  workletModelMs: number | null = null;

  enableNeuralVad(workletUrl: string, weights: SileroWeights, experiment?: "capture-only"): void {
    void loadCaptureModule(this.ctx, workletUrl).then((ok) => {
      if (this.disposed) return;
      if (ok) {
        try {
          // Each tensor gets its own buffer: cloning a view would copy the
          // whole shared weight buffer once per tensor.
          const own: SileroWeights = {};
          for (const [k, t] of Object.entries(weights)) own[k] = { data: t.data.slice(), shape: t.shape };
          const node = new AudioWorkletNode(this.ctx, "adaptive-speed-capture", {
            numberOfInputs: 1,
            numberOfOutputs: 0,
            processorOptions: experiment === "capture-only" ? { forward: false } : { weights: own },
          });
          const voice = new WorkletVoice();
          node.port.onmessage = (e: MessageEvent) => {
            const d = e.data as { p?: number; voice?: boolean; ready?: boolean; slow?: boolean; avgMs?: number; stat?: number };
            if (typeof d.stat === "number") {
              this.workletModelMs = d.stat;
            } else if (d.slow) {
              console.warn(`[AdaptiveSpeed] Speech model too slow on this device (${d.avgMs} ms/chunk); using fallback detector.`);
              this.modelGaveUp = true;
              this.workletVoice = null;
            } else if (typeof d.p === "number") {
              voice.update(d as { p: number; voice: boolean; ready: boolean });
            }
          };
          this.source.connect(node);
          this.captureNode = node;
          this.workletVoice = voice;
          if (this.inputGain !== 1) node.port.postMessage({ gain: this.inputGain });
          return;
        } catch (err) {
          console.warn("[AdaptiveSpeed] Could not start audio-thread capture:", err);
        }
      }
      const stream = new NeuralVoiceStream(weights);
      stream.inputGain = this.inputGain;
      this.mainThreadVoice = stream;
      this.fallbackResampler = new StreamingResampler(this.ctx.sampleRate, SILERO_SAMPLE_RATE, SILERO_CHUNK, (c) =>
        stream.push(c)
      );
    });
  }

  /** The active neural detector, or null (not started, unavailable, or gave up). */
  get voice(): VoiceSource | null {
    if (this.modelGaveUp) return null;
    return this.workletVoice ?? this.mainThreadVoice;
  }

  /** Which path runs the speech model, for diagnostics. */
  get captureMode(): "audio-thread" | "main-thread" | "off" {
    return this.workletVoice ? "audio-thread" : this.mainThreadVoice ? "main-thread" : "off";
  }

  /** Average model cost per 32 ms chunk on the main-thread path (diagnostics). */
  get mainThreadModelMs(): number | null {
    const v = this.mainThreadVoice;
    return v && v.modelChunks ? v.modelMs / v.modelChunks : null;
  }

  /** Compensates for the element's volume in the speech model's input. */
  setInputGain(gain: number): void {
    this.inputGain = gain;
    this.captureNode?.port.postMessage({ gain });
    if (this.mainThreadVoice) this.mainThreadVoice.inputGain = gain;
  }

  /** Pause/resume capture (paused videos feed silence we don't need to analyse). */
  setCaptureActive(active: boolean): void {
    this.captureNode?.port.postMessage({ active });
    if (!active) {
      this.fallbackResampler?.reset();
      this.lastCtxTime = -1;
    }
  }

  /** Drop buffered audio and model state after a seek or source change. */
  resetCapture(): void {
    this.captureNode?.port.postMessage("reset");
    this.workletVoice?.reset();
    this.fallbackResampler?.reset();
    this.mainThreadVoice?.reset();
    this.lastCtxTime = -1;
  }

  /** Pulls one frame of features. Allocation-free copies out of the
   *  analyser's ring buffer, cheap enough for every animation frame. */
  sample(now = performance.now()): AudioFrameFeatures {
    this.analyser.getFloatTimeDomainData(this.timeData);
    this.analyser.getByteFrequencyData(this.freqData);
    if (this.fallbackResampler) this.feedFallbackCapture();

    const rmsDb = computeRmsDb(this.timeData);
    if (this.firstSampleAt === null) this.firstSampleAt = now;
    if (rmsDb > -99) this.heardSignal = true;

    return {
      rmsDb,
      voiceBandRatio: computeVoiceBandRatio(this.freqData, this.ctx.sampleRate, this.analyser.fftSize),
      zeroCrossingRate: computeZeroCrossingRate(this.timeData),
    };
  }

  /** Pushes the samples that arrived since the last read into the resampler. */
  private feedFallbackCapture(): void {
    const t = this.ctx.currentTime;
    if (this.lastCtxTime >= 0) {
      const fresh = Math.round((t - this.lastCtxTime) * this.ctx.sampleRate);
      const n = Math.min(Math.max(fresh, 0), this.timeData.length);
      if (n > 0) this.fallbackResampler!.process(this.timeData.subarray(this.timeData.length - n));
    }
    this.lastCtxTime = t;
  }

  dispose(): void {
    this.disposed = true;
    this.workletVoice = null;
    this.mainThreadVoice = null;
    if (this.captureNode) {
      this.captureNode.port.onmessage = null;
      try {
        this.captureNode.disconnect();
      } catch {
        /* already disconnected */
      }
      this.captureNode = null;
    }
    try {
      this.analyser.disconnect();
      this.source.disconnect();
    } catch {
      /* already disconnected */
    }
    // The element stays routed through Web Audio for life, so keep its
    // sound flowing straight to the speakers.
    this.source.connect(this.ctx.destination);
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