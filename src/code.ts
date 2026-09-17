/**
 * Main thread. Owns the Figma document: settings storage, font loading, and (from M2)
 * node building. Never touches PSD bytes or canvas; the UI iframe does that.
 */
import type { MainToUI, UIToMain } from './core/messages';
import { formatTree } from './core/psd-reader';
import { FONT_MAP_KEY, normalizeSettings, SETTINGS_KEY } from './core/settings';
import type { FontMap } from './core/fonts';
import { isLicensed } from './licensing';

declare const __VERSION__: string;

figma.showUI(__html__, { width: 340, height: 480, themeColors: true, title: 'PSD Bridge' });

function post(msg: MainToUI) {
  figma.ui.postMessage(msg);
}

async function sendInit() {
  const [settings, fontMap] = await Promise.all([
    figma.clientStorage.getAsync(SETTINGS_KEY),
    figma.clientStorage.getAsync(FONT_MAP_KEY),
  ]);
  post({
    type: 'init',
    settings: normalizeSettings(settings),
    fontMap: (fontMap as FontMap | undefined) ?? {},
    version: __VERSION__,
    licensed: isLicensed(),
  });
}

figma.ui.onmessage = async (msg: UIToMain) => {
  try {
    switch (msg.type) {
      case 'ui-ready':
        await sendInit();
        break;
      case 'save-settings':
        await figma.clientStorage.setAsync(SETTINGS_KEY, normalizeSettings(msg.settings));
        break;
      case 'save-font-map':
        await figma.clientStorage.setAsync(FONT_MAP_KEY, msg.fontMap);
        break;
      case 'debug-tree':
        console.log(`[PSD Bridge] Parsed layer tree\n${formatTree(msg.doc)}`);
        break;
      case 'import-begin':
      case 'layers-batch':
      case 'import-end':
        // Node building lands in M2.
        post({ type: 'error', message: 'Import is not built yet (Milestone 2). The layer tree was logged to the console.' });
        break;
      case 'cancel':
        figma.closePlugin();
        break;
    }
  } catch (err) {
    console.error('[PSD Bridge]', err);
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
