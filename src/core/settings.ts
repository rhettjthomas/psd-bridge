export interface ImportSettings {
  editableText: boolean;
  editableVectors: boolean;
  importHidden: boolean;
  rebuildShadows: boolean;
  flattenGroups: boolean;
}

export const DEFAULT_SETTINGS: ImportSettings = {
  editableText: true,
  editableVectors: true,
  importHidden: true,
  rebuildShadows: true,
  flattenGroups: false,
};

export const SETTINGS_KEY = 'psd-bridge/settings';
export const FONT_MAP_KEY = 'psd-bridge/font-map';

/** Merge stored settings over defaults, ignoring unknown or mistyped keys. */
export function normalizeSettings(stored: unknown): ImportSettings {
  const out = { ...DEFAULT_SETTINGS };
  if (stored && typeof stored === 'object') {
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof ImportSettings)[]) {
      const v = (stored as Record<string, unknown>)[key];
      if (typeof v === 'boolean') out[key] = v;
    }
  }
  return out;
}
