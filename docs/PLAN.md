# PSD Bridge — Build Plan

This plan comes from *PSD Bridge — Figma Plugin Build Brief* (2026-09-17). Work one
milestone at a time and commit after each one. Test each milestone against a real
sermon series PSD before moving on. Mapping logic lives in `src/core/`.

## Decisions made

| Question | Decision |
| --- | --- |
| Plugin name | PSD Bridge |
| Build tool | Claude Code |
| Bundler | esbuild. `scripts/build.mjs` inlines the UI bundle into `dist/ui.html` |
| Test runner | Vitest, for the pure logic in `src/core/` |
| Accent color | Reference lime (`--accent` in `src/ui/ui.css`, one token) |
| Smart objects | Imported as a single composite image in place, and reported |
| Node | v24 LTS, installed locally at `~/.local/node` |

**Still open** (none of these block Milestones 1–4):

- Typical PSD size and resolution. This sets the batch size and memory limits.
  The starting assumptions are a 4096 px image cap and 20 layers per batch.
- Which fonts appear most often, and which of those are Adobe Fonts. Needed for Milestone 5.
- Figma plan. This decides whether a private org publish is possible.
- For the paid release: do teammates buy their own copy or use an org install?

## Layout

```
manifest.json            Community-ready: dynamic-page, no network, editorType figma
scripts/build.mjs        esbuild → dist/code.js + dist/ui.html (JS and CSS inlined)
scripts/inspect-psd.mjs  CLI: print a PSD's layer tree as the plugin sees it
scripts/make-fixture.mjs CLI: write test/fixtures/sample.psd
src/code.ts              Main thread: settings, message router, (M2+) node builders
src/licensing.ts         The only code that touches figma.payments (stubbed to "paid")
src/core/model.ts        Intermediate layer model (IR): format-neutral
src/core/psd-reader.ts   ag-psd Psd → IR (runs in the UI iframe)
src/core/blend.ts        PSD → Figma blend mode map
src/core/units.ts        Shadow offsets, tracking, opacity, downscale math
src/core/fonts.ts        PostScript name parsing + font matching
src/core/messages.ts     Typed postMessage protocol (UI ⇄ main)
src/core/settings.ts     Toggle defaults
src/core/plan.ts         Per-layer import action, based on the toggles
src/main/importer.ts     Builds frames, groups, and image fills (main thread)
src/ui/encode.ts         Pixel data → PNG, with downscaling
src/ui/ui.html|css|ts    Plugin window; runs ag-psd with the browser canvas
test/                    Vitest specs (core, planner, importer via a Figma API mock)
```

## Data flow

1. **UI:** the user picks a `.psd` file. A structure-only parse builds the preflight report. On Import, the PSD is re-read with `useRawData`, so pixels stay compressed until each layer is needed.
2. **UI:** `psd-reader` walks the tree, top to bottom, and builds the IR. Each pixel
   layer is decoded on its own (`getLayerImageData`) and encoded to PNG bytes with `OffscreenCanvas`,
   and its raw data is then freed. A layer larger than 4096 px is downscaled and reported.
3. **UI → main:** `import-begin` (doc info and options), then `layers-batch` messages
   (a flat list with parent ids, in batches), then `import-end`. The bytes are sent as
   transferables, never as base64.
4. **Main:** loads every font once up front, then builds the nodes. Children are added in
   PSD bottom-to-top order, so Figma's stacking order matches Photoshop.
5. **Main → UI:** `progress` ("Placing layer 14 of 62"), then `report`.

## Milestones

### M1 — Scaffold ✅
- Manifest, build, and typecheck work. The plugin loads in Figma desktop, and the UI opens.
- Picking a PSD parses it. The UI shows the file name, dimensions, and layer count. The layer
  tree (IR) is logged in the UI console and in the main-thread console.
- CMYK and 16-bit files are flagged.
- Toggles are saved with `clientStorage`. The licensing stub is in place.
- Core unit tests pass. `npm run inspect <file.psd>` prints the tree.
- **Done when:** the Figma desktop plugin runs and logs the tree of a real sermon PSD.

### M2 — Pixel layers ✅ (built; needs a check in Figma with a real PSD)
Built: re-reads the PSD with `useRawData` and decodes one layer at a time. Encodes PNGs in
the UI and sends batches of 20 layers or 48 MB, whichever comes first, waiting for the main
thread to confirm each batch. Groups start as placeholder frames and become real Figma groups at
the end (this pulls group structure, visibility, blend modes, and the flatten and hidden toggles
forward from M3). The report panel lists every item by layer name.
Until M4 and M5 land, shapes and text import as pixels, and the report lists them.
- PNG encoding in the UI, batched transfer, `figma.createImage`, and a rectangle with an image fill.
- A document frame named after the file, with each layer at its left/top offset.
- Opacity is layer opacity × fill opacity. Stacking order matches Photoshop.
- Empty layers are skipped. Layers over 4096 px are downscaled and reported.
- Smart objects are imported as a composite image and reported.
- **Done when:** the overlay test shows no shift, and order and opacity are correct.

### M3 — Structure and blending
- Groups keep their names, order, visibility, and opacity. A group with a mask becomes a frame.
- The "Flatten groups" toggle works.
- Blend map: pass-through groups; unmapped modes fall back to Normal and are reported.
- Hidden layers import hidden, and the "Import hidden layers" toggle works.
- Layer mask: luminance mask image in a group. Vector mask: editable vector mask in a group.
- Clipping mask: base layer and its clipped layers go in a group, with the base as the mask.
- Drop and inner shadows become Figma effects ("Rebuild shadows" toggle). Other styles and
  adjustment layers are reported.
- **Done when:** the result matches Photoshop side by side.

### M4 — Vector shapes
- Each `vectorMask` subpath becomes a bezier `VectorPath`, with its fill rule kept.
  The transform is applied to the points once; the node is not moved again.
- Live rectangles and ellipses (`vectorOrigination`) become native shapes with corner radii.
- Solid and gradient fills. Strokes keep width, alignment, and dashes.
- Pattern fills become tiled image fills.
- The "Editable vectors" toggle works; when it is off, shapes import as pixels.
- **Done when:** the outline, fill, and stroke match Photoshop.

### M5 — Text and font matching
- Match PostScript names to `listAvailableFontsAsync` by family and style, then by saved
  matches. Anything still unmatched goes to the font matching window.
- The matching window: missing fonts with their styles and layers, a replacement picker with a
  live preview, Remember, Rescan, Skip, and JSON export/import of the font map.
- Text nodes: size × transform scale, tracking ÷ 10 → %, auto or fixed leading, point text
  as auto-width and box text as fixed-width, alignment, and style runs.
- Warped text and text on a path import as pixels and are reported.
- **Done when:** text lands within 2 px of its position, and saved matches reapply.

### M6 — Polish
- Reference-style UI, progress bar, report panel with layer names, and settings menu.
- Light and dark themes, clear error messages, and no crash on a bad file.
- A README section on installing on a second machine (target: under 10 minutes).

## Acceptance test (v1)
- [ ] A prepped sermon series PSD imports with no errors
- [ ] The overlay test shows no shift in pixel layers
- [ ] Shape layers are editable vectors, or are reported with a reason
- [ ] Text layers are editable, or are reported with a reason
- [ ] Texture layers keep their blend modes, and hidden source layers stay hidden
- [ ] A missing Adobe font imports after one pass through the matching window
- [ ] The plugin installs on a second machine in under 10 minutes
- [ ] Cleanup takes under 5 minutes

## Before publishing
- Create the plugin record in Figma desktop (Plugins → Development → New plugin), copy
  its ID into `manifest.json` → `id`, and never change it after that. The current ID is a
  development placeholder.
- Check Figma's current seller requirements, then switch `src/licensing.ts` from the stub
  to `figma.payments`.

v2 (the export bridge) does not start until v1 passes the acceptance test.
