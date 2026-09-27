// Emulates Chrome's AnalyserNode (third_party/blink/.../realtime_analyser.cc)
// closely enough that the DSP heuristic sees the same numbers offline as in
// the browser: Blackman window (alpha 0.16), FFT magnitude scaled by 2/N
// (Chrome's FFTFrame matches vDSP's 2x convention, then divides by N),
// exponential smoothing across calls, dB -> byte over [minDb, maxDb].

class FFT {
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;
  constructor(readonly n: number) {
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0, v = i; b < bits; b++, v >>= 1) r = (r << 1) | (v & 1);
      this.rev[i] = r;
    }
  }
  run(re: Float64Array, im: Float64Array): void {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i]!;
      if (j > i) {
        let t = re[i]!; re[i] = re[j]!; re[j] = t;
        t = im[i]!; im[i] = im[j]!; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let s = 0; s < n; s += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step]!;
          const wi = -this.sin[k * step]!;
          const a = s + k;
          const b = a + half;
          const xr = re[b]! * wr - im[b]! * wi;
          const xi = re[b]! * wi + im[b]! * wr;
          re[b] = re[a]! - xr; im[b] = im[a]! - xi;
          re[a] = re[a]! + xr; im[a] = im[a]! + xi;
        }
      }
    }
  }
}

export class AnalyserSim {
  readonly timeData: Float32Array;
  readonly freqData: Uint8Array;
  private readonly smoothed: Float64Array;
  private readonly window: Float64Array;
  private readonly fft: FFT;
  private readonly re: Float64Array;
  private readonly im: Float64Array;

  constructor(
    readonly fftSize = 2048,
    readonly smoothing = 0.15,
    readonly minDb = -100,
    readonly maxDb = -30
  ) {
    this.timeData = new Float32Array(fftSize);
    this.freqData = new Uint8Array(fftSize / 2);
    this.smoothed = new Float64Array(fftSize / 2);
    this.window = new Float64Array(fftSize);
    const alpha = 0.16;
    for (let i = 0; i < fftSize; i++) {
      const x = i / fftSize;
      this.window[i] = 0.5 * (1 - alpha) - 0.5 * Math.cos(2 * Math.PI * x) + 0.5 * alpha * Math.cos(4 * Math.PI * x);
    }
    this.fft = new FFT(fftSize);
    this.re = new Float64Array(fftSize);
    this.im = new Float64Array(fftSize);
  }

  reset(): void {
    this.smoothed.fill(0);
  }

  /** Equivalent of reading both getFloatTimeDomainData and
   *  getByteFrequencyData with the playhead at sample `pos`. */
  read(signal: Float32Array, pos: number): void {
    const n = this.fftSize;
    for (let i = 0; i < n; i++) {
      const idx = pos - n + i;
      const v = idx >= 0 && idx < signal.length ? signal[idx]! : 0;
      this.timeData[i] = v;
      this.re[i] = v * this.window[i]!;
      this.im[i] = 0;
    }
    this.fft.run(this.re, this.im);
    const k = this.smoothing;
    const scale = 2 / n;
    const range = 1 / (this.maxDb - this.minDb);
    for (let i = 0; i < n / 2; i++) {
      const im = i === 0 ? 0 : this.im[i]!;
      const mag = Math.hypot(this.re[i]!, im) * scale;
      const s = k * this.smoothed[i]! + (1 - k) * mag;
      this.smoothed[i] = s;
      const db = s > 0 ? 20 * Math.log10(s) : -1000;
      let v = 255 * (db - this.minDb) * range;
      if (v < 0) v = 0;
      if (v > 255) v = 255;
      this.freqData[i] = v | 0;
    }
  }
}
