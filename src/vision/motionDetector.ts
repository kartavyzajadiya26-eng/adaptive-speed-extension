/**
 * Frame-difference motion detector — the "computer vision" piece, kept
 * deliberately model-free: the question is only "did something in the
 * picture move", which cheap image statistics answer well.
 *
 * How it works:
 *  1. Draw the current frame into a small offscreen canvas (96x54).
 *  2. Per-pixel luma difference against the previous sample, with the
 *     frame's average brightness shift removed first, so fades, exposure
 *     changes and flicker don't count as motion.
 *  3. Split the difference image into an 8x6 grid of blocks and score two
 *     things (see motionScores):
 *       local  — how much the busiest block stands out from the typical
 *                block. Catches small movement (a cursor, a hand) that a
 *                whole-frame average dilutes to nothing, while ignoring
 *                camera grain, which raises every block equally.
 *       global — the typical block's change, compared against a learned
 *                noise floor. Catches pans and whole-scene movement.
 *  4. Motion must persist across two consecutive samples, so a single
 *     scene cut or compression glitch doesn't count.
 *
 * The previous version compared the mean absolute difference of a 48x27
 * thumbnail with a threshold, so camera grain and fades read as motion and
 * a moving cursor didn't. eval/motionCheck.ts compares both on synthetic
 * scenes.
 *
 * KNOWN LIMITATION — tainted canvas: drawImage + getImageData on a
 * cross-origin video without CORS throws a SecurityError. The first one
 * flags this detector `tainted` and it stops sampling; the pipeline then
 * behaves as audio-only for that video.
 */

export const SAMPLE_W = 96;
export const SAMPLE_H = 54;
const GRID_X = 8;
const GRID_Y = 6;

export interface MotionScores {
  /** Busiest block minus the median block (0-255 luma units). */
  local: number;
  /** Median block change (0-255 luma units). */
  global: number;
}

/** Luma (Rec. 601) of an RGBA buffer into a reusable Float32Array. */
export function toLuma(rgba: Uint8ClampedArray | Uint8Array, out: Float32Array): Float32Array {
  for (let i = 0, p = 0; p < out.length; i += 4, p++) {
    out[p] = 0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!;
  }
  return out;
}

/** Scores the change between two luma frames of size w x h. */
export function motionScores(prev: Float32Array, cur: Float32Array, w: number, h: number): MotionScores {
  const n = w * h;
  let shift = 0;
  for (let i = 0; i < n; i++) shift += cur[i]! - prev[i]!;
  shift /= n; // average brightness change: fades, exposure, flicker

  const bw = Math.floor(w / GRID_X);
  const bh = Math.floor(h / GRID_Y);
  const blocks = new Float32Array(GRID_X * GRID_Y);
  for (let by = 0; by < GRID_Y; by++) {
    for (let bx = 0; bx < GRID_X; bx++) {
      let sum = 0;
      for (let y = by * bh; y < (by + 1) * bh; y++) {
        const row = y * w;
        for (let x = bx * bw; x < (bx + 1) * bw; x++) sum += Math.abs(cur[row + x]! - prev[row + x]! - shift);
      }
      blocks[by * GRID_X + bx] = sum / (bw * bh);
    }
  }
  const sorted = Array.from(blocks).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return { local: sorted[sorted.length - 1]! - median, global: median };
}

/** Local-motion score (luma units) that counts as movement at the default
 *  motionThreshold of 10; the user setting scales both thresholds. */
const LOCAL_AT_DEFAULT = 6;
/** Global change above the learned noise floor that counts as movement. */
const GLOBAL_AT_DEFAULT = 3;
const DEFAULT_THRESHOLD_SETTING = 10;
const INITIAL_FLOOR = 2;

/**
 * Stateful decision on top of motionScores: learned noise floor for the
 * global score, and two-sample persistence.
 */
export class MotionJudge {
  private globalFloor = -1;
  private streak = 0;

  reset(): void {
    this.globalFloor = -1;
    this.streak = 0;
  }

  /** `threshold` is the user's motionThreshold setting (default 10). */
  update(scores: MotionScores, threshold: number): boolean {
    const k = threshold / DEFAULT_THRESHOLD_SETTING;
    // Start the floor no higher than typical light grain, so a video that
    // opens mid-pan doesn't learn the pan as its baseline.
    if (this.globalFloor < 0) this.globalFloor = Math.min(scores.global, INITIAL_FLOOR);
    const moving = scores.local > LOCAL_AT_DEFAULT * k || scores.global > this.globalFloor + GLOBAL_AT_DEFAULT * k;
    // Floor: falls fast, rises slowly (same idea as the audio noise floor),
    // so steady grain becomes the baseline but sustained motion doesn't.
    this.globalFloor += (scores.global - this.globalFloor) * (scores.global < this.globalFloor ? 0.5 : 0.02);
    this.streak = moving ? this.streak + 1 : 0;
    return this.streak >= 2;
  }
}

export class MotionDetector {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** Luma of the previously sampled frame, and scratch for the new one. */
  private last = new Float32Array(SAMPLE_W * SAMPLE_H);
  private next = new Float32Array(SAMPLE_W * SAMPLE_H);
  private hasPrev = false;
  private readonly judge = new MotionJudge();
  private _tainted = false;

  constructor(private readonly video: HTMLVideoElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = SAMPLE_W;
    this.canvas.height = SAMPLE_H;
    const ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
  }

  get tainted(): boolean {
    return this._tainted;
  }

  /** Forget the previous frame (after a seek, the next diff would be a cut). */
  reset(): void {
    this.hasPrev = false;
    this.judge.reset();
  }

  /** Whether there is sustained motion, or null if unavailable (tainted
   *  source, video not ready, or no previous frame yet). */
  sample(threshold: number): boolean | null {
    if (this._tainted) return null;
    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
    if (this.video.videoWidth === 0 || this.video.videoHeight === 0) return null;

    try {
      this.ctx.drawImage(this.video, 0, 0, SAMPLE_W, SAMPLE_H);
      toLuma(this.ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data, this.next);
    } catch (err) {
      if (err instanceof DOMException && err.name === "SecurityError") {
        this._tainted = true;
        console.warn(
          "[AdaptiveSpeed] Motion detection disabled for this video: cross-origin source without CORS " +
            "taints the canvas. Falling back to audio-only for this element."
        );
        return null;
      }
      throw err;
    }

    const scores = this.hasPrev ? motionScores(this.last, this.next, SAMPLE_W, SAMPLE_H) : null;
    const swap = this.last;
    this.last = this.next;
    this.next = swap;
    this.hasPrev = true;
    return scores ? this.judge.update(scores, threshold) : null;
  }

  dispose(): void {
    this.hasPrev = false;
  }
}
