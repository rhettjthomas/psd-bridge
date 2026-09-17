import { describe, expect, it } from 'vitest';
import { parseStrict } from '../src/ui/fontmap-sheet';

describe('parseStrict (Font map window)', () => {
  it('treats empty text as an empty map', () => {
    expect(parseStrict('  ')).toEqual({});
  });

  it('accepts a valid map', () => {
    expect(parseStrict('{"A-Bold": {"family": "Inter", "style": "Bold"}}')).toEqual({ 'A-Bold': { family: 'Inter', style: 'Bold' } });
  });

  it('explains invalid JSON, non-objects, and incomplete entries', () => {
    expect(() => parseStrict('{"A-Bold": ')).toThrow(/valid JSON/);
    expect(() => parseStrict('[1, 2]')).toThrow(/JSON object/);
    expect(() => parseStrict('{"A-Bold": {"family": "Inter"}}')).toThrow(/1 font match is missing/);
  });
});
