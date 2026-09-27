/**
 * Shared types for the extension. Imported by content, background and popup
 * bundles alike — keep this file free of any DOM-only or chrome.* side effects.
 */

export type OperatingMode = "audio-only" | "audio-and-motion";

/** How eagerly natural pauses get fast-forwarded (see SpeedController). */
export type PauseHandling = "relaxed" | "balanced" | "aggressive";

/** Everything the user can configure, persisted in chrome.storage.sync. */
export interface ExtensionSettings {
  /** Master on/off switch. */
  enabled: boolean;

  /** "audio-only" = classic silence-skipping. "audio-and-motion" also watches
   *  the picture: silent stretches where something moves play at a gentler
   *  speed-up instead of full quietSpeed (cross-origin video without CORS
   *  can't be read and behaves as audio-only). */
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

  /** Sustained voice required, in ms, before switching back to normalSpeed.
   *  0 by default: both detectors already debounce their output, and every
   *  extra millisecond here is heard as sped-up speech at each sentence start. */
  minVoiceMs: number;

  /** When speech resumes after a fast-forwarded pause, jump back a fraction
   *  of a second so the first words are heard at normal speed. */
  replaySentenceStarts: boolean;

  /** relaxed: only clearly long pauses speed up (smoothest).
   *  balanced: learns the speaker's rhythm, skips most sentence breaks.
   *  aggressive: speeds up most pauses (saves the most time, more switching). */
  pauseHandling: PauseHandling;

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
  silenceThresholdDb: -55,
  voiceBandBias: true,
  minSilenceMs: 600,
  minVoiceMs: 0,
  replaySentenceStarts: true,
  pauseHandling: "balanced",
  motionThreshold: 10,
  motionSampleFps: 4,
  showIndicator: true,
};

export const STORAGE_KEY = "adaptiveSpeedSettings" as const;

/** Bumped when default values change; see background.ts migration. */
export const SETTINGS_SCHEMA = 2;

/** Defaults from earlier schemas. A stored value still equal to its old
 *  default was never chosen by the user, so it moves to the new default. */
export const PREVIOUS_DEFAULTS: Partial<ExtensionSettings> = {
  minVoiceMs: 100,
  silenceThresholdDb: -45,
};

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
  /** `dtMs` is the time since the previous call, so time constants don't
   *  depend on the display's frame rate. */
  isVoice(features: AudioFrameFeatures, settings: ExtensionSettings, dtMs?: number): boolean;
}

/** Runtime (non-persisted) state tracked per <video> element, surfaced to
 *  the on-screen indicator. */
export interface PipelineState {
  isVoice: boolean;
  isMotion: boolean;
  currentMultiplier: number;
}