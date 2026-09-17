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
src/core/plan.ts         Per-layer import action, based on the toggles; clipping groups
src/core/paths.ts        Photoshop bezier paths → Figma vector path data
src/core/shapes.ts       Shape layers → native rect/ellipse or path, with fill and stroke
src/core/paint.ts        Solid/gradient/pattern paints, stop merging, gradient transform
src/core/color.ts        ag-psd colors → RGBA
src/main/paints.ts       Paints and strokes applied to Figma nodes
src/main/text.ts         Font loading and editable text nodes (with glyph-bounds alignment)
src/ui/fonts-panel.ts    The font matching window
src/ui/combobox.ts       Searchable, themed dropdown (font families)
src/ui/fontmap-sheet.ts  Font map window (view, copy, paste, save)
docs/PSD-PREP.md         Prep guide linked from the import report
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

### M2 — Pixel layers ✅
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

### M3 — Structure and blending ✅
How it's built:
- **Layer mask:** the layer becomes a group of [luminance mask image, content]. When a mask's
  default color is white, the mask image is extended to cover the layer (or, for a group,
  the whole canvas).
- **Vector mask:** an editable vector with `isMask` and `maskType: VECTOR`. Subtracted
  subpaths merge with even-odd winding; intersections are reported. The vector's position is
  checked by reading its path data back from Figma.
- **Masked groups:** stay Figma groups, with the mask as the bottom child (instead of the
  frame the brief suggests); they are kept even when flattening.
- **Clipping mask:** a "(clipping group)" containing an alpha-mask copy of the base, the base,
  and the clipped layers. The group takes the base's visibility, opacity, and blend mode.
  Groups used as a base are kept when flattening.
- **Shadows:** set as effects on the outermost node for the layer.
- **Reported:** mask feather and density, disabled masks, and clipped layers with no base.

From the brief:
- Groups keep their names, order, visibility, and opacity. A group with a mask becomes a frame.
- The "Flatten groups" toggle works.
- Blend map: pass-through groups; unmapped modes fall back to Normal and are reported.
- Hidden layers import hidden, and the "Import hidden layers" toggle works.
- Layer mask: luminance mask image in a group. Vector mask: editable vector mask in a group.
- Clipping mask: base layer and its clipped layers go in a group, with the base as the mask.
- Drop and inner shadows become Figma effects ("Rebuild shadows" toggle). Other styles and
  adjustment layers are reported.
- **Done when:** the result matches Photoshop side by side.

### M4 — Vector shapes ✅
How it's built:
- **Native shapes:** a single, unrotated live rectangle, rounded rectangle, or ellipse
  (`vectorOrigination`) becomes a native Figma shape. Corner radii are scaled by the shape's
  transform; a non-uniform scale falls back to a path.
- **Paths:** everything else becomes a vector via `placeVectorPaths`, the same function vector
  masks use.
- **Fill layers:** a solid, gradient, or pattern fill layer with no vector mask becomes a
  rectangle the size of the canvas.
- **Gradients:** Photoshop keeps color and opacity stops separately; they are merged. The
  gradient runs through the center of the shape's box at its angle, scale, and offset
  (`gradientTransform`). Reflected gradients become mirrored linear ones; angle and diamond map
  to Figma's angular and diamond. Uneven midpoints are reported.
- **Patterns:** tiled image fills at 100% (Photoshop's pattern scale isn't in the parsed data),
  reported. A missing pattern falls back to pixels.
- **Strokes:** width, alignment (centered on open paths), cap, join, and dashes (dash lengths
  are multiples of the stroke width).
- **Imported as pixels and reported:** noise gradients, pattern strokes, and shapes with no
  drawable path.

From the brief:
- Each `vectorMask` subpath becomes a bezier `VectorPath`, with its fill rule kept.
  The transform is applied to the points once; the node is not moved again.
- Live rectangles and ellipses (`vectorOrigination`) become native shapes with corner radii.
- Solid and gradient fills. Strokes keep width, alignment, and dashes.
- Pattern fills become tiled image fills.
- The "Editable vectors" toggle works; when it is off, shapes import as pixels.
- **Done when:** the outline, fill, and stroke match Photoshop.

### M5 — Text and font matching ✅
How it's built:
- **Matching:** on file load, the UI collects every PostScript font the text layers use and
  asks the main thread to match them. The main thread matches by family and style, drops
  common suffixes (MT, PSMT, Std, Pro), then tries saved matches. Any missing font opens the
  matching window, and Import is blocked until each missing font has a replacement or is
  skipped.
- **Matching window:** a family field that searches installed families, a style list, a live
  preview of the layer's text, Remember this match, Skip, Rescan fonts (re-reads Figma's font
  list), and a link to the Font map window (see M6). Guesses pre-fill abbreviated family names.
- **Font loading:** the main thread handles messages in order and loads every chosen font once,
  in `import-begin`, before any layers arrive. Fonts that fail to load, and skipped fonts, use
  Inter Regular and are reported.
- **Text nodes:** runs set font, size (× transform scale), fill, tracking (÷ 10 → %), fixed or
  auto leading, underline or strikethrough, and all caps or small caps. Point text is
  auto-width; box text is fixed-width at the box's width.
- **Position:** the node starts from the text transform, then its rendered glyph bounds
  (`absoluteRenderBounds`) are aligned to the PSD layer's pixel bounds. Point text aligns by
  its anchor edge; box text aligns vertically only. Rotated text is placed and rotated from
  the transform.
- **Imported as pixels and reported:** warped, on-path, and vertical text.
- **Reported:** faux bold or italic, character scaling, baseline shift,
  superscript/subscript, text stroke, mixed paragraph alignment, and uneven scaling.

From the brief:
- Match PostScript names to `listAvailableFontsAsync` by family and style, then by saved
  matches. Anything still unmatched goes to the font matching window.
- The matching window: missing fonts with their styles and layers, a replacement picker with a
  live preview, Remember, Rescan, Skip, and JSON export/import of the font map.
- Text nodes: size × transform scale, tracking ÷ 10 → %, auto or fixed leading, point text
  as auto-width and box text as fixed-width, alignment, and style runs.
- Warped text and text on a path import as pixels and are reported.
- **Done when:** text lands within 2 px of its position, and saved matches reapply.

### Artboards (added after M5 testing)
- An artboard group becomes a clipped Figma frame at the artboard's position, filled with its
  background (white, black, transparent, or a custom color). Its children are placed relative
  to the artboard.
- A PSD that contains one artboard and nothing else is merged into the import frame, so there
  is no frame-in-frame.
- Artboards are kept when flattening groups.

### M6 — Polish ✅ (built; needs a check in Figma)
How it's built:
- **Settings menu (gear):** reset import options; a Font map window; clear saved font
  matches; version.
- **Font map window:** the map appears as editable JSON with Copy, Download, Load file, and
  Save. Figma's iframe can block the clipboard and downloads, so the selected text (⌘C) and
  paste-and-Save always work.
- **Messages:** shown in the footer so they're always visible.
- **Report:** a layer name that maps to a placed node is a button that selects and zooms to it,
  switching pages if needed. The report also has Copy (plain text), the import time, and a
  "PSD prep tips" link that opens `docs/PSD-PREP.md` via `figma.openExternal`. Short lists
  open automatically after an import.
- **Cancel import:** stops between layers and removes the partial frame.
- **Progress:** "Importing layer N of M", plus "Loading fonts…" from the main thread.
- **File support:** `.psb` files are accepted (ag-psd reads them); the upload icon shows in
  the empty drop zone.
- **Themes and errors:** light and dark themes use Figma's variables, including the menus.
  Error messages say what happened and what to do next. A failed or canceled import
  leaves the file untouched.
- **Docs:** README install (about 10 minutes), usage, troubleshooting, and publishing notes;
  `docs/PSD-PREP.md`.
- **Version:** 0.9.0 (release candidate until the acceptance test passes).

From the brief:
- Reference-style UI, progress bar, report panel with layer names, and settings menu.
- Light and dark themes, clear error messages, and no crash on a bad file.
- A README section on installing on a second machine (target: under 10 minutes).

## Acceptance test (v1)
✅ = confirmed by Rhett in Figma during milestone checks; ⬜ = still to confirm.
- ✅ A prepped sermon series PSD imports with no errors (M2–M5 checks)
- ✅ The overlay test shows no shift in pixel layers (M2 check)
- ✅ Shape layers are editable vectors, or are reported with a reason (M4 check)
- ✅ Text layers are editable, or are reported with a reason (M5 check)
- ✅ Texture layers keep their blend modes, and hidden source layers stay hidden (M3 check)
- ✅ A missing font imports after one pass through the matching window (M5 check). ⬜ Still
  to confirm with a real Adobe Fonts font.
- ⬜ The plugin installs on a second machine in under 10 minutes (README → Install)
- ✅ Real plugin ID set (`1682467824285455363`)
- ⬜ Cleanup takes under 5 minutes, on a full sermon series PSD

**Unverified in Figma so far:** the Font map window's Copy and Download buttons (⌘C and
paste-and-Save are the reliable path), select-from-report across pages, and a real `.psb` file.

## Before publishing
- ✅ Plugin ID `1682467824285455363` is in `manifest.json`. Never change it.
- Check Figma's current seller requirements, then switch `src/licensing.ts` from the stub
  to `figma.payments`.

v2 (the export bridge) does not start until v1 passes the acceptance test.
