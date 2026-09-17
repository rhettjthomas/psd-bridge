# PSD Bridge v2 — Export Bridge (Figma → PSD and AI)

Research pass for the v2 scope in the build brief: export a selected Figma frame to PSD and to
AI, "a true bridge between Photoshop, Illustrator, and Figma, in the spirit of Overlord".

Written 2026-09-17, after v1 shipped. Sources are listed at the end.

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

**Unverified:** whether Photoshop opens ag-psd's *shape* layers as real, editable shape layers.
Writing them round-trips through ag-psd (v1's test fixture does exactly this), but a round trip
isn't proof that Photoshop accepts them. Spike S2 settles it.

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

### 4. The open risk: can the plugin save a file at all?

Everything above assumes the plugin window can hand the user a file. v1 already hit this:
**Export font map** appeared to do nothing in Figma, and in a sandboxed test frame downloads
were blocked silently. Plenty of Figma export plugins do download files this way, so Figma
itself may allow it and v1's problem may have been only the hidden status message. This has to
be settled before building an exporter, because a PSD can't be pasted as text the way a font map
can. See spike S1.

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
- **S1 — Can we save a file?** Add a tiny "Export test" that writes a small PSD and offers it as
  a download inside real Figma. If downloads are blocked, find the workaround other export
  plugins use before going further. *Blocking.*
- **S2 — Does Photoshop accept our layers?** Write a PSD by hand with a pixel layer, a group, a
  shape layer, a text layer, a layer mask, and a drop shadow. Open it in Photoshop and check
  which parts are truly editable. *Blocking for the editable path; the raster path is unaffected.*
- **S3 — Does the Illustrator route work?** Export a real frame as SVG from Figma, open it in
  Illustrator, run a draft `.jsx`, and confirm the result: layers named, text editable, vectors
  editable, images intact.
- **S4 — Can we write a smart object?** Write a PSD with a linked file (`lnk2`) and a placed
  layer (`SoLd`) that points at it, then open it in Photoshop: does it arrive as a real smart
  object whose contents open and re-render? If yes, "Images as smart objects" becomes a real
  option in M3; if no, images stay pixel layers and the report says so. *Not blocking.*
- **Done when:** all four questions are answered in writing, and the plan is adjusted to match.

### V2-M1 — Export tab and the Figma reader
- The disabled **Export** tab becomes real: pick the selected frame (or choose from a list),
  show its name and size, options, and one action button.
- `figma-reader` walks the frame into IR: groups, visibility, opacity, blend modes, masks,
  geometry, text, effects, and images.
- **Done when:** selecting a frame prints an IR tree that matches Figma's layers panel.

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
  (real if spike S4 passes, otherwise reported as unsupported).
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
- [ ] If spike S4 passes: images export as smart objects that open and re-render in Photoshop

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
