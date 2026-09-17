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
  const exact = index.byKey.get(key) ?? index.byKey.get(key.replace(/mt$|std$|pro$/, ''));
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
