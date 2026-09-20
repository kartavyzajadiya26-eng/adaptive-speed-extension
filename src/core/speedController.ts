import type { ExtensionSettings, PipelineState } from "../types";

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
 * commit to a state change after the RAW signal has held steady, continuously,
 * for `minVoiceMs` / `minSilenceMs`. That's what this class does, and it's
 * the same trade-off Approach 1 in the brief accepted (reactive, with a
 * short lag, instead of ML-perfect but requiring a backend).
 */
export class SpeedController {
  /** Committed output state — what's actually been applied to playbackRate. */
  private committedQuiet = false;

  /** Raw (pre-debounce) activity state and when it last changed. */
  private rawActive = true;
  private rawStateSince = performance.now();

  private state: PipelineState;

  constructor(initialMultiplier: number) {
    this.state = {
      isVoice: true,
      isMotion: true,
      currentMultiplier: initialMultiplier,
    };
  }

  /**
   * Feed the latest per-frame signals and get back the playbackRate that
   * should be applied right now (idempotent — caller can set it every
   * tick without checking whether it changed).
   */
  update(
    signals: { isVoice: boolean; isMotion: boolean; motionEnabled: boolean },
    settings: ExtensionSettings
  ): number {
    const now = performance.now();

    // "Active" (should run at normalSpeed) means: someone is talking, OR
    // — only when motion gating is enabled — something is visibly moving.
    // Audio and motion are OR'd, not AND'd: either signal alone is reason
    // enough to stay at full speed, so a silent-but-busy scene (e.g. a
    // silent screen-share with cursor movement) doesn't get sped past.
    const rawActiveNow = signals.isVoice || (signals.motionEnabled && signals.isMotion);

    if (rawActiveNow !== this.rawActive) {
      this.rawActive = rawActiveNow;
      this.rawStateSince = now;
    }
    const rawStateDuration = now - this.rawStateSince;

    if (this.committedQuiet && this.rawActive && rawStateDuration >= settings.minVoiceMs) {
      this.committedQuiet = false;
    } else if (
      !this.committedQuiet &&
      !this.rawActive &&
      rawStateDuration >= settings.minSilenceMs
    ) {
      this.committedQuiet = true;
    }

    this.state.isVoice = signals.isVoice;
    this.state.isMotion = signals.isMotion;
    this.state.currentMultiplier = this.committedQuiet ? settings.quietSpeed : settings.normalSpeed;

    return this.state.currentMultiplier;
  }

  get snapshot(): Readonly<PipelineState> {
    return this.state;
  }
}