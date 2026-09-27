// Compares the old and new motion detectors on synthetic scenes whose right
// answer is known. Frames are rendered at 384x216, then box-downsampled to
// each detector's sample size, sampled at 4 fps (the extension default).
//
//   npm run check:motion
import { motionScores, MotionJudge, toLuma, SAMPLE_W, SAMPLE_H } from "../src/vision/motionDetector";
import { meanLumaDelta } from "./baselines/motionV1";
import { rng, gaussian } from "./lib/audio";

const W = 384;
const H = 216;
const FRAMES = 40;

type Frame = Float32Array; // luma, W x H

function slide(seed: number): Frame {
  const r = rng(seed);
  const f = new Float32Array(W * H).fill(235);
  // "text lines" and boxes
  for (let k = 0; k < 60; k++) {
    const x0 = Math.floor(r() * (W - 60));
    const y0 = Math.floor(r() * (H - 8));
    const w = 10 + Math.floor(r() * 50);
    const h = 3 + Math.floor(r() * 5);
    const v = 30 + r() * 80;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) f[y * W + x] = v;
  }
  return f;
}

function texture(seed: number, w: number, h: number): Frame {
  const r = rng(seed);
  const f = new Float32Array(w * h);
  for (let i = 0; i < f.length; i++) f[i] = 110 + 40 * Math.sin((i % w) * 0.05) * Math.cos(Math.floor(i / w) * 0.07);
  // objects with edges (furniture, people, windows), like a real room
  for (let k = 0; k < 40; k++) {
    const x0 = Math.floor(r() * (w - 40)), y0 = Math.floor(r() * (h - 40));
    const bw = 8 + Math.floor(r() * 40), bh = 8 + Math.floor(r() * 40), v = 20 + r() * 215;
    for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) f[y * w + x] = v;
  }
  // smooth a little so it looks like a real scene
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) f[y * w + x] = (f[y * w + x]! * 2 + f[y * w + x - 1]! + f[y * w + x + 1]! + f[(y - 1) * w + x]! + f[(y + 1) * w + x]!) / 6;
  return f;
}

function addGrain(f: Frame, sigma: number, r: () => number): Frame {
  const out = f.slice();
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, out[i]! + sigma * gaussian(r)));
  return out;
}

function square(f: Frame, cx: number, cy: number, size: number, v: number): Frame {
  const out = f.slice();
  for (let y = Math.max(0, cy); y < Math.min(H, cy + size); y++) for (let x = Math.max(0, cx); x < Math.min(W, cx + size); x++) out[y * W + x] = v;
  return out;
}

const scenes: { name: string; expectMotion: boolean; frames: () => Frame[] }[] = [
  { name: "still slide, light grain", expectMotion: false, frames: () => { const s = slide(1), r = rng(2); return Array.from({ length: FRAMES }, () => addGrain(s, 4, r)); } },
  { name: "still slide, heavy grain", expectMotion: false, frames: () => { const s = slide(1), r = rng(3); return Array.from({ length: FRAMES }, () => addGrain(s, 12, r)); } },
  { name: "fade to dark", expectMotion: false, frames: () => { const s = slide(4), r = rng(5); return Array.from({ length: FRAMES }, (_, i) => addGrain(s.map((v) => v * (1 - (0.8 * i) / FRAMES)), 3, r)); } },
  { name: "exposure flicker +/-8%", expectMotion: false, frames: () => { const s = slide(6), r = rng(7); return Array.from({ length: FRAMES }, () => { const g = 1 + 0.16 * (r() - 0.5); return addGrain(s.map((v) => Math.min(255, v * g)), 3, r); }); } },
  { name: "single scene cut", expectMotion: false, frames: () => { const a = slide(8), b = slide(9), r = rng(10); return Array.from({ length: FRAMES }, (_, i) => addGrain(i < 20 ? a : b, 3, r)); } },
  { name: "cursor moving on slide", expectMotion: true, frames: () => { const s = slide(11), r = rng(12); return Array.from({ length: FRAMES }, (_, i) => addGrain(square(s, 40 + ((i * 23) % 300), 60 + ((i * 7) % 100), 7, 0), 3, r)); } },
  { name: "hand gesture (one region)", expectMotion: true, frames: () => { const s = texture(13, W, H), r = rng(14); return Array.from({ length: FRAMES }, (_, i) => addGrain(square(s, 250 + Math.round(25 * Math.sin(i * 1.3)), 120 + Math.round(15 * Math.cos(i * 1.1)), 40, 200), 4, r)); } },
  { name: "camera pan", expectMotion: true, frames: () => { const big = texture(15, W + 400, H), r = rng(16); return Array.from({ length: FRAMES }, (_, i) => { const f = new Float32Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) f[y * W + x] = big[y * (W + 400) + x + i * 8]!; return addGrain(f, 3, r); }); } },
  { name: "speaker still, grain", expectMotion: false, frames: () => { const s = texture(17, W, H), r = rng(18); return Array.from({ length: FRAMES }, () => addGrain(s, 6, r)); } },
];

function downsample(f: Frame, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const sx = W / w, sy = H / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let yy = Math.floor(y * sy); yy < Math.floor((y + 1) * sy); yy++) for (let xx = Math.floor(x * sx); xx < Math.floor((x + 1) * sx); xx++) { s += f[yy * W + xx]!; n++; }
    out[y * w + x] = s / n;
  }
  return out;
}
function rgba(l: Float32Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(l.length * 4);
  for (let i = 0; i < l.length; i++) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = l[i]!; out[i * 4 + 3] = 255; }
  return out;
}

let wrong = 0;
console.log("% of samples judged 'moving' (want ~0% for still scenes, high for moving ones)\n");
console.log("scene".padEnd(30), "expect".padEnd(8), "old".padStart(6), "new".padStart(6));
for (const sc of scenes) {
  const frames = sc.frames();
  // old: 48x27 RGBA, mean luma delta >= motionThreshold (10)
  let oldHits = 0;
  let prevOld: Uint8ClampedArray | null = null;
  // new
  const judge = new MotionJudge();
  let newHits = 0;
  let prevNew: Float32Array | null = null;
  for (const f of frames) {
    const o = rgba(downsample(f, 48, 27));
    if (prevOld && meanLumaDelta(prevOld, o) >= 10) oldHits++;
    prevOld = o;
    const n = toLuma(rgba(downsample(f, SAMPLE_W, SAMPLE_H)), new Float32Array(SAMPLE_W * SAMPLE_H));
    if (prevNew) {
      const sc2 = motionScores(prevNew, n, SAMPLE_W, SAMPLE_H);
      if (process.env.SHOW && frames.indexOf(f) < 6) console.log("   ", sc.name.slice(0, 12), "local", sc2.local.toFixed(2), "global", sc2.global.toFixed(2));
      if (judge.update(sc2, 10)) newHits++;
    }
    prevNew = n;
  }
  const pOld = (100 * oldHits) / (frames.length - 1);
  const pNew = (100 * newHits) / (frames.length - 1);
  const ok = sc.expectMotion ? pNew > 50 : pNew < 5;
  if (!ok) wrong++;
  console.log(sc.name.padEnd(30), (sc.expectMotion ? "moving" : "still").padEnd(8), `${pOld.toFixed(0)}%`.padStart(6), `${pNew.toFixed(0)}%`.padStart(6), ok ? "" : "  <-- wrong");
}
process.exit(wrong ? 1 : 0);
