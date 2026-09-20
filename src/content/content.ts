import { DEFAULT_SETTINGS, STORAGE_KEY, type ExtensionSettings } from "../types";
import { VideoManager } from "../core/videoManager";

/**
 * Content script entry point. Injected into every frame of every page
 * (see manifest.json). Reads persisted settings, starts the VideoManager,
 * and keeps it in sync with live changes made from the popup.
 */
async function main(): Promise<void> {
  const settings = await loadSettings();
  const manager = new VideoManager(settings);
  manager.start();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync" && areaName !== "local") return;
    const change = changes[STORAGE_KEY];
    if (!change) return;
    manager.updateSettings({ ...DEFAULT_SETTINGS, ...(change.newValue as Partial<ExtensionSettings>) });
  });
}

async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  const value = stored[STORAGE_KEY] as Partial<ExtensionSettings> | undefined;
  return { ...DEFAULT_SETTINGS, ...value };
}

main().catch((err) => {
  console.error("[AdaptiveSpeed] content script failed to start:", err);
});