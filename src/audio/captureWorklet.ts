/**
 * AudioWorklet processor: taps the video's audio on the audio thread, mixes
 * it to mono, converts it to 16 kHz, and runs the Silero speech model right
 * there, posting only the result (~31 small messages a second) to the page.
 *
 * Why the audio thread: measured in Chrome on macOS, running the model on
 * the page's main thread cost ~14% of a CPU core, because 0.5 ms bursts every
 * 32 ms get scheduled on slow efficiency cores. The audio thread is a
 * real-time thread, so the same work finishes in well under a millisecond,
 * and the page's main thread does no model work at all (nothing that could
 * make the site feel laggy).
 *
 * Safety: the model's cost is timed. If it averages more than SLOW_MS per
 * chunk (a very slow machine), the model is switched off here to protect
 * audio playback, and the page falls back to the lightweight DSP detector.
 *
 * Built as its own file (capture-worklet.js), loaded with addModule(). It
 * has no outputs, so it never alters what the user hears.
 *
 * processorOptions: { weights?: SileroWeights } — without weights it only
 *   streams raw 16 kHz chunks (Float32Array) for main-thread analysis.
 * Messages in:  "reset" (after a seek) | { active: boolean } (pause/resume)
 * Messages out: { p, voice, ready } per 32 ms chunk | { slow: true } | Float32Array chunks (no weights)
 */
import { StreamingResampler } from "./resampler";
import { NeuralVoiceStream } from "./neuralVad";
import type { SileroWeights } from "./sileroVad";

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const SLOW_MS = 6;

class SpeechCaptureProcessor extends AudioWorkletProcessor {
  private readonly resampler: StreamingResampler;
  private stream: NeuralVoiceStream | null = null;
  private mono = new Float32Array(128);
  private active = true;
  private costMs = 0;
  private costChunks = 0;
  private readonly forward: boolean;

  constructor(options?: { processorOptions?: { weights?: SileroWeights; forward?: boolean } }) {
    super();
    const weights = options?.processorOptions?.weights;
    this.forward = options?.processorOptions?.forward !== false;
    if (weights) {
      try {
        this.stream = new NeuralVoiceStream(weights);
      } catch {
        this.stream = null;
      }
    }
    this.resampler = new StreamingResampler(sampleRate, 16000, 512, (chunk) => this.onChunk(chunk));
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data === "reset") {
        this.resampler.reset();
        this.stream?.reset();
      } else if (e.data && typeof e.data === "object" && "gain" in e.data) {
        if (this.stream) this.stream.inputGain = Number((e.data as { gain: number }).gain) || 1;
      } else if (e.data && typeof e.data === "object" && "active" in e.data) {
        this.active = Boolean((e.data as { active: boolean }).active);
        if (!this.active) this.resampler.reset();
      }
    };
  }

  private onChunk(chunk: Float32Array): void {
    const stream = this.stream;
    if (!stream) {
      if (this.forward) this.port.postMessage(chunk, [chunk.buffer]);
      return;
    }
    const t0 = Date.now();
    stream.push(chunk);
    this.costMs += Date.now() - t0;
    this.costChunks++;
    this.port.postMessage({ p: stream.probability, voice: stream.isVoice, ready: stream.ready });
    if (this.costChunks >= 200) {
      const avg = this.costMs / this.costChunks;
      this.costMs = 0;
      this.costChunks = 0;
      this.port.postMessage({ stat: avg });
      if (avg > SLOW_MS) {
        this.stream = null;
        this.port.postMessage({ slow: true, avgMs: avg });
      }
    }
  }

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];
    if (!this.active || !channels || channels.length === 0) return true;
    const first = channels[0]!;
    const n = first.length;
    if (this.mono.length !== n) this.mono = new Float32Array(n);
    if (channels.length === 1) {
      this.mono.set(first);
    } else {
      const k = 1 / channels.length;
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let c = 0; c < channels.length; c++) s += channels[c]![i]!;
        this.mono[i] = s * k;
      }
    }
    this.resampler.process(this.mono);
    return true;
  }
}

registerProcessor("adaptive-speed-capture", SpeechCaptureProcessor);
