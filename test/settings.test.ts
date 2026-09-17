import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/core/settings';

describe('normalizeSettings', () => {
  it('returns defaults for missing storage', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });
  it('keeps valid booleans and drops junk', () => {
    expect(normalizeSettings({ flattenGroups: true, editableText: 'yes', extra: 1 })).toEqual({
      ...DEFAULT_SETTINGS,
      flattenGroups: true,
    });
  });
});
