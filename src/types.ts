/**
 * Shared types for the extension. Imported by content, background and popup
 * bundles alike — keep this file free of any DOM-only or chrome.* side effects.
 */

export type OperatingMode = "audio-only" | "audio-and-motion";

/** Everything the user can configure, persisted in chrome.storage.sync. */
export interface ExtensionSettings {
  /** Master on/off switch. */
  enabled: boolean;

  /** "audio-only" = classic silence-skipping. "audio-and-motion" additionally
   *  requires the frame to be visually still before speeding up (see README
   *  for the accuracy/perf trade-off and cross-origin canvas caveat). */
  mode: OperatingMode;

  /** playbackRate applied while voice/motion is active. */
  normalSpeed: number;

  /** playbackRate applied while quiet (and, in audio-and-motion mode, still). */
  quietSpeed: number;

  /** RMS level, in dBFS, below which audio is treated as "quiet".
   *  Typical speech sits around -30..-10 dBFS; room tone/silence is usually
   *  below -50 dBFS. Range enforced by the popup UI: -70..-20. */
  silenceThresholdDb: number;

  /** When true, bias detection toward the 300Hz-3.4kHz speech formant band
   *  instead of raw broadband loudness. Cuts down on false "voice" triggers
   *  from music/rumble/hum. */
  voiceBandBias: boolean;

  /** Sustained silence required, in ms, before switching to quietSpeed.
   *  This is the "buffer" from the original idea: it prevents the speed
   *  from flapping on every short pause between words. */
  minSilenceMs: number;

  /** Sustained voice required, in ms, before switching back to normalSpeed. */
  minVoiceMs: number;

  /** Mean per-pixel luma delta (0-255) between sampled frames considered
   *  "significant movement". Only used in "audio-and-motion" mode. */
  motionThreshold: number;

  /** How many times per second to sample a downscaled video frame for
   *  motion analysis. Kept low on purpose — this runs on the main thread. */
  motionSampleFps: number;

  /** Show a small floating badge on the video with the live multiplier. */
  showIndicator: boolean;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: true,
  mode: "audio-only",
  normalSpeed: 1.0,
  quietSpeed: 2.5,
  silenceThresholdDb: -45,
  voiceBandBias: true,
  minSilenceMs: 600,
  minVoiceMs: 100,
  motionThreshold: 10,
  motionSampleFps: 4,
  showIndicator: true,
};

export const STORAGE_KEY = "adaptiveSpeedSettings" as const;

/** Per-frame audio features handed from the analyzer to the VAD engine. */
export interface AudioFrameFeatures {
  /** Broadband RMS level in dBFS (0 dBFS = full scale, negative = quieter). */
  rmsDb: number;
  /** 0..1 share of spectral energy inside the speech formant band. */
  voiceBandRatio: number;
  /** Zero-crossing rate of this frame's time-domain samples (0..1, fraction
   *  of adjacent-sample sign changes). Cheap proxy for pitch/texture — real
   *  speech's rate varies moment to moment as it alternates between
   *  vowel-like (low ZCR) and consonant-like (high ZCR) sounds; a steady
   *  tone, alarm, or drone holds a near-constant ZCR instead. */
  zeroCrossingRate: number;
}

/** Pluggable voice-activity engine. The shipped implementation is a cheap
 *  DSP heuristic (see src/audio/voiceActivity.ts); swap in a model-based
 *  engine (e.g. Silero VAD via @ricky0123/vad-web) by implementing this
 *  same interface — see README "Upgrading to ML-based VAD". */
export interface VadEngine {
  isVoice(features: AudioFrameFeatures, settings: ExtensionSettings): boolean;
}

/** Runtime (non-persisted) state tracked per <video> element, surfaced to
 *  the on-screen indicator. */
export interface PipelineState {
  isVoice: boolean;
  isMotion: boolean;
  currentMultiplier: number;
}