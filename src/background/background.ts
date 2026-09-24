import { DEFAULT_SETTINGS, PREVIOUS_DEFAULTS, SETTINGS_SCHEMA, STORAGE_KEY, type ExtensionSettings } from "../types";

/**
 * MV3 service worker. Deliberately minimal: this extension does its real
 * work in content scripts (they're the ones with DOM/video access) and
 * coordinates purely through chrome.storage, which every context can read
 * and subscribe to.
 *
 * Its jobs: seed defaults on install, and on update move settings that are
 * still at an old default to the new default (values the user changed are
 * left alone).
 */
const SCHEMA_KEY = `${STORAGE_KEY}Schema`;

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get([STORAGE_KEY, SCHEMA_KEY]);
  const existing = stored[STORAGE_KEY] as Partial<ExtensionSettings> | undefined;
  if (!existing) {
    await chrome.storage.sync.set({ [STORAGE_KEY]: DEFAULT_SETTINGS, [SCHEMA_KEY]: SETTINGS_SCHEMA });
    return;
  }
  if ((stored[SCHEMA_KEY] as number | undefined) === SETTINGS_SCHEMA) return;

  const migrated: Record<string, unknown> = { ...DEFAULT_SETTINGS, ...existing };
  for (const [key, oldDefault] of Object.entries(PREVIOUS_DEFAULTS)) {
    if (existing[key as keyof ExtensionSettings] === oldDefault) {
      migrated[key] = DEFAULT_SETTINGS[key as keyof ExtensionSettings];
    }
  }
  await chrome.storage.sync.set({ [STORAGE_KEY]: migrated, [SCHEMA_KEY]: SETTINGS_SCHEMA });
});
