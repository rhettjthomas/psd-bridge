# PSD Bridge v2 — Export Bridge (Figma → PSD and AI)

Research pass for the v2 scope in the build brief: export a selected Figma frame to PSD and to
AI, "a true bridge between Photoshop, Illustrator, and Figma, in the spirit of Overlord".

Written 2026-09-17, after v1 shipped. Sources are listed at the end.

> **Parked 2026-09-21.** The plugin ships as an importer only. Re-importing an updated PSD is
> simpler than round-tripping a file between two apps, and export would double the surface to
> keep correct for a case that hasn't come up. The research below stands, the spikes are
> answered, and `src/main/figma-reader.ts` (Figma → layer model, with tests) is in the repo, so
> picking this up later is a build, not an investigation.

## What the research found

### 1. PSD export is a solved problem, with one catch

`ag-psd` (already in the project for reading) writes PSDs: layers with pixels, groups, opacity,
blend modes, visibility, layer masks, vector masks and fills, text layers, and layer effects
such as drop and inner shadows.

The catch, stated plainly in its README: **the library never renders anything itself.** It does
not generate a composite image from the layers, and it does not generate a layer's bitmap from
the layer's vector or text data. So the exporter has to supply rendered pixels for every layer,
which Figma can do (`exportAsync` per node), and can skip the composite image (a PSD opens fine
without one; only Bridge and Explorer previews need the thumbnail).

Known limits when writing (from the README):
- **RGB, 8-bit only.** No CMYK and no 16-bit, which matches v1's import rules.
- **No PSB.** Files over Photoshop's 2 GB / 30,000 px limits can't be written.
- **Text layers:** Photoshop shows an "update text layers" prompt when opening a file whose text
  layers have no rendered pixels. Writing with `invalidateTextLayers: true` makes Photoshop
  redraw them; the user clicks **Update**. Vertical text can produce a broken file, so it is
  rasterized instead.
- **Patterns:** only uncompressed RGB/grayscale pattern blocks; Photoshop's own files usually use
  zip-compressed patterns. Pattern fills export as flat pixels.
- **Smart objects:** more promising than expected. ag-psd has *write* paths for both the modern
  smart-object record (`SoLd`) and embedded linked files (`lnk2`/`liFD`), so a smart object should
  be writable as a linked file (the image bytes, with a GUID id) plus a placed layer that points
  at it and carries a transform. Unproven in Photoshop; see spike S4.

**Verified (S2/S4, 2026-09-17, Rhett in Photoshop):** shape layers arrive as real, editable
Shape layers, both with and without supplied pixels. Smart objects work: an embedded linked file
opens and re-renders. Text layers trigger the expected "update text layers" prompt and then open
fine.

One catch from S2: Photoshop draws the **path**, not the live-shape radii. The test shape carried
`keyOriginRRectRadii` but a square path, and it came in square until the radius was nudged in the
Properties panel. So the exporter writes the true rounded path *and* the live-shape metadata.
Figma's `fillGeometry` already contains rounded corners, so this falls out of the normal path.

### 2. There is no way to write a real .ai file

- A modern `.ai` file is a PDF container with Illustrator's own private data (PGF) inside it.
  The editable structure lives in that private data, not in the PDF.
- No open-source library writes it. The only supported way to produce `.ai` is Illustrator
  itself, through ExtendScript or (someday) UXP.
- **PDF is a dead end for layers.** Illustrator only reads its own layer data when opening a PDF.
  A PDF's optional content groups (what Acrobat calls layers) are flattened on open.
- **SVG is the practical route.** Figma exports SVG with editable `<text>` elements
  (`svgOutlineText: false`), layer names as `id` attributes (`svgIdAttribute: true`), real vector
  paths, and embedded images. Illustrator opens that with the artwork and text editable. The one
  gap: SVG groups arrive as *groups*, not Illustrator *layers*.
- **Closing the gap:** a small ExtendScript (`.jsx`) that the user runs once in Illustrator
  (File → Scripts → Other Script…). It opens the SVG, turns the top-level groups into named
  layers, and saves a real `.ai` file. ExtendScript still ships in Illustrator 2026; UXP for
  Illustrator is still internal to Adobe with no public API.

So the honest promise for v2 is: **"Export to Illustrator" produces an SVG plus a one-click
converter script that turns it into a layered .ai.** That is as close to a true AI export as
anything outside Illustrator can get.

### 3. Reading a frame out of Figma

Everything the intermediate model needs is available in the plugin API:

| Need | API |
| --- | --- |
| Geometry of any shape (rect, ellipse, star, boolean, vector) | `node.fillGeometry` / `node.strokeGeometry` (paths in node space) |
| Position, rotation, scale | `node.absoluteTransform`, `absoluteBoundingBox` |
| Rendered pixels per layer | `node.exportAsync({ format: 'PNG' })` |
| Original image bytes | `figma.getImageByHash(hash).getBytesAsync()` |
| Text runs | `node.getStyledTextSegments([...])` |
| Fills, strokes, effects, blend, opacity, masks, radii | node properties, as in v1's import |
| SVG for the Illustrator path | `frame.exportAsync({ format: 'SVG_STRING', svgOutlineText: false, svgIdAttribute: true })` |

### 4. Saving a file works (spike S1, answered 2026-09-17)

Everything above assumes the plugin window can hand the user a file. **It can:** Download in
v1's Font map window produced a `.json` file in Figma desktop. So v1's original problem was only
the hidden status message, which is fixed, and `<a download>` from the plugin iframe is a sound
way to deliver an exported PSD or SVG.

## Architecture

v2 reuses the v1 core. The intermediate layer model is already format-neutral, which is what it
was designed for.

```
Figma nodes ──(main thread)──> IR ──(UI iframe)──> PSD bytes ──> file
                                 └────────────────> SVG + .jsx ──> file
```

| New file | Room | Job |
| --- | --- | --- |
| `src/main/figma-reader.ts` | Main thread | Figma nodes → IR; export each layer's pixels |
| `src/ui/psd-writer.ts` | UI iframe | IR → PSD with `writePsd` (needs a canvas, so it runs here) |
| `src/ui/save-file.ts` | UI iframe | Hands the finished file to the user |
| `src/ui/ai-export.ts` | UI iframe | SVG plus the Illustrator converter script |
| `scripts/illustrator/svg-to-ai.jsx` | Shipped asset | Groups → layers, save as .ai |
| `src/core/figma-map.ts` | Shared | Reverse maps: blend modes, fonts, paints |

Existing core modules (`model`, `blend`, `paint`, `paths`, `units`, `fonts`) gain the reverse
direction of the mappings they already own, so import and export can't drift apart.

## Milestones

### V2-M0 — Spikes (do these before writing the exporter)
- ✅ **S1 — Can we save a file?** Yes. Downloading from the plugin window works in Figma desktop
  (confirmed with v1's Font map → Download).
- ✅ **S2 — Does Photoshop accept our layers?** Yes: shapes are editable Shape layers, masks and
  groups work, text opens after the "Update" prompt. Radii must be baked into the path.
  `scripts/spikes/write-test-psd.mjs` writes
  `spike-a-layers.psd` (a pixel layer, a group, a shape with vector data only, a shape with
  vector data *and* pixels, a text layer, a layer mask, and a drop shadow).
- **S3 — Does the Illustrator route work?** Export a real frame as SVG from Figma (with
  "Include “id” attribute" on and "Outline text" off), open it in Illustrator, run
  `scripts/illustrator/svg-to-ai.jsx`, and confirm: layers named, text editable, vectors
  editable, images intact, and a saved `.ai`.
- ✅ **S4 — Can we write a smart object?** Yes, confirmed in Photoshop. "Images as smart objects"
  becomes a real export option in M3. (`spike-b-smart.psd` embeds a PNG as a linked file with a
  placed layer pointing at it.)
- **Done when:** all four questions are answered in writing, and the plan is adjusted to match.

### V2-M1 — Export tab and the Figma reader ✅ (built; needs a check in Figma)
- The **Export** tab is live: it lists the selected frame first, then the page's top-level
  frames, updates as the canvas selection changes, and shows size and layer count.
- `src/main/figma-reader.ts` walks a frame into the layer model: groups, visibility, opacity,
  blend modes, geometry (`fillGeometry`, with corner radii and smoothing already baked in),
  text runs, and drop/inner shadows. Everything is measured from the frame's top-left corner.
- Figma masks become "clipped" layers, which is how Photoshop expresses the same thing.
- Reported: layer types Photoshop has no equivalent for (blurs, and so on), non-alpha masks,
  pixel letter spacing, and vertical text alignment.
- **Done when:** selecting a frame prints a layer tree that matches Figma's layers panel.

### V2-M2 — PSD export, raster path
- Every layer exports as a pixel layer at its position, inside groups, with opacity, blend mode,
  and visibility. This path is always available and always accurate.
- Options: **Rasterize everything** (on for now), image size and memory guards, progress, report.
- **Done when:** a frame exported from Figma opens in Photoshop with the layer tree intact, and
  the overlay test against a Figma PNG export shows no visible shift.

### V2-M3 — PSD export, editable path
- **Text layers:** IR text → PSD text (font PostScript names via the reverse of v1's font map),
  with the "Update" prompt documented.
- **Shape layers:** IR geometry → PSD vector masks and fills, pending spike S2.
- **Masks and clipping:** Figma masks → PSD layer masks or clipping groups.
- **Effects:** drop and inner shadows → PSD layer effects.
- Options: **Rasterize on export**, **Ignore corner smoothing**, and **Images as smart objects**
  (real: spike S4 passed).
- Corner radii are written as path geometry, not just live-shape metadata (spike S2).
- **Done when:** text and shapes are editable in Photoshop, or the report says why not.

### V2-M4 — Illustrator export
- SVG export with editable text, layer-name ids, and embedded images.
- The converter script is offered alongside the file, with instructions in the window and README.
- **Done when:** the SVG opens in Illustrator, and after running the script the file has named
  layers, editable text, and editable vectors.

### V2-M5 — Polish and acceptance
- Report, cancel, progress, saved options, docs, and a round-trip test: PSD → Figma → PSD.

## Acceptance test (v2)
- [ ] A sermon series frame exports to PSD and opens in Photoshop with no errors
- [ ] The layer tree in Photoshop matches the Figma layers panel
- [ ] An overlay of the Photoshop file against a Figma PNG export shows no visible shift
- [ ] Text layers are editable in Photoshop, or are listed in the report with a reason
- [ ] Shape layers are editable in Photoshop, or are listed in the report with a reason
- [ ] The same frame exports to SVG, and after the converter script it is a layered .ai with
      editable text and vectors
- [ ] A PSD imported by v1 and exported again still matches the original
- [ ] Images export as smart objects that open and re-render in Photoshop

## Decisions made (2026-09-17)
1. **The AI route:** SVG plus an Illustrator converter script.
2. **Order:** PSD export first, Illustrator export second.
3. **Smart objects:** worth a spike (S4) rather than writing them off.

## Sources
- [ag-psd README — limitations and writing text layers](https://github.com/Agamnentzar/ag-psd/blob/master/README.md)
- [Figma plugin API — ExportSettings](https://developers.figma.com/docs/plugins/api/ExportSettings/)
- [Adobe — Work with SVG format in Illustrator](https://helpx.adobe.com/be_en/illustrator/using/svg.html)
- [Adobe — Release objects to separate layers](https://helpx.adobe.com/illustrator/desktop/manage-layers/create-and-organize-layers/release-objects-to-separate-layers.html)
- [Adobe — Install and run scripts in Illustrator](https://helpx.adobe.com/illustrator/desktop/automate-visualize-data/automate-actions/install-and-run-scripts.html)
- [Adobe community — Illustrator flattens PDF layers on open](https://community.adobe.com/t5/illustrator-discussions/illustrator-flattens-existing-layers-when-opened-pdf/m-p/14845717)
- [Adobe forum — SVG groups are not Illustrator layers](https://community.adobe.com/questions-652/how-to-create-g-elements-in-svg-that-are-recognized-as-layers-in-illustrator-817756)
- [Mapsoft — UXP for Illustrator status in 2026](https://mapsoft.com/posts/illustrator-uxp-status.html)
