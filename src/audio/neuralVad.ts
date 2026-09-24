import { parseSileroWeights, SileroVadModel, SILERO_CHUNK, type SileroWeights } from "./sileroVad";

/** Speech starts when the model's probability reaches this... */
export const SPEECH_ON = 0.5;
/** ...and ends only once it falls below this (Silero's own recommended
 *  hysteresis, which keeps short dips between syllables inside speech). */
export const SPEECH_OFF = 0.35;

/** Chunks quieter than this (RMS, dBFS) are digital silence: a muted video,
 *  or true silence in the file. Once silence has lasted a while the model is
 *  skipped and they count as silence, so muted autoplay videos cost nothing.
 *
 *  It must sit well below any real room tone. At -70 dB, a quiet recording
 *  whose room noise hovered around the limit had the model skipped for some
 *  chunks and not others; each skip froze the model's memory at the last
 *  word, so the next faint noise chunk read as more speech (24 false speech
 *  starts in the pauses of a 3-minute quiet talk, each one cancelling a
 *  speed-up). */
const SILENT_CHUNK_DB = -90;
const SILENT_CHUNK_MS2 = Math.pow(10, SILENT_CHUNK_DB / 10);
/** The model keeps running for this many silent chunks (~256 ms) before it
 *  is skipped, so its memory has settled to "silence" by then. */
const SILENT_CHUNKS_BEFORE_SKIP = 8;

/** performance.now() isn't available on the audio thread. */
const clock = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** What the pipeline needs from any neural voice detector, wherever it runs. */
export interface VoiceSource {
  readonly isVoice: boolean;
  readonly probability: number;
  /** Heard enough audio (~100 ms) to be trusted. */
  readonly ready: boolean;
}

/**
 * Wraps the Silero model for a continuous 16 kHz stream: feeds it 512-sample
 * chunks, keeps the latest probability, and turns it into a stable
 * speech / not-speech decision with hysteresis.
 */
export class NeuralVoiceStream implements VoiceSource {
  private readonly model: SileroVadModel;
  private pending = new Float32Array(SILERO_CHUNK);
  private pendingLen = 0;
  private speaking = false;
  private lastProb = 0;
  private chunksSeen = 0;
  private silentRun = 0;
  /** Undoes the player's volume (Chrome applies it before Web Audio), so
   *  the model hears the same level at 20% volume as at 100%. */
  inputGain = 1;
  /** Total time spent running the model, for diagnostics. */
  modelMs = 0;
  modelChunks = 0;

  constructor(weights: SileroWeights) {
    this.model = new SileroVadModel(weights);
  }

  /** Call when the audio jumps (seek, new source) so no stale state leaks. */
  reset(): void {
    this.model.reset();
    this.pendingLen = 0;
    this.speaking = false;
    this.lastProb = 0;
    this.chunksSeen = 0;
    this.silentRun = 0;
  }

  /** Accepts any number of 16 kHz samples. */
  push(samples: Float32Array): void {
    let i = 0;
    while (i < samples.length) {
      const take = Math.min(SILERO_CHUNK - this.pendingLen, samples.length - i);
      if (this.inputGain === 1) {
        this.pending.set(samples.subarray(i, i + take), this.pendingLen);
      } else {
        for (let k = 0; k < take; k++) this.pending[this.pendingLen + k] = samples[i + k]! * this.inputGain;
      }
      this.pendingLen += take;
      i += take;
      if (this.pendingLen === SILERO_CHUNK) {
        let ms2 = 0;
        for (let k = 0; k < SILERO_CHUNK; k++) ms2 += this.pending[k]! * this.pending[k]!;
        this.silentRun = ms2 / SILERO_CHUNK < SILENT_CHUNK_MS2 ? this.silentRun + 1 : 0;
        if (this.silentRun > SILENT_CHUNKS_BEFORE_SKIP) {
          this.lastProb = 0;
        } else {
          const t0 = clock();
          this.lastProb = this.model.process(this.pending);
          this.modelMs += clock() - t0;
          this.modelChunks++;
        }
        this.pendingLen = 0;
        this.chunksSeen++;
        if (this.speaking) {
          if (this.lastProb < SPEECH_OFF) this.speaking = false;
        } else if (this.lastProb >= SPEECH_ON) {
          this.speaking = true;
        }
      }
    }
  }

  get isVoice(): boolean {
    return this.speaking;
  }

  get probability(): number {
    return this.lastProb;
  }

  /** Whether the model has heard enough audio to be trusted (~100 ms). */
  get ready(): boolean {
    return this.chunksSeen >= 3;
  }
}

let weightsPromise: Promise<SileroWeights | null> | null = null;

/**
 * Loads the model weights once per frame and shares them between all videos.
 * Resolves to null (and the pipeline falls back to the DSP heuristic) if the
 * file can't be fetched, e.g. when the extension context was invalidated.
 */
export function loadSileroWeights(url: string): Promise<SileroWeights | null> {
  if (!weightsPromise) {
    weightsPromise = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then(parseSileroWeights)
      .catch((err) => {
        console.warn("[AdaptiveSpeed] Neural voice detection unavailable, using fallback:", err);
        return null;
      });
  }
  return weightsPromise;
}
