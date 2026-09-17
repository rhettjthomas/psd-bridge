import { describe, expect, it } from 'vitest';
import { buildFontIndex, matchFont, parseFontMapJson, parsePostScriptName } from '../src/core/fonts';

const available = [
  { family: 'Inter', style: 'Regular' },
  { family: 'Inter', style: 'Semi Bold' },
  { family: 'Playfair Display', style: 'Bold Italic' },
  { family: 'Arial', style: 'Regular' },
];
const index = buildFontIndex(available);

describe('parsePostScriptName', () => {
  it('splits family and style', () => {
    expect(parsePostScriptName('Inter-SemiBold')).toEqual({ family: 'Inter', style: 'Semi Bold' });
    expect(parsePostScriptName('Futura')).toEqual({ family: 'Futura', style: 'Regular' });
  });
});

describe('matchFont', () => {
  it('matches PostScript names to family + style', () => {
    expect(matchFont('Inter-SemiBold', index, {}).font).toEqual({ family: 'Inter', style: 'Semi Bold' });
    expect(matchFont('PlayfairDisplay-BoldItalic', index, {}).source).toBe('exact');
  });
  it('matches a bare family to Regular, including MT suffixes', () => {
    expect(matchFont('Inter', index, {}).font?.style).toBe('Regular');
    expect(matchFont('ArialMT', index, {}).font?.family).toBe('Arial');
  });
  it('uses saved matches when no exact match exists', () => {
    const saved = { 'NeueHaasGroteskDisp-Bold': { family: 'Inter', style: 'Semi Bold' } };
    expect(matchFont('NeueHaasGroteskDisp-Bold', index, saved)).toEqual({
      postScriptName: 'NeueHaasGroteskDisp-Bold',
      font: { family: 'Inter', style: 'Semi Bold' },
      source: 'saved',
    });
  });
  it('ignores saved matches whose replacement is not installed', () => {
    const saved = { 'Foo-Bold': { family: 'Gone', style: 'Bold' } };
    expect(matchFont('Foo-Bold', index, saved).source).toBe('missing');
  });
});

describe('parseFontMapJson', () => {
  it('keeps valid entries and drops malformed ones', () => {
    const json = JSON.stringify({ 'A-Bold': { family: 'Inter', style: 'Bold' }, bad: { family: 1 }, worse: null });
    expect(parseFontMapJson(json)).toEqual({ 'A-Bold': { family: 'Inter', style: 'Bold' } });
  });
});
