/**
 * Small floating badge positioned over the top-right corner of a <video>,
 * showing the live speed multiplier. Purely cosmetic/debugging aid; safe
 * to leave off (see ExtensionSettings.showIndicator).
 *
 * Positioned with a ResizeObserver + absolute offset from the video's
 * bounding rect rather than injected as a child of the video itself,
 * because browsers restrict what can render inside/over a <video> subtree.
 */
export class Indicator {
  private readonly el: HTMLDivElement;
  private visible = false;
  private readonly resizeObserver: ResizeObserver;

  constructor(private readonly video: HTMLVideoElement) {
    this.el = document.createElement("div");
    Object.assign(this.el.style, {
      position: "fixed",
      zIndex: "2147483647",
      pointerEvents: "none",
      background: "rgba(17, 17, 24, 0.75)",
      color: "#fff",
      font: "600 12px/1.4 -apple-system, BlinkMacSystemFont, sans-serif",
      padding: "2px 7px",
      borderRadius: "6px",
      display: "none",
      transition: "opacity 120ms ease",
    } satisfies Partial<CSSStyleDeclaration>);
    document.documentElement.appendChild(this.el);

    this.resizeObserver = new ResizeObserver(() => this.reposition());
    this.resizeObserver.observe(video);
    window.addEventListener("scroll", this.reposition, { passive: true, capture: true });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.el.style.display = visible ? "block" : "none";
  }

  update(multiplier: number, isVoice: boolean, isMotion: boolean): void {
    if (!this.visible) return;
    this.reposition();
    const state = isVoice || isMotion ? "▶" : "⏩"; // play vs fast-forward glyph
    this.el.textContent = `${state} ${multiplier.toFixed(2)}×`;
  }

  private reposition = (): void => {
    const rect = this.video.getBoundingClientRect();
    this.el.style.top = `${Math.max(0, rect.top + 8)}px`;
    this.el.style.left = `${Math.max(0, rect.right - 60)}px`;
  };

  dispose(): void {
    this.resizeObserver.disconnect();
    window.removeEventListener("scroll", this.reposition, true);
    this.el.remove();
  }
}