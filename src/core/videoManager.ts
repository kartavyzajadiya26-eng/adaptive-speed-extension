import type { ExtensionSettings } from "../types";
import { resumeSharedAudioContext } from "../audio/audioAnalyzer";
import { VideoPipeline } from "./videoPipeline";

/** How long a removed <video> may stay detached before we tear it down.
 *  Players (YouTube's miniplayer, theater mode, SPA route changes) often
 *  move the same element; tearing down and rebuilding on every move reset
 *  the speed and re-ran setup, which showed up as hitches. */
const DETACH_GRACE_MS = 1500;

/** Tick interval used while the tab is hidden, where rAF doesn't fire.
 *  Chrome doesn't throttle timers in tabs that are playing audio. */
const HIDDEN_TICK_MS = 16;

type IdleHandle = { cancel: () => void };

function scheduleIdle(cb: () => void): IdleHandle {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(cb, { timeout: 250 });
    return { cancel: () => cancelIdleCallback(id) };
  }
  const id = setTimeout(cb, 50);
  return { cancel: () => clearTimeout(id) };
}

/**
 * Finds every <video> on the page — present now, added later, or inside
 * open shadow roots — attaches one VideoPipeline each, and drives all of
 * them from a single loop that only runs while something is playing.
 *
 * Cross-origin iframes are handled by `all_frames: true` in the manifest:
 * each frame gets its own content script and its own VideoManager.
 */
export class VideoManager {
  private readonly pipelines = new Map<HTMLVideoElement, VideoPipeline>();
  private readonly observer: MutationObserver;
  private readonly observedRoots = new WeakSet<Node>();

  private pendingRoots: Node[] = [];
  private pendingRemovals = new Set<HTMLVideoElement>();
  private scanHandle: IdleHandle | null = null;
  private removalTimer: ReturnType<typeof setTimeout> | null = null;

  private rafHandle: number | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(private settings: ExtensionSettings) {
    this.observer = new MutationObserver(this.handleMutations);
  }

  start(): void {
    this.observeRoot(document);
    this.scanNow(document.documentElement);

    // Safety net: catches any light-DOM video that starts playing before
    // our batched scan reaches it. `play` doesn't bubble, so use capture.
    document.addEventListener("play", this.handleAnyPlay, true);
    // Autoplay policy may keep the AudioContext suspended until the user
    // interacts with the page; resume on their first gesture.
    window.addEventListener("pointerdown", this.handleGesture, true);
    window.addEventListener("keydown", this.handleGesture, true);
    document.addEventListener("visibilitychange", this.handleVisibility);
  }

  updateSettings(settings: ExtensionSettings): void {
    this.settings = settings;
    for (const pipeline of this.pipelines.values()) pipeline.updateSettings(settings);
    this.requestTick();
  }

  // ---------------------------------------------------------------- discovery

  private observeRoot(root: Document | ShadowRoot): void {
    if (this.observedRoots.has(root)) return;
    this.observedRoots.add(root);
    this.observer.observe(root, { childList: true, subtree: true });
  }

  private handleMutations = (mutations: MutationRecord[]): void => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) this.pendingRoots.push(node);
      });
      mutation.removedNodes.forEach((node) => {
        if (node instanceof HTMLVideoElement) {
          this.pendingRemovals.add(node);
        } else if (node instanceof Element && this.pipelines.size > 0) {
          const videos = node.getElementsByTagName("video");
          for (let i = 0; i < videos.length; i++) this.pendingRemovals.add(videos[i]!);
        }
      });
    }

    // Batch the work off the mutation callback: busy sites add thousands of
    // nodes per second, and scanning each synchronously stalled the page.
    if (this.pendingRoots.length > 0 && !this.scanHandle) {
      this.scanHandle = scheduleIdle(this.flushScan);
    }
    if (this.pendingRemovals.size > 0 && !this.removalTimer) {
      this.removalTimer = setTimeout(this.flushRemovals, DETACH_GRACE_MS);
    }
  };

  private flushScan = (): void => {
    this.scanHandle = null;
    const roots = this.pendingRoots;
    this.pendingRoots = [];
    for (const root of roots) {
      if (root.isConnected) this.scanNow(root as Element);
    }
  };

  private flushRemovals = (): void => {
    this.removalTimer = null;
    for (const video of this.pendingRemovals) {
      if (!video.isConnected) this.detach(video);
    }
    this.pendingRemovals.clear();
  };

  /** Attaches every video under `root`, descending into open shadow roots. */
  private scanNow(root: Element | ShadowRoot): void {
    if (root instanceof HTMLVideoElement) this.attach(root);

    const videos = root.querySelectorAll("video");
    for (let i = 0; i < videos.length; i++) this.attach(videos[i]!);

    // Shadow roots aren't visible to querySelectorAll or to the document's
    // MutationObserver, so find them and observe each one separately.
    if (root instanceof Element && root.shadowRoot) this.enterShadow(root.shadowRoot);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const shadow = (node as Element).shadowRoot;
      if (shadow) this.enterShadow(shadow);
    }
  }

  private enterShadow(shadow: ShadowRoot): void {
    if (this.observedRoots.has(shadow)) return;
    this.observeRoot(shadow);
    this.scanNow(shadow);
  }

  private handleAnyPlay = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLVideoElement) this.attach(target);
  };

  private attach(video: HTMLVideoElement): void {
    this.pendingRemovals.delete(video);
    if (this.pipelines.has(video)) return;
    this.pipelines.set(video, new VideoPipeline(video, this.settings, this.requestTick));
  }

  private detach(video: HTMLVideoElement): void {
    const pipeline = this.pipelines.get(video);
    if (!pipeline) return;
    pipeline.dispose();
    this.pipelines.delete(video);
  }

  // ---------------------------------------------------------------- loop

  /**
   * One loop for all videos, instead of one requestAnimationFrame loop per
   * <video> that ran forever (even for paused or hidden videos). It stops
   * itself when nothing is playing and restarts on the next `play`.
   */
  private requestTick = (): void => {
    if (this.rafHandle !== null || this.timeoutHandle !== null) return;
    if (document.hidden) {
      this.timeoutHandle = setTimeout(this.tick, HIDDEN_TICK_MS);
    } else {
      this.rafHandle = requestAnimationFrame(this.tick);
    }
  };

  private tick = (): void => {
    this.rafHandle = null;
    this.timeoutHandle = null;

    const now = performance.now();
    let anyActive = false;
    for (const pipeline of this.pipelines.values()) {
      if (pipeline.tick(now)) anyActive = true;
    }
    if (anyActive) this.requestTick();
  };

  private cancelTick(): void {
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    if (this.timeoutHandle !== null) clearTimeout(this.timeoutHandle);
    this.rafHandle = null;
    this.timeoutHandle = null;
  }

  /** rAF never fires in a hidden tab, so switch loop drivers on change. */
  private handleVisibility = (): void => {
    const wasRunning = this.rafHandle !== null || this.timeoutHandle !== null;
    this.cancelTick();
    if (wasRunning) this.requestTick();
  };

  private handleGesture = (): void => {
    resumeSharedAudioContext();
    this.requestTick();
  };

  dispose(): void {
    this.observer.disconnect();
    this.scanHandle?.cancel();
    if (this.removalTimer) clearTimeout(this.removalTimer);
    this.cancelTick();
    document.removeEventListener("play", this.handleAnyPlay, true);
    window.removeEventListener("pointerdown", this.handleGesture, true);
    window.removeEventListener("keydown", this.handleGesture, true);
    document.removeEventListener("visibilitychange", this.handleVisibility);
    for (const pipeline of this.pipelines.values()) pipeline.dispose();
    this.pipelines.clear();
  }
}
