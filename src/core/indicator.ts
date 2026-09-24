/** Minimum gap between position refreshes driven by `update()`. Scrolls and
 *  resizes still reposition promptly through their own listeners. */
const REPOSITION_INTERVAL_MS = 250;

/**
 * Small floating badge positioned over the top-right corner of a <video>,
 * showing the live speed multiplier. Purely cosmetic/debugging aid; safe
 * to leave off (see ExtensionSettings.showIndicator).
 *
 * Positioned from the video's bounding rect rather than injected as a
 * child of the video, because browsers restrict what renders inside a
 * <video> subtree.
 *
 * Performance: the old version called getBoundingClientRect() and rewrote
 * its text on every animation frame for every video, forcing a layout each
 * frame. Now the DOM is only touched when the text changes, position reads
 * are throttled, and no listeners exist while the badge is hidden.
 */
export class Indicator {
  private el: HTMLDivElement | null = null;
  private visible = false;
  private resizeObserver: ResizeObserver | null = null;
  private lastText = "";
  private lastRepositionAt = 0;
  private repositionQueued = false;

  constructor(private readonly video: HTMLVideoElement) {}

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible) this.mount();
    else this.unmount();
  }

  update(multiplier: number, isVoice: boolean, isMotion: boolean): void {
    if (!this.visible || !this.el) return;

    const state = isVoice || isMotion ? "▶" : "⏩"; // play vs fast-forward glyph
    const text = `${state} ${multiplier.toFixed(2)}×`;
    if (text !== this.lastText) {
      this.lastText = text;
      this.el.textContent = text;
      this.reposition();
      return;
    }

    const now = performance.now();
    if (now - this.lastRepositionAt >= REPOSITION_INTERVAL_MS) this.reposition();
  }

  private mount(): void {
    if (this.el) return;
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: "fixed",
      zIndex: "2147483647",
      pointerEvents: "none",
      background: "rgba(17, 17, 24, 0.75)",
      color: "#fff",
      font: "600 12px/1.4 -apple-system, BlinkMacSystemFont, sans-serif",
      padding: "2px 7px",
      borderRadius: "6px",
      top: "0",
      left: "0",
      willChange: "transform",
    } satisfies Partial<CSSStyleDeclaration>);
    document.documentElement.appendChild(el);
    this.el = el;
    this.lastText = "";

    this.resizeObserver = new ResizeObserver(this.queueReposition);
    this.resizeObserver.observe(this.video);
    window.addEventListener("scroll", this.queueReposition, { passive: true, capture: true });
    window.addEventListener("resize", this.queueReposition, { passive: true });
    this.reposition();
  }

  private unmount(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener("scroll", this.queueReposition, true);
    window.removeEventListener("resize", this.queueReposition);
    this.el?.remove();
    this.el = null;
  }

  /** Coalesce bursts of scroll/resize events into one read per frame. */
  private queueReposition = (): void => {
    if (this.repositionQueued) return;
    this.repositionQueued = true;
    requestAnimationFrame(() => {
      this.repositionQueued = false;
      this.reposition();
    });
  };

  private reposition(): void {
    if (!this.el) return;
    this.lastRepositionAt = performance.now();
    const rect = this.video.getBoundingClientRect();
    const hidden = this.lastText === "" || rect.width === 0 || rect.height === 0;
    this.el.style.display = hidden ? "none" : "block";
    if (hidden) return;
    // transform instead of top/left: compositor-only, no layout.
    const x = Math.max(0, rect.right - 60);
    const y = Math.max(0, rect.top + 8);
    this.el.style.transform = `translate(${x}px, ${y}px)`;
  }

  dispose(): void {
    this.visible = false;
    this.unmount();
  }
}
