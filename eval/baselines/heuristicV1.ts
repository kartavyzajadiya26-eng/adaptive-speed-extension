import type { AudioFrameFeatures, ExtensionSettings, VadEngine } from "../../src/types";

/** How much louder than the tracked ambient noise floor a frame must be to
 *  count as speech, on top of the user's absolute silenceThresholdDb. */
const NOISE_FLOOR_MARGIN_DB = 8;

/** Rate the floor rises toward a louder reading (per frame, ~60/s via
 *  requestAnimationFrame). Deliberately slow — a few seconds of sustained
 *  loudness before the floor trusts it's the new ambient level — so a
 *  burst of speech can't drag the floor up and mask itself mid-sentence. */
const NOISE_FLOOR_RISE_RATE = 0.005;

/** Rate the floor falls toward a quieter reading. Deliberately fast — under
 *  a second — so once speech stops, the floor snaps back down to reveal
 *  the actual ambient level again instead of staying pinned near the
 *  loudness speech had left behind. */
const NOISE_FLOOR_FALL_RATE = 0.05;

/** How many recent frames of zero-crossing-rate the cadence tracker keeps
 *  (~400ms at 60fps via requestAnimationFrame) before it's willing to judge
 *  a sound as monotone. Short enough to catch a sustained tone/alarm within
 *  well under a second; long enough that a couple of frames of buffer noise
 *  can't trigger a false read. */
const CADENCE_WINDOW_FRAMES = 24;

/** Minimum (max-min) swing in ZCR across that window for a sound to count
 *  as having the varying texture of real speech. A steady tone or hum sits
 *  well under this; speech — alternating vowels and consonants — clears it
 *  comfortably within one window. */
const MONOTONE_ZCR_RANGE = 0.02;

/**
 * Default VAD: a DSP heuristic, not a machine-learning model.
 *
 * It classifies a frame as "voice" when BOTH are true:
 *   1. Broadband RMS clears BOTH the user's absolute silence threshold AND
 *      a floor that tracks recent ambient noise (see below).
 *   2. (optional) A meaningful share of that energy sits in the speech
 *      formant band, so a loud bass note doesn't get mistaken for talking.
 *
 * This is intentionally the same family of technique real-time VADs used
 * before neural approaches (e.g. WebRTC's energy-based VAD mode). It runs
 * in microseconds, needs no model download, and works inside any page's
 * CSP. The trade-off: it will occasionally misfire on non-speech sounds
 * that happen to sit in the voice band (e.g. a violin, someone whistling).
 * See README → "Upgrading to ML-based VAD" for how to swap in Silero VAD
 * for materially better accuracy once you've validated this pipeline.
 *
 * Adaptive noise floor: a fixed silenceThresholdDb alone treats any steady
 * background sound louder than that threshold (fan hum, AC, traffic,
 * room tone) as "loud enough", leaving it stuck at normalSpeed even though
 * nobody's talking. Instead of only comparing against the user's fixed
 * threshold, this tracks a running estimate of the ambient noise level and
 * requires speech to be meaningfully louder than *that*, not just louder
 * than silence.
 *
 * The tracker updates on every frame (not just non-voice ones — a sound
 * that's currently misclassified as "voice" because it merely clears the
 * fixed threshold would otherwise never get the chance to teach the floor
 * that it's actually just the room's ambient level), but asymmetrically:
 * it rises slowly and falls quickly. That's what keeps a sustained loud
 * utterance from ever dragging the floor up to meet it (which would raise
 * the bar for "voice" mid-sentence and start clipping words), while still
 * letting the floor snap back down promptly once things get quieter.
 *
 * Cadence (manner-of-speech) check: loudness and spectral band alone can
 * still be fooled by a sustained tone or alarm that happens to sit in the
 * speech band at speech-like volume. Real speech constantly varies its
 * zero-crossing rate as it moves between vowel-like and consonant-like
 * sounds — a steady tone doesn't. This tracks a short rolling window of
 * zero-crossing-rate readings and, once that window is full, disqualifies
 * anything whose rate has stayed essentially flat the whole time. It only
 * ever *disqualifies* an already loud-and-in-band candidate — it never
 * blocks acceptance early on — so it can't add extra lag to voice-start
 * detection (freshly-arrived speech simply hasn't had a chance to look
 * "flat" yet, since the window still holds pre-speech history too).
 *
 * One instance per <video> (see VideoPipeline), so the floor and cadence
 * window are per-pipeline state, not shared globally.
 */
export class HeuristicVad implements VadEngine {
  private noiseFloorDb = -100;
  private readonly zcrWindow: number[] = [];

  isVoice(features: AudioFrameFeatures, settings: ExtensionSettings): boolean {
    const effectiveThreshold = Math.max(
      settings.silenceThresholdDb,
      this.noiseFloorDb + NOISE_FLOOR_MARGIN_DB
    );
    const loudEnough = features.rmsDb > effectiveThreshold;

    // Require at least 35% of energy in the speech band once we're already
    // above the loudness floor. Threshold picked empirically to tolerate
    // normal spectral variance in speech, not tuned against a labeled set
    // — treat it as a starting point, and expose it in the popup if you
    // find it needs adjusting for your content.
    const soundsLikeSpeech = !settings.voiceBandBias || features.voiceBandRatio >= 0.35;

    this.zcrWindow.push(features.zeroCrossingRate);
    if (this.zcrWindow.length > CADENCE_WINDOW_FRAMES) this.zcrWindow.shift();
    const windowFull = this.zcrWindow.length === CADENCE_WINDOW_FRAMES;
    const zcrRange = windowFull ? Math.max(...this.zcrWindow) - Math.min(...this.zcrWindow) : Infinity;
    const hasSpeechCadence = !settings.voiceBandBias || zcrRange >= MONOTONE_ZCR_RANGE;

    const isVoice = loudEnough && soundsLikeSpeech && hasSpeechCadence;

    const rate = features.rmsDb > this.noiseFloorDb ? NOISE_FLOOR_RISE_RATE : NOISE_FLOOR_FALL_RATE;
    this.noiseFloorDb += (features.rmsDb - this.noiseFloorDb) * rate;

    return isVoice;
  }
}