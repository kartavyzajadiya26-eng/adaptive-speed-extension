/**
 * Streaming sample-rate converter (any rate -> any rate) with an
 * anti-aliasing windowed-sinc low-pass, used to turn the page's 44.1/48 kHz
 * audio into the 16 kHz stream the Silero model expects.
 *
 * Runs inside the AudioWorklet (audio thread), so it allocates nothing per
 * call apart from emitted chunks. Quality target is "a speech model can't
 * tell the difference", not hi-fi: 48 taps, Blackman window, cutoff at 45%
 * of the output rate (7.2 kHz for 16 kHz output), nearest of 256 phases.
 */
const HALF = 24;
const TAPS = HALF * 2;
const PHASES = 256;

export class StreamingResampler {
  private readonly step: number;
  private readonly table: Float32Array;
  private buf: Float32Array;
  private bufLen: number;
  private pos: number;
  private readonly out: Float32Array;
  private outLen = 0;

  constructor(
    inRate: number,
    outRate: number,
    private readonly chunkSize: number,
    private readonly onChunk: (chunk: Float32Array) => void
  ) {
    this.step = inRate / outRate;
    const fc = 0.45 * Math.min(1, outRate / inRate); // cycles per input sample
    this.table = new Float32Array((PHASES + 1) * TAPS);
    for (let p = 0; p <= PHASES; p++) {
      for (let j = 0; j < TAPS; j++) {
        const d = p / PHASES + HALF - 1 - j; // distance in input samples
        const x = 2 * fc * d;
        const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const u = (d + HALF) / (2 * HALF); // 0..1 across the window
        const blackman = 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u);
        this.table[p * TAPS + j] = 2 * fc * sinc * Math.max(0, blackman);
      }
    }
    // HALF samples of silent history so the first output is well defined.
    this.buf = new Float32Array(4096);
    this.bufLen = HALF;
    this.pos = HALF;
    this.out = new Float32Array(chunkSize);
  }

  /** Clears history, e.g. after a seek. */
  reset(): void {
    this.buf.fill(0, 0, HALF);
    this.bufLen = HALF;
    this.pos = HALF;
    this.outLen = 0;
  }

  process(input: Float32Array): void {
    if (this.bufLen + input.length > this.buf.length) {
      const bigger = new Float32Array(Math.max(this.buf.length * 2, this.bufLen + input.length));
      bigger.set(this.buf.subarray(0, this.bufLen));
      this.buf = bigger;
    }
    this.buf.set(input, this.bufLen);
    this.bufLen += input.length;

    const buf = this.buf;
    const table = this.table;
    while (Math.floor(this.pos) + HALF < this.bufLen) {
      const ip = Math.floor(this.pos);
      const row = Math.round((this.pos - ip) * PHASES) * TAPS;
      const base = ip - HALF + 1;
      let y = 0;
      for (let j = 0; j < TAPS; j++) y += table[row + j]! * buf[base + j]!;
      this.out[this.outLen++] = y;
      if (this.outLen === this.chunkSize) {
        this.onChunk(this.out.slice());
        this.outLen = 0;
      }
      this.pos += this.step;
    }

    const drop = Math.floor(this.pos) - HALF + 1;
    if (drop > 0) {
      buf.copyWithin(0, drop, this.bufLen);
      this.bufLen -= drop;
      this.pos -= drop;
    }
  }
}
