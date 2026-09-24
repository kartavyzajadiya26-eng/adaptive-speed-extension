import type { ExtensionSettings, PipelineState } from "../types";

/**
 * Time constant, in ms, of the smoothing applied to the raw per-frame
 * activity signal before hysteresis.
 *
 * The per-frame VAD is noisy: a single quiet frame between two syllables,
 * or a single noisy frame inside a pause, used to reset the hysteresis
 * timer. That made speech take much longer than `minVoiceMs` to pull the
 * speed back down (while sped-up speech kept playing), and made silence
 * take longer than `minSilenceMs` to speed up. Smoothing over ~40ms lets
 * isolated blips and dropouts pass without resetting anything, while a
 * real change still crosses the threshold within two or three frames.
 */
const SMOOTHING_TAU_MS = 40;
/** Smoothed level above which the signal counts as active, and below
 *  which it counts as quiet. The gap between them is the hysteresis. */
const ACTIVE_ON = 0.6;
const ACTIVE_OFF = 0.4;
/** Cap on the time step, so a long gap between ticks (tab switch, pause)
 *  doesn't let a single frame decide the state. */
const MAX_DT_MS = 50;
/** Time the smoothed level takes to cross a threshold after a clean step
 *  change (tau * ln(1 / 0.4)). Credited back so smoothing adds no latency. */
const SETTLE_MS = SMOOTHING_TAU_MS * Math.log(1 / ACTIVE_OFF);

/**
 * Adaptive silence requirement for natural speech pauses.
 *
 * Real speakers pause between sentences for roughly 0.5-1.2s. With a fixed
 * minSilenceMs those pauses kept tripping a speed-up that lasted a fraction
 * of a second before speech resumed: an audible 1x-2.5x-1x lurch that saved
 * almost no time. Measured on real TED/YouTube talks this happened several
 * times a minute. So when a quiet stretch turns out to be this short, we
 * require longer silence next time (up to MAX_SILENCE_SCALE times the
 * user's setting); when quiet stretches are long, we relax back toward it.
 * The controller learns each speaker's pause rhythm within a few pauses.
 */
/** A quiet stretch that saved the viewer less wall-clock time than this
 *  wasn't worth the two speed changes it cost. At 2.5x that means any
 *  stretch shorter than ~1.7s of video. */
const MIN_WORTHWHILE_SAVING_MS = 1000;
const MAX_SILENCE_SCALE = 3;
const SILENCE_SCALE_UP = 1.5;
const SILENCE_SCALE_DOWN = 0.85;

export interface SpeedSignals {
  isVoice: boolean;
  isMotion: boolean;
  motionEnabled: boolean;
  /** Playback is seeking or buffering: the analyser is reading silence that
   *  isn't in the content, so don't let it count toward a speed change. */
  hold?: boolean;
  /** Not enough media buffered to safely play faster: stay at normal speed
   *  (without forgetting the quiet state) so we don't cause stalls. */
  forceNormal?: boolean;
}

/**
 * Turns raw voice/motion booleans into an actual playbackRate, with
 * hysteresis so the speed doesn't flap on every short gap between words.
 *
 * This is the practical version of the brief's "10s buffer" idea. A true
 * look-ahead buffer would mean analyzing audio the user hasn't heard yet
 * and editing speed changes in ahead of time — that's only possible with
 * a pre-processing pass (the brief's "Approach 2"), because during live
 * playback there is no future data to look ahead into without deliberately
 * delaying playback itself. What we can do in real time is debounce: only
 * commit to a state change after the (smoothed) signal has held
 * steady for `minVoiceMs` / `minSilenceMs`.
 */
export class SpeedController {
  /** Committed output state — what's actually been applied to playbackRate. */
  private committedQuiet = false;

  /** Smoothed activity level in 0..1, and the thresholded state from it.
   *  Smoothing runs on wall-clock time (it filters per-frame VAD noise);
   *  `rawStateSince` is on the media clock (see `update`). */
  private level = 1;
  private rawActive = true;
  private rawStateSince: number;
  private lastUpdateAt: number | null = null;
  private lastMediaAt: number | null = null;

  /** Multiplier on minSilenceMs, learned from how long quiet stretches last. */
  private silenceScale = 1;
  private quietSinceMedia = 0;

  private readonly state: PipelineState;

  constructor(initialMultiplier: number) {
    this.rawStateSince = 0;
    this.state = {
      isVoice: true,
      isMotion: true,
      currentMultiplier: initialMultiplier,
    };
  }

  /** Forget all history, e.g. after a seek or a new source is loaded. */
  reset(mediaNow = 0): void {
    this.committedQuiet = false;
    this.level = 1;
    this.rawActive = true;
    this.rawStateSince = mediaNow;
    this.lastUpdateAt = null;
    this.lastMediaAt = null;
    // silenceScale is deliberately kept: a seek doesn't change the speaker.
  }

  /** Forget the learned pause rhythm too, e.g. when a new video loads. */
  resetAll(mediaNow = 0): void {
    this.reset(mediaNow);
    this.silenceScale = 1;
  }

  /** Current effective silence requirement, for diagnostics. */
  get effectiveMinSilenceScale(): number {
    return this.silenceScale;
  }

  /**
   * Feed the latest per-frame signals and get back the playbackRate that
   * should be applied right now (idempotent — caller can set it every
   * tick without checking whether it changed).
   *
   * `now` is wall-clock ms; `mediaNow` is the video's own clock in ms
   * (currentTime * 1000). minVoiceMs / minSilenceMs are measured on the
   * media clock, because that's what the listener hears: at 2.5x, 100ms of
   * wall time is 250ms of speech, so wall-clock timing let the first
   * quarter-second of every sentence play sped up. Media time also stands
   * still while buffering, so stalls can't count as silence. When no media
   * clock is given, wall time is used for both.
   */
  update(
    signals: SpeedSignals,
    settings: ExtensionSettings,
    now = performance.now(),
    mediaNow: number = now
  ): number {
    this.state.isVoice = signals.isVoice;
    this.state.isMotion = signals.isMotion;

    if (signals.hold) {
      // Freeze the timers so buffering silence never accumulates into a
      // "quiet" streak, and re-measure from scratch once playback resumes.
      this.rawStateSince = mediaNow;
      this.lastUpdateAt = null;
      this.lastMediaAt = null;
      return this.output(settings, signals.forceNormal);
    }

    // "Active" (should run at normalSpeed) means: someone is talking, OR
    // — only when motion gating is enabled — something is visibly moving.
    const rawActiveNow = signals.isVoice || (signals.motionEnabled && signals.isMotion);

    // The media clock jumped backwards (loop, rewind) or far forward (skip)
    // without a seek event: start timing afresh from here.
    if (this.lastMediaAt !== null && (mediaNow < this.lastMediaAt || mediaNow - this.lastMediaAt > 2000)) {
      this.rawStateSince = mediaNow;
    }
    const mediaDt = this.lastMediaAt === null ? 0 : mediaNow - this.lastMediaAt;
    this.lastMediaAt = mediaNow;

    const dt = this.lastUpdateAt === null ? 16 : Math.min(MAX_DT_MS, Math.max(0, now - this.lastUpdateAt));
    this.lastUpdateAt = now;
    // Media ms per wall ms right now (the effective playback rate).
    const rate = dt > 0 && mediaDt > 0 ? Math.min(16, mediaDt / dt) : 1;
    this.level += ((rawActiveNow ? 1 : 0) - this.level) * (1 - Math.exp(-dt / SMOOTHING_TAU_MS));

    const smoothedActive = this.rawActive ? this.level > ACTIVE_OFF : this.level >= ACTIVE_ON;
    if (smoothedActive !== this.rawActive) {
      this.rawActive = smoothedActive;
      this.rawStateSince = mediaNow - SETTLE_MS * rate;
    }

    const rawStateDuration = mediaNow - this.rawStateSince;
    const minSilenceMs = settings.minSilenceMs * this.silenceScale;
    if (this.committedQuiet && this.rawActive && rawStateDuration >= settings.minVoiceMs) {
      this.committedQuiet = false;
      // Learn from how long that quiet stretch really lasted.
      const quietMs = this.rawStateSince - this.quietSinceMedia;
      const savedMs = quietMs * (1 - settings.normalSpeed / Math.max(settings.quietSpeed, settings.normalSpeed + 0.01));
      this.silenceScale =
        savedMs < MIN_WORTHWHILE_SAVING_MS
          ? Math.min(MAX_SILENCE_SCALE, this.silenceScale * SILENCE_SCALE_UP)
          : Math.max(1, this.silenceScale * SILENCE_SCALE_DOWN);
    } else if (!this.committedQuiet && !this.rawActive && rawStateDuration >= minSilenceMs) {
      this.committedQuiet = true;
      this.quietSinceMedia = mediaNow;
    }

    return this.output(settings, signals.forceNormal);
  }

  private output(settings: ExtensionSettings, forceNormal = false): number {
    this.state.currentMultiplier =
      this.committedQuiet && !forceNormal ? settings.quietSpeed : settings.normalSpeed;
    return this.state.currentMultiplier;
  }

  get snapshot(): Readonly<PipelineState> {
    return this.state;
  }
}
