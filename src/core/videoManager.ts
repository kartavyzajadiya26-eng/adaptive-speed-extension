import type { ExtensionSettings } from "../types";
import { VideoPipeline } from "./videoPipeline";

/**
 * Finds every <video> element on the page (present now or added later by
 * client-side routing / lazy players), attaches one VideoPipeline each, and
 * tears pipelines down when their element is removed from the DOM.
 *
 * Deliberately does NOT pierce open shadow roots or cross-origin iframes
 * beyond what `all_frames: true` in the manifest already gives us (each
 * frame gets its own content script + its own VideoManager). Walking
 * arbitrary shadow DOM is a reasonable v2 addition — see README roadmap.
 */
export class VideoManager {
  private readonly pipelines = new Map<HTMLVideoElement, VideoPipeline>();
  private readonly observer: MutationObserver;

  constructor(private settings: ExtensionSettings) {
    this.observer = new MutationObserver(this.handleMutations);
  }

  start(): void {
    this.scan(document.body ?? document.documentElement);
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  updateSettings(settings: ExtensionSettings): void {
    this.settings = settings;
    for (const pipeline of this.pipelines.values()) {
      pipeline.updateSettings(settings);
    }
  }

  private handleMutations = (mutations: MutationRecord[]): void => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        this.scan(node);
      });
      mutation.removedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        this.unscan(node);
      });
    }
  };

  private scan(root: Element): void {
    if (root instanceof HTMLVideoElement) this.attach(root);
    root.querySelectorAll("video").forEach((el) => this.attach(el as HTMLVideoElement));
  }

  private unscan(root: Element): void {
    if (root instanceof HTMLVideoElement) this.detach(root);
    root.querySelectorAll("video").forEach((el) => this.detach(el as HTMLVideoElement));
  }

  private attach(video: HTMLVideoElement): void {
    if (this.pipelines.has(video)) return;
    this.pipelines.set(video, new VideoPipeline(video, this.settings));
  }

  private detach(video: HTMLVideoElement): void {
    const pipeline = this.pipelines.get(video);
    if (!pipeline) return;
    pipeline.dispose();
    this.pipelines.delete(video);
  }

  dispose(): void {
    this.observer.disconnect();
    for (const pipeline of this.pipelines.values()) pipeline.dispose();
    this.pipelines.clear();
  }
}