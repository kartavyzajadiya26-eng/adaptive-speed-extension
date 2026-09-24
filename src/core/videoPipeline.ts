import {
  AudioAnalyzer,
  canAnalyzeAudio,
  getSharedAudioContext,
  isSharedAudioContextRunning,
  resumeSharedAudioContext,
} from "../audio/audioAnalyzer";
import { HeuristicVad } from "../audio/voiceActivity";
import { loadSileroWeights } from "../audio/neuralVad";
import { MotionDetector } from "../vision/motionDetector";
import type { ExtensionSettings, VadEngine } from "../types";
import { SpeedController } from "./speedController";
import { Indicator } from "./indicator";

/** Below this many seconds of *wall-clock* playback buffered ahead (at
 *  quietSpeed), stay at normal speed. Playing faster than the network can
 *  deliver was a major source of stutter. Scaled by quietSpeed because at
 *  2.5x a 3s buffer lasts only 1.2s. */
const LOW_BUFFER_WALL_S = 2;
/** Resume speeding up only once the buffer has recovered to twice that. */
const BUFFER_RECOVERED_FACTOR = 2;
/** How often to re-read `video.buffered` (it allocates a TimeRanges). */
const BUFFER_CHECK_MS = 250;

type AudioState = "pending" | "ready" | "unavailable";

/** Page-side switches for diagnosing the extension on a given site:
 *    localStorage.adaptiveSpeedDebug = "1"   logs detector state once a second
 *    localStorage.adaptiveSpeedVad = "rules" forces the DSP heuristic */
function readDebugFlags(): { debug: boolean; forceRules: boolean; captureOnly: boolean } {
  try {
    const vad = localStorage.getItem("adaptiveSpeedVad");
    return {
      debug: localStorage.getItem("adaptiveSpeedDebug") === "1",
      forceRules: vad === "rules",
      // Profiling aid: run the audio capture but not the model.
      captureOnly: vad === "capture-only",
    };
  } catch {
    return { debug: false, forceRules: false, captureOnly: false };
  }
}

/**
 * Owns the full pipeline for a single <video> element: audio analysis,
 * optional motion analysis, the speed decision, applying playbackRate, and
 * the optional on-screen indicator. One instance per <video>.
 *
 * It has no timer of its own: VideoManager drives every pipeline from one
 * shared loop that only runs while some video is actually playing.
 */
export class VideoPipeline {
  private audio: AudioAnalyzer | null = null;
  private audioState: AudioState = "pending";
  private motion: MotionDetector | null = null;
  private vad: VadEngine = new HeuristicVad();
  private lastTickAt = 0;
  private readonly flags = readDebugFlags();
  private lastDebugAt = 0;
  /** When our own sentence-start replay seek was issued (0 = none). */
  private replaySeekAt = 0;
  replays = 0;
  private readonly speedController: SpeedController;
  private readonly indicator: Indicator;

  private lastMotionSampleAt = 0;
  private lastMotion = false;
  private lastBufferCheckAt = 0;
  private lowBuffer = false;
  private disposed = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private settings: ExtensionSettings,
    private readonly onActivity: () => void
  ) {
    this.speedController = new SpeedController(settings.normalSpeed);
    this.indicator = new Indicator(video);
    this.indicator.setVisible(settings.enabled && settings.showIndicator);

    if (settings.mode === "audio-and-motion") this.motion = new MotionDetector(video);

    video.addEventListener("play", this.handlePlay);
    video.addEventListener("playing", this.handlePlay);
    video.addEventListener("pause", this.handlePause);
    video.addEventListener("volumechange", this.handleVolume);
    video.addEventListener("seeking", this.handleSeeking);
    video.addEventListener("loadstart", this.handleNewSource);

    // Attached to a video that is already playing (e.g. found late).
    if (!video.paused) this.handlePlay();
  }

  /** True when this video needs ticking right now. */
  get isActive(): boolean {
    return !this.disposed && this.settings.enabled && !this.video.paused && !this.video.ended;
  }

  private handlePlay = (): void => {
    if (!this.settings.enabled) return;
    this.audio?.setCaptureActive(true);
    // Creating the context here (not at attach time) means pages with many
    // never-played videos never pay for Web Audio at all.
    getSharedAudioContext();
    resumeSharedAudioContext();
    this.onActivity();
  };

  /**
   * Chrome applies the element's volume before Web Audio sees the signal
   * (measured: 20% volume reads 14 dB quieter), so a user who turns a video
   * down would push speech under the detectors' thresholds. This gain
   * undoes that, capped at +26 dB (volume 5%).
   */
  private volumeGain(): number {
    const v = this.video.volume;
    return v > 0 ? Math.min(20, 1 / v) : 1;
  }

  private handleVolume = (): void => {
    this.audio?.setInputGain(this.volumeGain());
  };

  private handlePause = (): void => {
    this.audio?.setCaptureActive(false);
  };

  private handleSeeking = (): void => {
    if (this.replaySeekAt && performance.now() - this.replaySeekAt < 1000) {
      // Our own short jump back: speech continues, keep all state.
      this.replaySeekAt = 0;
      return;
    }
    this.replaySeekAt = 0;
    this.speedController.reset(this.video.currentTime * 1000);
    this.audio?.resetCapture();
    this.motion?.reset();
    this.lastBufferCheckAt = 0;
  };

  /** Same element, new media (players like YouTube reuse one <video>). */
  private handleNewSource = (): void => {
    this.speedController.resetAll(0);
    this.vad = new HeuristicVad();
    this.audio?.resetCapture();
    this.lowBuffer = false;
    this.lastBufferCheckAt = 0;
    if (this.audioState === "unavailable") this.audioState = "pending";
  };

  updateSettings(settings: ExtensionSettings): void {
    const modeChanged = settings.mode !== this.settings.mode;
    const wasEnabled = this.settings.enabled;
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
      if (wasEnabled) this.video.playbackRate = 1.0;
      this.audio?.setCaptureActive(false); // stop analysing while switched off
    } else if (!wasEnabled) {
      this.speedController.reset(this.video.currentTime * 1000);
      if (!this.video.paused) this.handlePlay();
    }
    this.indicator.setVisible(settings.enabled && settings.showIndicator);
  }

  /** One step of the pipeline. Returns whether it still needs ticking. */
  tick(now: number): boolean {
    if (!this.isActive) return false;

    this.ensureAudio();

    const video = this.video;
    const stalled = video.seeking || video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA;
    const isVoice = this.sampleVoice(now);
    const isMotion = this.sampleMotion(now);

    const multiplier = this.speedController.update(
      {
        isVoice,
        isMotion,
        motionEnabled: this.settings.mode === "audio-and-motion",
        hold: stalled,
        forceNormal: this.checkLowBuffer(now),
        debounced: this.audio?.voice?.ready === true,
      },
      this.settings,
      now,
      video.currentTime * 1000
    );

    if (Math.abs(video.playbackRate - multiplier) > 0.001) {
      video.playbackRate = multiplier;
    }

    const replayTo = this.speedController.takeReplayTarget();
    if (replayTo !== null && this.canReplayTo(replayTo / 1000)) {
      this.replaySeekAt = performance.now();
      this.replays++;
      video.currentTime = replayTo / 1000;
    }

    this.indicator.update(multiplier, isVoice, isMotion);
    if (this.flags.debug && now - this.lastDebugAt > 1000) this.logDebug(now, isVoice, multiplier);
    return true;
  }

  private logDebug(now: number, isVoice: boolean, rate: number): void {
    this.lastDebugAt = now;
    const n = this.audio?.voice ?? null;
    console.debug(
      "[AdaptiveSpeed][debug]",
      JSON.stringify({
        t: +this.video.currentTime.toFixed(2),
        vad: n?.ready ? "neural" : "rules",
        model: this.audio?.captureMode ?? "none",
        prob: n ? +n.probability.toFixed(3) : null,
        voice: isVoice,
        rate,
        mainThreadModelMs: this.audio?.mainThreadModelMs?.toFixed(3) ?? null,
        audioThreadModelMs: this.audio?.workletModelMs?.toFixed(3) ?? null,
      })
    );
  }

  /** Lazily routes audio once it's both safe and useful to do so. */
  private ensureAudio(): void {
    if (this.audioState !== "pending") return;
    // A routed element on a suspended context is silent, so wait until the
    // shared context is actually running before touching the element.
    if (!isSharedAudioContextRunning()) return;

    const readable = canAnalyzeAudio(this.video);
    if (readable === null) return; // source not known yet, retry next tick
    if (!readable) {
      this.audioState = "unavailable";
      return;
    }

    try {
      this.audio = new AudioAnalyzer(this.video);
      this.audioState = "ready";
      this.audio.setInputGain(this.volumeGain());
      this.startNeuralVad(this.audio);
    } catch (err) {
      console.warn("[AdaptiveSpeed] Could not attach audio analysis:", err);
      this.audioState = "unavailable";
    }
  }

  /** Loads the speech model (shared across videos) and starts streaming audio to it. */
  private startNeuralVad(audio: AudioAnalyzer): void {
    if (this.flags.forceRules) return;
    let weightsUrl: string;
    let workletUrl: string;
    try {
      weightsUrl = chrome.runtime.getURL("models/silero_vad_16k.bin");
      workletUrl = chrome.runtime.getURL("capture-worklet.js");
    } catch {
      return; // extension context gone (e.g. extension reloaded); keep the heuristic
    }
    void loadSileroWeights(weightsUrl).then((weights) => {
      if (!weights || this.disposed || this.audio !== audio) return;
      audio.enableNeuralVad(workletUrl, weights, this.flags.captureOnly ? "capture-only" : undefined);
      audio.setCaptureActive(!this.video.paused);
    });
  }

  private sampleVoice(now: number): boolean {
    // Fail open (treat as speech, i.e. normal speed) whenever we can't
    // trust the reading. Zeros from an unreadable, muted or suspended
    // source would otherwise look like silence and pin the video fast.
    const audio = this.audio;
    if (!audio || !audio.isRunning) return true;
    if (this.video.muted || this.video.volume === 0) return true;

    const features = audio.sample(now);
    if (audio.looksBlocked(now)) return true;
    const dtMs = this.lastTickAt ? Math.min(100, now - this.lastTickAt) : 16.7;
    this.lastTickAt = now;
    // Keep the heuristic's state warm even when the model is in charge, so
    // a fallback mid-video starts from a sensible noise floor.
    const heuristic = this.vad.isVoice(
      { ...features, rmsDb: features.rmsDb + 20 * Math.log10(this.volumeGain()) },
      this.settings,
      dtMs
    );
    const neural = audio.voice;
    return neural?.ready ? neural.isVoice : heuristic;
  }

  private sampleMotion(now: number): boolean {
    if (this.settings.mode !== "audio-and-motion" || !this.motion) return true;
    if (this.motion.tainted) return true; // fail open, see MotionDetector docs

    const intervalMs = 1000 / Math.max(1, this.settings.motionSampleFps);
    if (now - this.lastMotionSampleAt < intervalMs) return this.lastMotion;
    this.lastMotionSampleAt = now;

    const moving = this.motion.sample(this.settings.motionThreshold);
    if (moving !== null) this.lastMotion = moving;
    return this.lastMotion;
  }

  /** A replay jump must land inside already-buffered media, so it's a
   *  quick local seek rather than a network refetch. */
  private canReplayTo(t: number): boolean {
    const { buffered } = this.video;
    for (let i = 0; i < buffered.length; i++) {
      if (t >= buffered.start(i) && this.video.currentTime <= buffered.end(i) && t <= this.video.currentTime) return true;
    }
    return false;
  }

  /** Hysteresis on buffered-ahead seconds so we don't flap at the edge. */
  private checkLowBuffer(now: number): boolean {
    if (now - this.lastBufferCheckAt < BUFFER_CHECK_MS) return this.lowBuffer;
    this.lastBufferCheckAt = now;

    const ahead = this.bufferedAhead();
    const low = LOW_BUFFER_WALL_S * Math.max(1, this.settings.quietSpeed);
    if (ahead === null) {
      this.lowBuffer = false;
    } else if (this.lowBuffer) {
      this.lowBuffer = ahead < low * BUFFER_RECOVERED_FACTOR;
    } else {
      this.lowBuffer = ahead < low;
    }
    return this.lowBuffer;
  }

  /** Seconds buffered past the playhead, or null when it doesn't apply
   *  (fully buffered to the end, or no buffer info such as MediaStreams). */
  private bufferedAhead(): number | null {
    const { buffered, currentTime, duration } = this.video;
    for (let i = 0; i < buffered.length; i++) {
      const start = buffered.start(i);
      const end = buffered.end(i);
      if (currentTime >= start - 0.1 && currentTime <= end) {
        if (Number.isFinite(duration) && end >= duration - 0.5) return null;
        return end - currentTime;
      }
    }
    return buffered.length === 0 && this.video.srcObject ? null : 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.video.removeEventListener("play", this.handlePlay);
    this.video.removeEventListener("playing", this.handlePlay);
    this.video.removeEventListener("pause", this.handlePause);
    this.video.removeEventListener("volumechange", this.handleVolume);
    this.video.removeEventListener("seeking", this.handleSeeking);
    this.video.removeEventListener("loadstart", this.handleNewSource);
    this.audio?.dispose();
    this.motion?.dispose();
    this.indicator.dispose();
    if (this.video.playbackRate !== 1.0) this.video.playbackRate = 1.0;
  }
}
