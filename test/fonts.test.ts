import { describe, expect, it } from 'vitest';
import { buildFontIndex, collectFontUsage, groupFamilies, matchFont, parseFontMapJson, parsePostScriptName } from '../src/core/fonts';
import type { IRLayer } from '../src/core/model';

const available = [
  { family: 'Inter', style: 'Regular' },
  { family: 'Inter', style: 'Semi Bold' },
  { family: 'Playfair Display', style: 'Bold Italic' },
  { family: 'Arial', style: 'Regular' },
  { family: 'Times New Roman', style: 'Regular' },
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
    expect(matchFont('TimesNewRomanPSMT', index, {}).font?.family).toBe('Times New Roman');
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

describe('collectFontUsage', () => {
  const text = (name: string, content: string, runs: [number, number, string][]) =>
    ({ name, text: { content, runs: runs.map(([start, end, postScriptName]) => ({ start, end, postScriptName })) } }) as unknown as IRLayer;

  it('lists each font once with its layers and a sample', () => {
    const usage = collectFontUsage([
      text('Title', 'Grace  Upon', [[0, 5, 'A-Bold'], [5, 11, 'B-Regular']]),
      text('Sub', 'Week one', [[0, 8, 'A-Bold']]),
      { name: 'Pixels' } as IRLayer,
    ]);
    expect(usage).toEqual([
      { postScriptName: 'A-Bold', layers: ['Title', 'Sub'], sample: 'Grace' },
      { postScriptName: 'B-Regular', layers: ['Title'], sample: 'Upon' },
    ]);
  });
});

describe('groupFamilies', () => {
  it('groups by family and orders styles by weight', () => {
    expect(groupFamilies([
      { family: 'Inter', style: 'Bold' },
      { family: 'Inter', style: 'Light Italic' },
      { family: 'Inter', style: 'Regular' },
      { family: 'Inter', style: 'Light' },
      { family: 'Arial', style: 'Regular' },
    ])).toEqual([
      { family: 'Arial', styles: ['Regular'] },
      { family: 'Inter', styles: ['Light', 'Light Italic', 'Regular', 'Bold'] },
    ]);
  });
});
