// Audio helpers for the offline detection benchmark (Node, no browser).
import { readFileSync, writeFileSync } from "fs";

export const SR = 48000;

/** Reads a 16-bit PCM WAV (as written by eval/fetch_data.py) into mono floats. */
export function readWav(path: string): Float32Array {
  const b = readFileSync(path);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error(`not a WAV: ${path}`);
  let off = 12;
  let channels = 1;
  let bits = 16;
  let rate = 0;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      channels = b.readUInt16LE(body + 2);
      rate = b.readUInt32LE(body + 4);
      bits = b.readUInt16LE(body + 14);
    } else if (id === "data") {
      if (bits !== 16) throw new Error(`${path}: expected 16-bit PCM`);
      if (rate !== SR) throw new Error(`${path}: expected ${SR} Hz, got ${rate}`);
      const frames = Math.floor(size / (2 * channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < channels; c++) s += b.readInt16LE(body + 2 * (i * channels + c));
        out[i] = s / channels / 32768;
      }
      return out;
    }
    off = body + size + (size & 1);
  }
  throw new Error(`${path}: no data chunk`);
}

/** Deterministic PRNG (mulberry32) so every benchmark run builds identical data. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(r: () => number): number {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

/** Pink noise (Paul Kellet's filter), roughly -3 dB/octave like real room tone. */
export function pinkNoise(n: number, seed: number): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = gaussian(r) * 0.2;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  return out;
}

export function rmsDb(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return 10 * Math.log10(s / Math.max(1, to - from) + 1e-20);
}

/** RMS over only the "active" (labelled speech) samples. */
export function activeRmsDb(x: Float32Array, active: Uint8Array, hop: number): number {
  let s = 0;
  let n = 0;
  for (let f = 0; f < active.length; f++) {
    if (!active[f]) continue;
    for (let i = f * hop; i < Math.min(x.length, (f + 1) * hop); i++) {
      s += x[i]! * x[i]!;
      n++;
    }
  }
  return 10 * Math.log10(s / Math.max(1, n) + 1e-20);
}

export function gain(x: Float32Array, db: number): Float32Array {
  const g = Math.pow(10, db / 20);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i]! * g;
  return out;
}

/** Loops or trims `x` to exactly n samples, starting at `offset`. */
export function fit(x: Float32Array, n: number, offset = 0): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = x[(offset + i) % x.length]!;
  return out;
}

export function addInto(dst: Float32Array, src: Float32Array, at = 0): void {
  for (let i = 0; i < src.length && at + i < dst.length; i++) dst[at + i] += src[i]!;
}

/** Short fade in/out so spliced clips don't click. */
export function fade(x: Float32Array, ms = 10): Float32Array {
  const n = Math.min(Math.floor((SR * ms) / 1000), Math.floor(x.length / 2));
  const out = x.slice();
  for (let i = 0; i < n; i++) {
    const g = i / n;
    out[i] *= g;
    out[out.length - 1 - i] *= g;
  }
  return out;
}

/** Writes mono floats as a 16-bit 48 kHz WAV. */
export function writeWav(path: string, x: Float32Array): void {
  const data = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i]! * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
}
