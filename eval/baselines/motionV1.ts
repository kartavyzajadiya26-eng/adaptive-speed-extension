/**
 * Lightweight frame-difference motion detector — this is the "computer
 * vision" piece from the brief, kept deliberately simple rather than
 * bringing in a model (see README for why: a full CV model adds a large
 * download and GPU/WASM cost for a signal this coarse heuristic already
 * gives reasonably well: "did the picture change").
 *
 * How it works:
 *  1. Draw the current video frame into a tiny offscreen canvas (default
 *     48x27 — keeps the pixel math to ~1300 pixels instead of millions).
 *  2. Convert to grayscale luma and compare against the previous sampled
 *     frame, pixel by pixel.
 *  3. Return the mean absolute difference (0-255). The caller compares
 *     this against `motionThreshold`.
 *
 * KNOWN LIMITATION — tainted canvas:
 * `drawImage` + `getImageData` on a cross-origin video WITHOUT a CORS
 * response (and a matching `video.crossOrigin` attribute) throws a
 * SecurityError, because reading pixels would leak cross-origin image
 * data. Same-origin video, blob: URLs (which is what YouTube's
 * MediaSource-based player uses), and CORS-enabled sources all work.
 * Plain cross-origin `<video src>` on smaller sites typically does not.
 * Rather than crash the page, this class detects the first SecurityError,
 * flags itself `tainted`, and quietly stops sampling — the pipeline then
 * falls back to audio-only behavior for that video. This is exactly the
 * "won't work for arbitrary dynamic video" caveat flagged in the original
 * brief; it's a browser security boundary, not a bug to work around.
 */
export class MotionDetector {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private previousFrame: Uint8ClampedArray | null = null;
  private _tainted = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly sampleWidth = 48,
    private readonly sampleHeight = 27
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = sampleWidth;
    this.canvas.height = sampleHeight;
    const ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
  }

  get tainted(): boolean {
    return this._tainted;
  }

  /** Returns a 0-255 motion score, or null if unavailable (tainted source,
   *  video not ready, or no previous frame to diff against yet). */
  sample(): number | null {
    if (this._tainted) return null;
    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
    if (this.video.videoWidth === 0 || this.video.videoHeight === 0) return null;

    try {
      this.ctx.drawImage(this.video, 0, 0, this.sampleWidth, this.sampleHeight);
      const frame = this.ctx.getImageData(0, 0, this.sampleWidth, this.sampleHeight).data;

      if (!this.previousFrame) {
        this.previousFrame = frame;
        return null;
      }

      const score = meanLumaDelta(this.previousFrame, frame);
      this.previousFrame = frame;
      return score;
    } catch (err) {
      if (err instanceof DOMException && err.name === "SecurityError") {
        this._tainted = true;
        console.warn(
          "[AdaptiveSpeed] Motion detection disabled for this video: " +
            "cross-origin source without CORS taints the canvas. " +
            "Falling back to audio-only for this element."
        );
        return null;
      }
      throw err;
    }
  }

  dispose(): void {
    this.previousFrame = null;
  }
}

/** Mean absolute per-pixel luma difference between two RGBA buffers of the
 *  same dimensions. Cheap approximation of luma: (r+g+b)/3 instead of the
 *  proper Rec.601 weighted formula — fine for a relative motion score. */
export function meanLumaDelta(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let total = 0;
  let pixelCount = 0;
  for (let i = 0; i < a.length; i += 4) {
    const lumaA = ((a[i] ?? 0) + (a[i + 1] ?? 0) + (a[i + 2] ?? 0)) / 3;
    const lumaB = ((b[i] ?? 0) + (b[i + 1] ?? 0) + (b[i + 2] ?? 0)) / 3;
    total += Math.abs(lumaA - lumaB);
    pixelCount++;
  }
  return pixelCount === 0 ? 0 : total / pixelCount;
}