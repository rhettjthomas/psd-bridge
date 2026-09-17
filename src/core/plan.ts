/**
 * Decides what the importer does with each IR layer, given the user's toggles.
 * Shared by the UI (to know which layers need pixels) and tests.
 */
import type { IRDocument, IRLayer, ReportItem } from './model';
import type { ImportSettings } from './settings';

/** Features switch on as their milestones land. */
export const FEATURES = {
  editableVectors: true, // M4
  editableText: true, // M5
};

/**
 * group:  a PSD group.
 * clip:   a synthetic group holding a clipping base and the layers clipped to it;
 *         the importer masks it with a copy of the base.
 * vector: a shape layer placed as an editable shape.
 * text:   a text layer placed as editable Figma text.
 * raster: a layer placed as an image.
 */
export type LayerAction = 'group' | 'clip' | 'vector' | 'text' | 'raster';

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
  let nextSyntheticId = doc.layers.length;

  const isSkippedHidden = (l: IRLayer, hiddenAncestor: boolean) =>
    !settings.importHidden && (hiddenAncestor || !l.visible);

  const walk = (ids: number[], parentId: number | null, hiddenAncestor: boolean) => {
    // Parent for layers clipped to the most recent base, or 'skip' if the base was dropped.
    let clipParent: number | null | 'skip' = null;

    ids.forEach((id, i) => {
      const l = doc.layers[id];

      if (l.clipped && clipParent !== null) {
        if (clipParent !== 'skip') emit(l, clipParent, hiddenAncestor);
        return;
      }
      if (l.clipped) {
        report.push({ level: 'approximated', layerName: l.name, reason: 'Clipping mask has no base layer; imported unclipped.' });
      }

      const next = doc.layers[ids[i + 1]];
      const hasClipped = !!next?.clipped;
      clipParent = null;
      if (!hasClipped) {
        emit(l, parentId, hiddenAncestor);
        return;
      }

      if (isSkippedHidden(l, hiddenAncestor) || !emittable(l)) {
        clipParent = 'skip';
        return;
      }
      // The clipping group takes the base's visibility, opacity, and blend mode.
      const clipId = nextSyntheticId++;
      layers.push({
        ...l,
        id: clipId,
        name: `${l.name} (clipping group)`,
        kind: 'group',
        action: 'clip',
        parentId,
        mask: undefined,
        vectorMask: undefined,
        shadows: [],
        image: undefined,
        text: undefined,
        // The clipping base's id, so the importer can confirm it was placed.
        children: [l.id],
      });
      clipParent = clipId;
      // A group used as a clipping base stays a group even when flattening: its union is the clip shape.
      emit({ ...l, visible: true, opacity: 1, blendMode: l.kind === 'group' ? 'PASS_THROUGH' : 'NORMAL' }, clipId, false, true);
    });
  };

  /** Layers that produce a node (a clipping base must be one of these). */
  const emittable = (l: IRLayer) =>
    l.kind === 'group' ||
    (l.kind === 'shape' && settings.editableVectors && !!l.shape && !l.shape.unsupported) ||
    (l.kind === 'text' && editableText(l)) ||
    (l.kind !== 'adjustment' && l.bounds.width > 0 && l.bounds.height > 0);

  const emit = (l: IRLayer, parentId: number | null, hiddenAncestor: boolean, keepGroup = false) => {
    const hidden = hiddenAncestor || !l.visible;
    if (hidden && !settings.importHidden) return;

    if (l.kind === 'group') {
      const mustKeep = keepGroup || !!l.mask || !!l.vectorMask || !!l.artboard;
      if (settings.flattenGroups && !mustKeep) {
        walk(l.children ?? [], parentId, hidden);
      } else {
        if (settings.flattenGroups) {
          report.push({ level: 'approximated', layerName: l.name, reason: 'Group kept while flattening because it is masked, an artboard, or a clipping base.' });
        }
        layers.push({ ...l, action: 'group', parentId });
        walk(l.children ?? [], l.id, hidden);
      }
      return;
    }

    // Adjustment layers are reported by the reader.
    if (l.kind === 'adjustment') return;

    if (l.kind === 'shape' && l.shape && settings.editableVectors && FEATURES.editableVectors && !l.shape.unsupported) {
      for (const w of l.shape.warnings) report.push({ level: 'approximated', layerName: l.name, reason: w });
      pushShadowReport(l);
      layers.push({ ...l, action: 'vector', parentId });
      return;
    }

    if (l.kind === 'text' && l.text && editableText(l)) {
      for (const w of l.text.warnings) report.push({ level: 'approximated', layerName: l.name, reason: w });
      pushShadowReport(l);
      layers.push({ ...l, action: 'text', parentId });
      return;
    }

    // Empty layers are reported by the reader when they're pixel layers.
    if (l.bounds.width <= 0 || l.bounds.height <= 0) {
      if (l.kind !== 'pixel') report.push({ level: 'skipped', layerName: l.name, reason: 'Layer has no pixels.' });
      return;
    }

    if (l.kind === 'shape') {
      const reason = !settings.editableVectors
        ? 'Shape imported as pixels ("Editable vectors" is off).'
        : `Shape imported as pixels: ${l.shape?.unsupported ?? 'unreadable shape data.'}`;
      report.push({ level: 'approximated', layerName: l.name, reason });
    }
    if (l.kind === 'text' && !settings.editableText) {
      report.push({ level: 'approximated', layerName: l.name, reason: 'Text imported as pixels ("Editable text" is off).' });
    }
    pushShadowReport(l);
    layers.push({ ...l, action: 'raster', parentId });
  };

  const editableText = (l: IRLayer) =>
    settings.editableText && FEATURES.editableText && !!l.text && !l.text.warped && !l.text.vertical && l.text.content.length > 0;

  const pushShadowReport = (l: IRLayer) => {
    if (l.shadows.length && !settings.rebuildShadows) {
      report.push({ level: 'skipped', layerName: l.name, reason: 'Shadows not rebuilt ("Rebuild shadows" is off).' });
    }
  };

  walk(doc.rootIds, null, false);
  return { layers, report };
}
