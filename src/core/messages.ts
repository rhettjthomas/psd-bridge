import type { ImportReport, IRDocument, ReportItem } from './model';
import type { PlannedLayer } from './plan';
import type { ImportSettings } from './settings';
import type { FamilyStyles, FontMap, FontMatch, FontName } from './fonts';

export type DocInfo = Omit<IRDocument, 'layers'>;

/** UI iframe → main thread. */
export type UIToMain =
  | { type: 'ui-ready' }
  | { type: 'save-settings'; settings: ImportSettings }
  | { type: 'save-font-map'; fontMap: FontMap }
  /** Log the parsed tree in the main-thread console. */
  | { type: 'debug-tree'; doc: IRDocument }
  /** Match PostScript names against Figma's fonts and the saved map. */
  | { type: 'resolve-fonts'; postScriptNames: string[] }
  | {
      type: 'import-begin';
      doc: DocInfo;
      settings: ImportSettings;
      totalLayers: number;
      preflight: ReportItem[];
      /** Final font for every PostScript name the import uses. */
      fonts: Record<string, FontName>;
      /** PostScript names the user skipped (they use the default font and are reported). */
      skippedFonts: string[];
    }
  /** Layers in document order (parents before children, siblings bottom-first). */
  | { type: 'layers-batch'; layers: PlannedLayer[] }
  | { type: 'import-end'; report: ReportItem[] }
  | { type: 'import-abort'; message: string }
  /** Select and zoom to a node from the report. */
  | { type: 'select-node'; nodeId: string }
  /** Open the PSD prep guide in the browser. */
  | { type: 'open-prep-guide' };

export const PREP_GUIDE_URL = 'https://github.com/rhettjthomas/psd-bridge/blob/main/docs/PSD-PREP.md';

/** Main thread → UI iframe. */
export type MainToUI =
  | { type: 'init'; settings: ImportSettings; fontMap: FontMap; version: string; licensed: boolean }
  | { type: 'fonts'; matches: FontMatch[]; families: FamilyStyles[]; fontMap: FontMap }
  | { type: 'batch-ack' }
  | { type: 'progress'; done: number; total: number; label: string }
  | { type: 'report'; report: ImportReport }
  | { type: 'error'; message: string };

/** Max layers per postMessage batch; keeps the window responsive on large PSDs. */
export const LAYER_BATCH_SIZE = 20;
/** Max PNG bytes per batch, so a few huge layers don't pile up in memory. */
export const BATCH_BYTE_LIMIT = 48 * 1024 * 1024;

