import type { IRBlendMode } from './model';

/** PSD blend modes (ag-psd names) that have a direct Figma equivalent. */
const BLEND_MAP: Record<string, IRBlendMode> = {
  'pass through': 'PASS_THROUGH',
  normal: 'NORMAL',
  darken: 'DARKEN',
  multiply: 'MULTIPLY',
  'color burn': 'COLOR_BURN',
  'linear burn': 'LINEAR_BURN',
  lighten: 'LIGHTEN',
  screen: 'SCREEN',
  'color dodge': 'COLOR_DODGE',
  'linear dodge': 'LINEAR_DODGE',
  overlay: 'OVERLAY',
  'soft light': 'SOFT_LIGHT',
  'hard light': 'HARD_LIGHT',
  difference: 'DIFFERENCE',
  exclusion: 'EXCLUSION',
  hue: 'HUE',
  saturation: 'SATURATION',
  color: 'COLOR',
  luminosity: 'LUMINOSITY',
};

export interface BlendResult {
  mode: IRBlendMode;
  /** True when the PSD mode had no equivalent and fell back to Normal. */
  fallback: boolean;
}

export function mapBlendMode(psdMode: string | undefined, isGroup: boolean): BlendResult {
  if (!psdMode) return { mode: isGroup ? 'PASS_THROUGH' : 'NORMAL', fallback: false };
  const mode = BLEND_MAP[psdMode];
  if (!mode) return { mode: 'NORMAL', fallback: true };
  // Pass through is only meaningful on groups.
  if (mode === 'PASS_THROUGH' && !isGroup) return { mode: 'NORMAL', fallback: false };
  return { mode, fallback: false };
}

const REVERSE_BLEND = Object.fromEntries(Object.entries(BLEND_MAP).map(([psd, figma]) => [figma, psd])) as Record<IRBlendMode, string>;

/** Figma blend mode → the PSD (ag-psd) name. Unknown modes fall back to normal. */
export function toPsdBlendMode(mode: string | undefined, isGroup: boolean): string {
  if (!mode) return isGroup ? 'pass through' : 'normal';
  return REVERSE_BLEND[mode as IRBlendMode] ?? 'normal';
}
