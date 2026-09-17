/**
 * Decides what the importer does with each IR layer, given the user's toggles.
 * Shared by the UI (to know which layers need pixels) and tests.
 */
import type { IRDocument, IRLayer, ReportItem } from './model';
import type { ImportSettings } from './settings';

/** Features switch on as their milestones land. */
export const FEATURES = {
  editableVectors: false, // M4
  editableText: false, // M5
};

export type LayerAction = 'group' | 'raster';

export interface PlannedLayer extends IRLayer {
  action: LayerAction;
  /** Effective parent after flattening/skipping; null = document frame. */
  parentId: number | null;
}

export interface ImportPlan {
  layers: PlannedLayer[];
  report: ReportItem[];
}

export function planImport(doc: IRDocument, settings: ImportSettings): ImportPlan {
  const layers: PlannedLayer[] = [];
  const report: ReportItem[] = [];

  const walk = (ids: number[], parentId: number | null, hiddenAncestor: boolean) => {
    for (const id of ids) {
      const l = doc.layers[id];
      const hidden = hiddenAncestor || !l.visible;
      if (hidden && !settings.importHidden) continue;

      if (l.kind === 'group') {
        if (settings.flattenGroups) {
          walk(l.children ?? [], parentId, hidden);
        } else {
          layers.push({ ...l, action: 'group', parentId });
          walk(l.children ?? [], l.id, hidden);
        }
        continue;
      }

      // Adjustment layers are reported by the reader.
      if (l.kind === 'adjustment') continue;
      // Empty layers are reported by the reader when they're pixel layers.
      if (l.bounds.width <= 0 || l.bounds.height <= 0) {
        if (l.kind !== 'pixel') report.push({ level: 'skipped', layerName: l.name, reason: 'Layer has no pixels.' });
        continue;
      }

      if (l.kind === 'shape' && !(settings.editableVectors && FEATURES.editableVectors)) {
        report.push({
          level: 'approximated',
          layerName: l.name,
          reason: settings.editableVectors
            ? 'Shape imported as pixels (editable vectors arrive in Milestone 4).'
            : 'Shape imported as pixels ("Editable vectors" is off).',
        });
      }
      if (l.kind === 'text' && !l.text?.warped && !(settings.editableText && FEATURES.editableText)) {
        report.push({
          level: 'approximated',
          layerName: l.name,
          reason: settings.editableText
            ? 'Text imported as pixels (editable text arrives in Milestone 5).'
            : 'Text imported as pixels ("Editable text" is off).',
        });
      }
      layers.push({ ...l, action: 'raster', parentId });
    }
  };

  walk(doc.rootIds, null, false);
  return { layers, report };
}
