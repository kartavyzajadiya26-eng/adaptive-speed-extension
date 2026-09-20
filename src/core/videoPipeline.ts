import { AudioAnalyzer } from "../audio/audioAnalyzer";
import { HeuristicVad } from "../audio/voiceActivity";
import { MotionDetector } from "../vision/motionDetector";
import type { ExtensionSettings, VadEngine } from "../types";
import { SpeedController } from "./speedController";
import { Indicator } from "./indicator";

/**
 * Owns the full pipeline for a single <video> element: audio analysis,
 * optional motion analysis, the speed decision, applying playbackRate, and
 * the optional on-screen indicator. One instance per <video>.
 */
export class VideoPipeline {
  private audio: AudioAnalyzer | null = null;
  private motion: MotionDetector | null = null;
  private readonly vad: VadEngine = new HeuristicVad();
  private readonly speedController: SpeedController;
  private readonly indicator: Indicator;

  private rafHandle: number | null = null;
  private lastMotionSampleAt = 0;
  private lastMotionScoreAboveThreshold = false;
  private disposed = false;

  constructor(private readonly video: HTMLVideoElement, private settings: ExtensionSettings) {
    this.speedController = new SpeedController(settings.normalSpeed);
    this.indicator = new Indicator(video);
    this.indicator.setVisible(settings.enabled && settings.showIndicator);
    this.setup();
  }

  private setup(): void {
    try {
      this.audio = new AudioAnalyzer(this.video);
    } catch (err) {
      // e.g. createMediaElementSource can throw on some edge cases
      // (detached elements, exotic srcObject types). Degrade gracefully:
      // the pipeline simply won't speed anything up for this element.
      console.warn("[AdaptiveSpeed] Could not attach audio analysis:", err);
      this.audio = null;
    }

    if (this.settings.mode === "audio-and-motion") {
      this.motion = new MotionDetector(this.video);
    }

    this.video.addEventListener("play", this.handlePlay);
    this.loop();
  }

  private handlePlay = (): void => {
    void this.audio?.ensureRunning();
  };

  updateSettings(settings: ExtensionSettings): void {
    const modeChanged = settings.mode !== this.settings.mode;
    this.settings = settings;

    if (modeChanged) {
      if (settings.mode === "audio-and-motion" && !this.motion) {
        this.motion = new MotionDetector(this.video);
      } else if (settings.mode === "audio-only" && this.motion) {
        this.motion.dispose();
        this.motion = null;
      }
    }

    if (!settings.enabled) {
      this.video.playbackRate = 1.0;
    }
    this.indicator.setVisible(settings.enabled && settings.showIndicator);
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.rafHandle = requestAnimationFrame(this.loop);

    if (!this.settings.enabled || this.video.paused) return;

    const isVoice = this.sampleVoice();
    const isMotion = this.sampleMotion();

    const multiplier = this.speedController.update(
      { isVoice, isMotion, motionEnabled: this.settings.mode === "audio-and-motion" },
      this.settings
    );

    // Only touch playbackRate when it actually needs to change — setting it
    // every frame is harmless but fires more property-change churn than
    // necessary in some page instrumentation.
    if (Math.abs(this.video.playbackRate - multiplier) > 0.001) {
      this.video.playbackRate = multiplier;
    }

    this.indicator.update(multiplier, isVoice, isMotion);
  };

  private sampleVoice(): boolean {
    if (!this.audio) return true; // fail open: never speed up audio we can't read
    const features = this.audio.sample();
    return this.vad.isVoice(features, this.settings);
  }

  private sampleMotion(): boolean {
    if (this.settings.mode !== "audio-and-motion" || !this.motion) return true;
    if (this.motion.tainted) return true; // fail open, see MotionDetector docs

    const now = performance.now();
    const intervalMs = 1000 / Math.max(1, this.settings.motionSampleFps);
    if (now - this.lastMotionSampleAt < intervalMs) {
      return this.lastMotionScoreAboveThreshold;
    }
    this.lastMotionSampleAt = now;

    const score = this.motion.sample();
    if (score === null) return this.lastMotionScoreAboveThreshold;

    this.lastMotionScoreAboveThreshold = score >= this.settings.motionThreshold;
    return this.lastMotionScoreAboveThreshold;
  }

  dispose(): void {
    this.disposed = true;
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.video.removeEventListener("play", this.handlePlay);
    this.audio?.dispose();
    this.motion?.dispose();
    this.indicator.dispose();
    if (this.video.playbackRate !== 1.0) this.video.playbackRate = 1.0;
  }
}