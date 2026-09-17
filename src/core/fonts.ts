import type { IRLayer } from './model';

/**
 * Font matching between Photoshop PostScript names and Figma's font list.
 * Pure functions only; the main thread supplies figma.listAvailableFontsAsync() results.
 */

export interface FontName {
  family: string;
  style: string;
}

/** Saved matches: PostScript name → replacement font. */
export type FontMap = Record<string, FontName>;

/** Lowercase and drop everything but letters and digits, e.g. "Semi Bold" → "semibold". */
export function normalizeFontKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Best-effort split of a PostScript name into family + style for display.
 * "Inter-SemiBold" → { family: "Inter", style: "Semi Bold" }.
 */
export function parsePostScriptName(ps: string): FontName {
  const dash = ps.lastIndexOf('-');
  const rawFamily = dash > 0 ? ps.slice(0, dash) : ps;
  const rawStyle = dash > 0 ? ps.slice(dash + 1) : 'Regular';
  const spaced = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return { family: spaced(rawFamily), style: spaced(rawStyle) || 'Regular' };
}

export interface FontIndex {
  byKey: Map<string, FontName>;
}

/** Build a lookup keyed by normalized family+style (and family alone for Regular). */
export function buildFontIndex(available: FontName[]): FontIndex {
  const byKey = new Map<string, FontName>();
  for (const f of available) {
    const key = normalizeFontKey(f.family + f.style);
    if (!byKey.has(key)) byKey.set(key, f);
    if (normalizeFontKey(f.style) === 'regular') {
      const famKey = normalizeFontKey(f.family);
      if (!byKey.has(famKey)) byKey.set(famKey, f);
    }
  }
  return { byKey };
}

export type MatchSource = 'exact' | 'saved' | 'missing';

export interface FontMatch {
  postScriptName: string;
  font: FontName | null;
  source: MatchSource;
}

/** Match by family + style first, then saved matches; anything else is missing. */
export function matchFont(postScriptName: string, index: FontIndex, saved: FontMap): FontMatch {
  const key = normalizeFontKey(postScriptName);
  // Common PostScript suffixes that aren't part of the family name (ArialMT, TimesNewRomanPSMT).
  const exact = index.byKey.get(key) ?? index.byKey.get(key.replace(/(psmt|mt|std|pro)$/, ''));
  if (exact) return { postScriptName, font: exact, source: 'exact' };
  const s = saved[postScriptName];
  if (s && index.byKey.has(normalizeFontKey(s.family + s.style))) {
    return { postScriptName, font: s, source: 'saved' };
  }
  return { postScriptName, font: null, source: 'missing' };
}

/** Validate a font map loaded from a JSON file. Drops malformed entries. */
export function parseFontMapJson(json: string): FontMap {
  const data: unknown = JSON.parse(json);
  const out: FontMap = {};
  const entries = data && typeof data === 'object' ? Object.entries(data as object) : [];
  for (const [ps, v] of entries) {
    const f = v as Partial<FontName> | null;
    if (f && typeof f.family === 'string' && typeof f.style === 'string') {
      out[ps] = { family: f.family, style: f.style };
    }
  }
  return out;
}

/** Used when a font is skipped in the matching window, and as the text node's starting font. */
export const DEFAULT_FONT: FontName = { family: 'Inter', style: 'Regular' };

export interface FontUsage {
  postScriptName: string;
  /** Names of the layers that use this font. */
  layers: string[];
  /** A short text sample for the live preview. */
  sample: string;
}

/** Every PostScript font used by the given text layers, in first-use order. */
export function collectFontUsage(layers: IRLayer[]): FontUsage[] {
  const byName = new Map<string, FontUsage>();
  for (const l of layers) {
    if (!l.text) continue;
    for (const run of l.text.runs) {
      const ps = run.postScriptName;
      if (!ps) continue;
      let u = byName.get(ps);
      if (!u) {
        u = { postScriptName: ps, layers: [], sample: '' };
        byName.set(ps, u);
      }
      if (!u.layers.includes(l.name)) u.layers.push(l.name);
      if (!u.sample.trim()) u.sample = l.text.content.slice(run.start, run.end).replace(/\s+/g, ' ').trim().slice(0, 40);
    }
  }
  return [...byName.values()];
}

export interface FamilyStyles {
  family: string;
  styles: string[];
}

/** Group Figma's flat font list by family, both sorted. */
export function groupFamilies(available: FontName[]): FamilyStyles[] {
  const map = new Map<string, Set<string>>();
  for (const f of available) {
    if (!map.has(f.family)) map.set(f.family, new Set());
    map.get(f.family)!.add(f.style);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([family, styles]) => ({ family, styles: [...styles].sort(styleOrder) }));
}

const STYLE_WEIGHTS = ['thin', 'hairline', 'extralight', 'ultralight', 'light', 'regular', 'book', 'medium', 'semibold', 'demibold', 'bold', 'extrabold', 'ultrabold', 'black', 'heavy'];

function styleOrder(a: string, b: string): number {
  const rank = (s: string) => {
    const k = normalizeFontKey(s).replace('italic', '');
    const i = STYLE_WEIGHTS.indexOf(k || 'regular');
    return (i < 0 ? 5 : i) * 2 + (/italic/i.test(s) ? 1 : 0);
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}
