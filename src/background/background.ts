import { DEFAULT_SETTINGS, STORAGE_KEY } from "../types";

/**
 * MV3 service worker. Deliberately minimal: this extension does its real
 * work in content scripts (they're the ones with DOM/video access) and
 * coordinates purely through chrome.storage, which every context can read
 * and subscribe to — no message-passing plumbing needed for v1.
 *
 * The one job left for the background worker is seeding defaults on
 * install, so the popup and content scripts never have to special-case
 * "settings don't exist yet".
 */
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(STORAGE_KEY);
  if (existing[STORAGE_KEY]) return;
  await chrome.storage.sync.set({ [STORAGE_KEY]: DEFAULT_SETTINGS });
});