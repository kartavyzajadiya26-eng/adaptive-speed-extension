import { DEFAULT_SETTINGS, STORAGE_KEY, type ExtensionSettings } from "../types";

/**
 * Popup entry point. Reads/writes settings straight from chrome.storage.sync
 * (the same source of truth content scripts read) — no message-passing to
 * the background worker needed, matching the storage-only coordination
 * model the rest of the extension uses.
 */
const els = {
  enabled: byId<HTMLInputElement>("enabled"),
  mode: byId<HTMLSelectElement>("mode"),
  motionHint: byId<HTMLParagraphElement>("motionHint"),
  motionOnly: document.querySelector<HTMLElement>(".motion-only")!,
  normalSpeed: byId<HTMLInputElement>("normalSpeed"),
  normalSpeedOut: byId<HTMLOutputElement>("normalSpeedOut"),
  quietSpeed: byId<HTMLInputElement>("quietSpeed"),
  quietSpeedOut: byId<HTMLOutputElement>("quietSpeedOut"),
  silenceThresholdDb: byId<HTMLInputElement>("silenceThresholdDb"),
  silenceThresholdDbOut: byId<HTMLOutputElement>("silenceThresholdDbOut"),
  voiceBandBias: byId<HTMLInputElement>("voiceBandBias"),
  minSilenceMs: byId<HTMLInputElement>("minSilenceMs"),
  minVoiceMs: byId<HTMLInputElement>("minVoiceMs"),
  motionThreshold: byId<HTMLInputElement>("motionThreshold"),
  motionThresholdOut: byId<HTMLOutputElement>("motionThresholdOut"),
  showIndicator: byId<HTMLInputElement>("showIndicator"),
  status: byId<HTMLSpanElement>("status"),
};

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`popup.html missing #${id}`);
  return el as T;
}

let statusTimer: number | undefined;

async function main(): Promise<void> {
  const settings = await loadSettings();
  applyToForm(settings);

  for (const el of [
    els.enabled,
    els.mode,
    els.normalSpeed,
    els.quietSpeed,
    els.silenceThresholdDb,
    els.voiceBandBias,
    els.minSilenceMs,
    els.minVoiceMs,
    els.motionThreshold,
    els.showIndicator,
  ]) {
    el.addEventListener("input", onFormChange);
  }
}

function applyToForm(settings: ExtensionSettings): void {
  els.enabled.checked = settings.enabled;
  els.mode.value = settings.mode;
  els.normalSpeed.value = String(settings.normalSpeed);
  els.quietSpeed.value = String(settings.quietSpeed);
  els.silenceThresholdDb.value = String(settings.silenceThresholdDb);
  els.voiceBandBias.checked = settings.voiceBandBias;
  els.minSilenceMs.value = String(settings.minSilenceMs);
  els.minVoiceMs.value = String(settings.minVoiceMs);
  els.motionThreshold.value = String(settings.motionThreshold);
  els.showIndicator.checked = settings.showIndicator;
  updateOutputs();
  updateMotionVisibility();
}

function updateOutputs(): void {
  els.normalSpeedOut.textContent = `${Number(els.normalSpeed.value).toFixed(2)}×`;
  els.quietSpeedOut.textContent = `${Number(els.quietSpeed.value).toFixed(2)}×`;
  els.silenceThresholdDbOut.textContent = `${els.silenceThresholdDb.value} dB`;
  els.motionThresholdOut.textContent = els.motionThreshold.value;
}

function updateMotionVisibility(): void {
  const isMotionMode = els.mode.value === "audio-and-motion";
  els.motionOnly.classList.toggle("visible", isMotionMode);
  els.motionHint.style.display = isMotionMode ? "block" : "none";
}

function readForm(): ExtensionSettings {
  return {
    enabled: els.enabled.checked,
    mode: els.mode.value as ExtensionSettings["mode"],
    normalSpeed: Number(els.normalSpeed.value),
    quietSpeed: Number(els.quietSpeed.value),
    silenceThresholdDb: Number(els.silenceThresholdDb.value),
    voiceBandBias: els.voiceBandBias.checked,
    minSilenceMs: Number(els.minSilenceMs.value),
    minVoiceMs: Number(els.minVoiceMs.value),
    motionThreshold: Number(els.motionThreshold.value),
    motionSampleFps: DEFAULT_SETTINGS.motionSampleFps,
    showIndicator: els.showIndicator.checked,
  };
}

function onFormChange(): void {
  updateOutputs();
  updateMotionVisibility();
  void saveSettings(readForm());
}

async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  const value = stored[STORAGE_KEY] as Partial<ExtensionSettings> | undefined;
  return { ...DEFAULT_SETTINGS, ...value };
}

async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.sync.set({ [STORAGE_KEY]: settings });
  showStatus("Saved");
}

function showStatus(text: string): void {
  els.status.textContent = text;
  els.status.classList.add("visible");
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => els.status.classList.remove("visible"), 1200);
}

main().catch((err) => {
  console.error("[AdaptiveSpeed] popup failed to start:", err);
});
