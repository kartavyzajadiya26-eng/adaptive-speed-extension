/**
 * Silero VAD v5 (16 kHz), implemented directly in TypeScript.
 *
 * Silero is a small neural voice-activity model (MIT licence, snakers4/silero-vad)
 * trained to separate speech from music, noise and other non-speech sound —
 * the cases the old loudness/frequency heuristic got wrong. The usual way to
 * run it in a browser is onnxruntime-web, which adds a 14 MB WebAssembly
 * binary and needs 'wasm-unsafe-eval', something many sites' security
 * policies make awkward for content scripts. The 16 kHz network is small
 * enough (~310k weights) to evaluate by hand instead:
 *
 *   576 samples (64 context + 512 new)
 *     -> reflect-pad 64 -> STFT (periodic Hann, 256-point, hop 128) -> magnitude (129 x 4)
 *     -> conv 129->128 k3 s1 -> ReLU -> conv 128->64 k3 s2 -> ReLU
 *     -> conv 64->64 k3 s2 -> ReLU -> conv 64->128 k3 s1 -> ReLU   (128 x 1)
 *     -> LSTM cell (128 hidden) -> ReLU -> 1x1 conv -> sigmoid = speech probability
 *
 * Weights come from eval/export_silero.py, and eval/checkSilero.ts verifies
 * this implementation against onnxruntime's output on the same audio.
 * The model stores its STFT as a 258x256 convolution basis; that basis is
 * exactly a periodic-Hann-windowed DFT (checked to 6e-8), so we compute it
 * with a 256-point FFT instead, which is ~50x less work for that stage and
 * lets the weight file omit the basis.
 */

export const SILERO_SAMPLE_RATE = 16000;
export const SILERO_CHUNK = 512;
const CONTEXT = 64;
const HIDDEN = 128;
const N_BINS = 129;
const N_FRAMES = 4;

interface Tensor {
  data: Float32Array;
  shape: number[];
}

export type SileroWeights = Record<string, Tensor>;

/** Parses the "SVAD" weight file written by eval/export_silero.py. */
export function parseSileroWeights(buffer: ArrayBuffer): SileroWeights {
  const bytes = new Uint8Array(buffer);
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== "SVAD") throw new Error("not a Silero weight file");
  const manifestLen = new DataView(buffer).getUint32(4, true);
  const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + manifestLen))) as {
    tensors: { name: string; shape: number[]; offset: number }[];
  };
  const floats = new Float32Array(buffer, 8 + manifestLen);
  const weights: SileroWeights = {};
  for (const t of manifest.tensors) {
    const size = t.shape.reduce((a, b) => a * b, 1);
    weights[t.name] = { data: floats.subarray(t.offset, t.offset + size), shape: t.shape };
  }
  return weights;
}

/**
 * Conv1d (kernel 3, padding 1) + ReLU, computed as a small matrix multiply:
 * the input is first unrolled into columns (im2col), so the hot loop reads
 * each weight once and updates every output position with it — no per-tap
 * bounds checks, and long straight loops the JIT optimises well.
 *   out[co][lo] = relu(b[co] + sum_r w[co][r] * cols[r][lo]),  r = ci*3 + k
 */
function conv1dK3Relu(
  input: Float32Array,
  cin: number,
  lin: number,
  wq: QuantMatrix,
  b: Float32Array,
  cout: number,
  stride: number,
  cols: Float32Array,
  out: Float32Array
): number {
  const lout = Math.floor((lin + 2 - 3) / stride) + 1;
  const rows = cin * 3;
  const w = wq.q;
  const sc = wq.scale;
  // cols[r * lout + lo] = input[ci][lo*stride + k - 1] (0 outside)
  for (let ci = 0; ci < cin; ci++) {
    for (let k = 0; k < 3; k++) {
      const r = (ci * 3 + k) * lout;
      for (let lo = 0; lo < lout; lo++) {
        const li = lo * stride + k - 1;
        cols[r + lo] = li >= 0 && li < lin ? input[ci * lin + li]! : 0;
      }
    }
  }
  if (lout === 4) {
    for (let co = 0; co < cout; co++) {
      const wo = co * rows;
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
      for (let r = 0, c = 0; r < rows; r++, c += 4) {
        const wv = w[wo + r]!;
        a0 += wv * cols[c]!;
        a1 += wv * cols[c + 1]!;
        a2 += wv * cols[c + 2]!;
        a3 += wv * cols[c + 3]!;
      }
      const o = co * 4;
      const s = sc[co]!;
      const bb = b[co]!;
      a0 = bb + s * a0; a1 = bb + s * a1; a2 = bb + s * a2; a3 = bb + s * a3;
      out[o] = a0 > 0 ? a0 : 0;
      out[o + 1] = a1 > 0 ? a1 : 0;
      out[o + 2] = a2 > 0 ? a2 : 0;
      out[o + 3] = a3 > 0 ? a3 : 0;
    }
  } else if (lout === 2) {
    for (let co = 0; co < cout; co++) {
      const wo = co * rows;
      let a0 = 0, a1 = 0;
      for (let r = 0, c = 0; r < rows; r++, c += 2) {
        const wv = w[wo + r]!;
        a0 += wv * cols[c]!;
        a1 += wv * cols[c + 1]!;
      }
      const s = sc[co]!;
      const bb = b[co]!;
      a0 = bb + s * a0; a1 = bb + s * a1;
      out[co * 2] = a0 > 0 ? a0 : 0;
      out[co * 2 + 1] = a1 > 0 ? a1 : 0;
    }
  } else {
    for (let co = 0; co < cout; co++) {
      const wo = co * rows;
      for (let lo = 0; lo < lout; lo++) {
        let a = 0;
        for (let r = 0; r < rows; r++) a += w[wo + r]! * cols[r * lout + lo]!;
        a = b[co]! + sc[co]! * a;
        out[co * lout + lo] = a > 0 ? a : 0;
      }
    }
  }
  return lout;
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/**
 * Weights are kept as int8 with one float scale per output row. The model
 * runs once every 32 ms, and between runs the playing video evicts its
 * weights from the CPU cache; measured in Chrome, reloading ~1 MB of float
 * weights made each run ~5x slower than the same code in a tight loop.
 * int8 cuts that to ~250 KB. Accuracy is checked in eval/checkSilero.ts.
 */
interface QuantMatrix {
  q: Int8Array | Int16Array;
  scale: Float32Array; // per row
  cols: number;
}
export const QUANT_BITS = { conv: 16, lstm: 16 };
function quantizeRows(w: Float32Array, rows: number, cols: number, bits: number): QuantMatrix {
  const q = bits === 8 ? new Int8Array(rows * cols) : new Int16Array(rows * cols);
  const levels = bits === 8 ? 127 : 32767;
  const scale = new Float32Array(rows);
  for (let r = 0; r < rows; r++) {
    let max = 0;
    for (let c = 0; c < cols; c++) max = Math.max(max, Math.abs(w[r * cols + c]!));
    const sc = max > 0 ? max / levels : 1;
    scale[r] = sc;
    for (let c = 0; c < cols; c++) q[r * cols + c] = Math.round(w[r * cols + c]! / sc);
  }
  return { q, scale, cols };
}

const FFT_N = 256;
const HANN = new Float32Array(FFT_N);
const COS = new Float32Array(FFT_N / 2);
const SIN = new Float32Array(FFT_N / 2);
const BITREV = new Uint16Array(FFT_N);
for (let i = 0; i < FFT_N; i++) {
  HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_N);
  let r = 0;
  for (let b = 0, v = i; b < 8; b++, v >>= 1) r = (r << 1) | (v & 1);
  BITREV[i] = r;
}
for (let i = 0; i < FFT_N / 2; i++) {
  COS[i] = Math.cos((2 * Math.PI * i) / FFT_N);
  SIN[i] = Math.sin((2 * Math.PI * i) / FFT_N);
}

/** In-place iterative radix-2 FFT of length 256. */
function fft256(re: Float32Array, im: Float32Array): void {
  for (let i = 0; i < FFT_N; i++) {
    const j = BITREV[i]!;
    if (j > i) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  for (let size = 2; size <= FFT_N; size <<= 1) {
    const half = size >> 1;
    const step = FFT_N / size;
    for (let start = 0; start < FFT_N; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = COS[k * step]!;
        const wi = -SIN[k * step]!;
        const a = start + k;
        const b = a + half;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
    }
  }
}

export class SileroVadModel {
  private readonly enc: { w: QuantMatrix; b: Float32Array; cin: number; cout: number; stride: number }[];
  /** LSTM weights with [W_ih | W_hh] side by side per gate row (512 x 256),
   *  so each gate is one dot product with the concatenated [x ; h] vector. */
  private readonly wcat: QuantMatrix;
  private readonly bias: Float32Array; // bias_ih + bias_hh, pre-summed
  private readonly decW: Float32Array;
  private readonly decB: number;

  // Recurrent state and scratch buffers (allocated once).
  private readonly h = new Float32Array(HIDDEN);
  private readonly c = new Float32Array(HIDDEN);
  private readonly context = new Float32Array(CONTEXT);
  private readonly padded = new Float32Array(CONTEXT + SILERO_CHUNK + 64);
  private readonly mag = new Float32Array(N_BINS * N_FRAMES);
  private readonly bufA = new Float32Array(128 * 4);
  private readonly bufB = new Float32Array(128 * 4);
  private readonly gates = new Float32Array(4 * HIDDEN);
  private readonly xh = new Float32Array(2 * HIDDEN);
  private readonly cols = new Float32Array(129 * 3 * 4);
  private readonly fftRe = new Float32Array(FFT_N);
  private readonly fftIm = new Float32Array(FFT_N);

  constructor(weights: SileroWeights) {
    const get = (name: string): Float32Array => {
      const t = weights[name];
      if (!t) throw new Error(`missing Silero tensor ${name}`);
      return t.data;
    };
    const conv = (i: number, cin: number, cout: number, stride: number) => ({
      w: quantizeRows(get(`encoder.${i}.reparam_conv.weight`), cout, cin * 3, QUANT_BITS.conv),
      b: get(`encoder.${i}.reparam_conv.bias`),
      cin,
      cout,
      stride,
    });
    this.enc = [conv(0, 129, 128, 1), conv(1, 128, 64, 2), conv(2, 64, 64, 2), conv(3, 64, 128, 1)];
    const wih = get("decoder.rnn.weight_ih");
    const whh = get("decoder.rnn.weight_hh");
    const cat = new Float32Array(4 * HIDDEN * 2 * HIDDEN);
    for (let r = 0; r < 4 * HIDDEN; r++) {
      cat.set(wih.subarray(r * HIDDEN, (r + 1) * HIDDEN), r * 2 * HIDDEN);
      cat.set(whh.subarray(r * HIDDEN, (r + 1) * HIDDEN), r * 2 * HIDDEN + HIDDEN);
    }
    this.wcat = quantizeRows(cat, 4 * HIDDEN, 2 * HIDDEN, QUANT_BITS.lstm);
    const bih = get("decoder.rnn.bias_ih");
    const bhh = get("decoder.rnn.bias_hh");
    this.bias = new Float32Array(4 * HIDDEN);
    for (let i = 0; i < this.bias.length; i++) this.bias[i] = bih[i]! + bhh[i]!;
    this.decW = get("decoder.decoder.2.weight");
    this.decB = get("decoder.decoder.2.bias")[0]!;
  }

  /** Clears recurrent state; call when the audio stream is discontinuous. */
  reset(): void {
    this.h.fill(0);
    this.c.fill(0);
    this.context.fill(0);
  }

  /** Speech probability (0..1) for the next 512 samples of 16 kHz mono audio. */
  process(chunk: Float32Array): number {
    const n = CONTEXT + SILERO_CHUNK; // 576
    const x = this.padded;
    x.set(this.context, 0);
    x.set(chunk.subarray(0, SILERO_CHUNK), CONTEXT);
    // Reflect-pad 64 samples on the right: x[n + k] = x[n - 2 - k].
    for (let k = 0; k < 64; k++) x[n + k] = x[n - 2 - k]!;
    this.context.set(chunk.subarray(SILERO_CHUNK - CONTEXT, SILERO_CHUNK));

    // STFT magnitude: Hann-windowed 256-point FFT of 4 frames, hop 128.
    const mag = this.mag;
    const re = this.fftRe;
    const im = this.fftIm;
    for (let f = 0; f < N_FRAMES; f++) {
      const off = f * 128;
      for (let k = 0; k < FFT_N; k++) {
        re[k] = x[off + k]! * HANN[k]!;
        im[k] = 0;
      }
      fft256(re, im);
      for (let bin = 0; bin < N_BINS; bin++) {
        mag[bin * N_FRAMES + f] = Math.sqrt(re[bin]! * re[bin]! + im[bin]! * im[bin]!);
      }
    }

    // Encoder.
    let input = mag;
    let len = N_FRAMES;
    let out = this.bufA;
    for (const layer of this.enc) {
      len = conv1dK3Relu(input, layer.cin, len, layer.w, layer.b, layer.cout, layer.stride, this.cols, out);
      input = out;
      out = out === this.bufA ? this.bufB : this.bufA;
    }
    // `input` now holds 128 features (length 1).

    // LSTM cell, PyTorch gate order: input, forget, cell, output.
    const g = this.gates;
    const h = this.h;
    const xh = this.xh;
    for (let j = 0; j < HIDDEN; j++) {
      xh[j] = input[j]!;
      xh[HIDDEN + j] = h[j]!;
    }
    const wc = this.wcat.q;
    const wsc = this.wcat.scale;
    const n2 = 2 * HIDDEN;
    for (let r = 0; r < 4 * HIDDEN; r++) {
      const row = r * n2;
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
      for (let j = 0; j < n2; j += 4) {
        a0 += wc[row + j]! * xh[j]!;
        a1 += wc[row + j + 1]! * xh[j + 1]!;
        a2 += wc[row + j + 2]! * xh[j + 2]!;
        a3 += wc[row + j + 3]! * xh[j + 3]!;
      }
      g[r] = this.bias[r]! + wsc[r]! * (a0 + a1 + a2 + a3);
    }
    let logit = this.decB;
    for (let j = 0; j < HIDDEN; j++) {
      const i = sigmoid(g[j]!);
      const f = sigmoid(g[HIDDEN + j]!);
      const cc = Math.tanh(g[2 * HIDDEN + j]!);
      const o = sigmoid(g[3 * HIDDEN + j]!);
      const cNew = f * this.c[j]! + i * cc;
      this.c[j] = cNew;
      const hNew = o * Math.tanh(cNew);
      h[j] = hNew;
      if (hNew > 0) logit += this.decW[j]! * hNew;
    }
    return sigmoid(logit);
  }
}
