import type { ImportReport, IRDocument, IRLayer } from './model';
import type { ImportSettings } from './settings';
import type { FontMap } from './fonts';

/** UI iframe → main thread. */
export type UIToMain =
  | { type: 'ui-ready' }
  | { type: 'save-settings'; settings: ImportSettings }
  | { type: 'save-font-map'; fontMap: FontMap }
  /** M1: hand the parsed tree to the main thread for logging. */
  | { type: 'debug-tree'; doc: IRDocument }
  | { type: 'import-begin'; doc: Omit<IRDocument, 'layers'>; settings: ImportSettings; totalLayers: number }
  | { type: 'layers-batch'; layers: IRLayer[] }
  | { type: 'import-end' }
  | { type: 'cancel' };

/** Main thread → UI iframe. */
export type MainToUI =
  | { type: 'init'; settings: ImportSettings; fontMap: FontMap; version: string; licensed: boolean }
  | { type: 'progress'; done: number; total: number; label: string }
  | { type: 'report'; report: ImportReport }
  | { type: 'error'; message: string };

/** Layers per postMessage batch; keeps the window responsive on large PSDs. */
export const LAYER_BATCH_SIZE = 20;
