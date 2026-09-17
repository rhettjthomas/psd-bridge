/**
 * Font matching window. Lists fonts Figma can't find and collects a replacement
 * (or a skip) for each one before anything is placed on the canvas.
 */
import {
  DEFAULT_FONT,
  parseFontMapJson,
  parsePostScriptName,
  normalizeFontKey,
  type FamilyStyles,
  type FontMap,
  type FontMatch,
  type FontName,
  type FontUsage,
} from '../core/fonts';
import { attachCombobox } from './combobox';

interface Choice {
  font?: FontName;
  skip: boolean;
  remember: boolean;
}

export interface FontResolution {
  fonts: Record<string, FontName>;
  skipped: string[];
  /** The saved map plus every match the user asked to remember. */
  fontMap: FontMap;
}

export interface FontsPanelOptions {
  root: HTMLElement;
  /** Ask the main thread to (re)match fonts. */
  rescan: () => void;
  /** Persist the font map. */
  saveFontMap: (map: FontMap) => void;
  /** Called whenever readiness may have changed. */
  onChange: () => void;
  notify: (level: 'error' | 'warning', text: string) => void;
}

export class FontsPanel {
  private usage: FontUsage[] = [];
  private matches: FontMatch[] = [];
  private families = new Map<string, string[]>();
  private familyKeys = new Map<string, string>();
  private fontMap: FontMap = {};
  private readonly choices = new Map<string, Choice>();
  private enabled = true;

  constructor(private readonly opts: FontsPanelOptions) {
    const { root } = opts;
    root.querySelector('#rescan-fonts')!.addEventListener('click', () => opts.rescan());
    root.querySelector('#export-map')!.addEventListener('click', () => this.exportMap());
    const input = root.querySelector<HTMLInputElement>('#map-input')!;
    root.querySelector('#import-map')!.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.value = '';
      if (file) await this.importMap(file);
    });
  }

  /** New file loaded: forget previous fonts and choices. */
  reset(usage: FontUsage[]) {
    this.usage = usage;
    this.matches = [];
    this.choices.clear();
    this.render();
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.render();
  }

  setFontMap(map: FontMap) {
    this.fontMap = map;
  }

  /** Main thread answered a resolve-fonts request. */
  update(matches: FontMatch[], families: FamilyStyles[], fontMap: FontMap) {
    this.matches = matches;
    this.fontMap = fontMap;
    this.families = new Map(families.map((f) => [f.family, f.styles]));
    this.familyKeys = new Map(families.map((f) => [normalizeFontKey(f.family), f.family]));
    for (const m of matches) {
      if (m.source !== 'missing') this.choices.delete(m.postScriptName);
      else if (!this.choices.has(m.postScriptName)) this.choices.set(m.postScriptName, { skip: false, remember: true, font: this.guess(m.postScriptName) });
    }
    this.render();
  }

  get missing(): FontMatch[] {
    return this.matches.filter((m) => m.source === 'missing');
  }

  get pending(): boolean {
    return this.usage.length > 0 && this.matches.length === 0;
  }

  /** Every missing font has a replacement or was skipped. */
  get ready(): boolean {
    if (!this.enabled || this.usage.length === 0) return true;
    if (this.pending) return false;
    return this.missing.every((m) => {
      const c = this.choices.get(m.postScriptName);
      return !!c && (c.skip || !!c.font);
    });
  }

  resolve(): FontResolution {
    const fonts: Record<string, FontName> = {};
    const skipped: string[] = [];
    const fontMap = { ...this.fontMap };
    for (const m of this.matches) {
      if (m.font) {
        fonts[m.postScriptName] = m.font;
        continue;
      }
      const c = this.choices.get(m.postScriptName);
      if (!c || c.skip || !c.font) {
        skipped.push(m.postScriptName);
        continue;
      }
      fonts[m.postScriptName] = c.font;
      if (c.remember) fontMap[m.postScriptName] = c.font;
    }
    return { fonts, skipped, fontMap };
  }

  /** Suggest the same family when Figma has it under a slightly different style name. */
  private guess(ps: string): FontName | undefined {
    const parsed = parsePostScriptName(ps);
    const key = normalizeFontKey(parsed.family);
    // PostScript names often abbreviate the family ("NeueHaasGroteskDisp"), so fall back to the
    // shortest installed family that starts with it.
    const family =
      this.familyKeys.get(key) ??
      (key.length >= 4
        ? [...this.familyKeys.entries()].filter(([k]) => k.startsWith(key)).sort(([a], [b]) => a.length - b.length)[0]?.[1]
        : undefined);
    if (!family) return undefined;
    const styles = this.families.get(family) ?? [];
    const want = normalizeFontKey(parsed.style);
    const style =
      styles.find((s) => normalizeFontKey(s) === want) ??
      styles.find((s) => normalizeFontKey(s).startsWith(want) || want.startsWith(normalizeFontKey(s))) ??
      styles.find((s) => normalizeFontKey(s) === 'regular') ??
      styles[0];
    return style ? { family, style } : undefined;
  }

  private render() {
    const { root } = this.opts;
    const missing = this.missing;
    root.hidden = !this.enabled || missing.length === 0;

    root.querySelector('#fonts-count')!.textContent = `${missing.length} missing`;
    root.querySelector('#font-rows')!.replaceChildren(...missing.map((m) => this.row(m)));
    this.opts.onChange();
  }

  private row(m: FontMatch): HTMLElement {
    const ps = m.postScriptName;
    const usage = this.usage.find((u) => u.postScriptName === ps);
    const choice = this.choices.get(ps)!;

    const row = document.createElement('div');
    row.className = `font-row${choice.skip ? ' skipped' : ''}`;
    row.innerHTML = `
      <div class="font-ps"><strong></strong><span class="muted"></span></div>
      <div class="font-pick">
        <div class="combo"><input class="family" placeholder="Search installed fonts" spellcheck="false" /></div>
        <div class="select"><select class="style" aria-label="Style"></select></div>
      </div>
      <div class="font-preview"></div>
      <div class="font-opts">
        <label><input type="checkbox" class="remember" /> Remember this match</label>
        <button type="button" class="link skip"></button>
      </div>`;
    row.querySelector('.font-ps strong')!.textContent = ps;
    row.querySelector('.font-ps .muted')!.textContent = usage ? ` · ${usage.layers.join(', ')}` : '';

    const family = row.querySelector<HTMLInputElement>('.family')!;
    const style = row.querySelector<HTMLSelectElement>('.style')!;
    const preview = row.querySelector<HTMLElement>('.font-preview')!;
    const remember = row.querySelector<HTMLInputElement>('.remember')!;
    const skip = row.querySelector<HTMLButtonElement>('.skip')!;

    family.value = choice.font?.family ?? '';
    family.setAttribute('aria-label', `Replacement for ${ps}`);
    remember.checked = choice.remember;
    skip.textContent = choice.skip ? 'Undo skip' : 'Skip';
    family.disabled = style.disabled = remember.disabled = choice.skip;

    const fillStyles = () => {
      const styles = this.families.get(family.value) ?? [];
      style.replaceChildren(
        ...styles.map((s) => {
          const o = document.createElement('option');
          o.value = o.textContent = s;
          return o;
        }),
      );
      style.disabled = choice.skip || styles.length === 0;
      if (choice.font && styles.includes(choice.font.style)) style.value = choice.font.style;
    };

    const updatePreview = () => {
      const f = choice.skip ? DEFAULT_FONT : choice.font;
      preview.textContent = usage?.sample || 'The quick brown fox';
      preview.style.fontFamily = f ? `"${f.family}", ${DEFAULT_FONT.family}, sans-serif` : 'inherit';
      preview.style.fontWeight = f ? String(cssWeight(f.style)) : '';
      preview.style.fontStyle = f && /italic|oblique/i.test(f.style) ? 'italic' : 'normal';
      preview.classList.toggle('empty', !f);
    };

    const commit = () => {
      const styles = this.families.get(family.value);
      choice.font = styles ? { family: family.value, style: style.value || styles[0] } : undefined;
      updatePreview();
      this.opts.onChange();
    };

    attachCombobox({
      input: family,
      options: () => [...this.families.keys()],
      onChange: () => {
        fillStyles();
        commit();
      },
    });
    style.addEventListener('change', commit);
    remember.addEventListener('change', () => {
      choice.remember = remember.checked;
    });
    skip.addEventListener('click', () => {
      choice.skip = !choice.skip;
      this.render();
    });

    fillStyles();
    updatePreview();
    return row;
  }

  /** Saved matches plus any the user has chosen to remember in the open window. */
  currentMap(): FontMap {
    return this.resolve().fontMap;
  }

  exportMap() {
    const map = this.currentMap();
    const count = Object.keys(map).length;
    if (!count) {
      this.opts.notify('warning', 'There are no saved font matches to export yet.');
      return;
    }
    const blob = new Blob([JSON.stringify(map, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'psd-bridge-font-map.json';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.opts.notify('warning', `Exported ${count} font ${count === 1 ? 'match' : 'matches'}. If no file downloaded, use "Copy font map" in settings.`);
  }

  async copyMap() {
    const map = this.currentMap();
    const count = Object.keys(map).length;
    if (!count) {
      this.opts.notify('warning', 'There are no saved font matches to copy yet.');
      return;
    }
    const ok = await copyText(JSON.stringify(map, null, 2));
    this.opts.notify(ok ? 'warning' : 'error', ok
      ? `Copied ${count} font ${count === 1 ? 'match' : 'matches'}. Paste into a .json file to share.`
      : "Couldn't copy to the clipboard.");
  }

  pickMapFile() {
    this.opts.root.querySelector<HTMLInputElement>('#map-input')!.click();
  }

  clearSaved() {
    this.fontMap = {};
    for (const c of this.choices.values()) c.remember = false;
    this.opts.saveFontMap({});
    this.opts.notify('warning', 'Cleared saved font matches.');
    this.opts.rescan();
  }

  private async importMap(file: File) {
    try {
      const incoming = parseFontMapJson(await file.text());
      const count = Object.keys(incoming).length;
      if (!count) {
        this.opts.notify('error', `"${file.name}" has no font matches in it.`);
        return;
      }
      this.fontMap = { ...this.fontMap, ...incoming };
      this.opts.saveFontMap(this.fontMap);
      this.opts.notify('warning', `Imported ${count} font ${count === 1 ? 'match' : 'matches'}.`);
      this.opts.rescan();
    } catch {
      this.opts.notify('error', `"${file.name}" isn't a valid font map (JSON).`);
    }
  }
}

/** Clipboard API first; the execCommand fallback works in iframes that block it. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

function cssWeight(style: string): number {
  const s = normalizeFontKey(style);
  if (/thin|hairline/.test(s)) return 100;
  if (/extralight|ultralight/.test(s)) return 200;
  if (/light/.test(s)) return 300;
  if (/medium/.test(s)) return 500;
  if (/semibold|demibold/.test(s)) return 600;
  if (/extrabold|ultrabold/.test(s)) return 800;
  if (/black|heavy/.test(s)) return 900;
  if (/bold/.test(s)) return 700;
  return 400;
}
