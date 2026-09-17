# psd-bridge
PSD Bridge is a Figma plugin that imports a prepped PSD ("Photoshop Document") into Figma as a layered, editable frame, with real Figma text wherever possible.

- **Pixel layers:** placed at their exact positions, with opacity, blend modes, and visibility
  (hidden layers stay hidden).
- **Groups, masks, and artboards:** groups, layer masks, vector masks, and clipping masks
  become their Figma equivalents; artboards become frames with their background color.
- **Shapes:** become editable Figma vectors, or native rectangles and ellipses, with fills,
  gradients, and strokes.
- **Text:** becomes editable Figma text. Missing fonts go through a font matching window
  first, and your matches are remembered.
- **Shadows:** drop and inner shadows become Figma effects.
- **Report:** anything skipped or approximated is listed, and each entry selects its layer.

See [docs/PSD-PREP.md](docs/PSD-PREP.md) for how to prep a PSD, and [docs/PLAN.md](docs/PLAN.md)
for the build plan and status.

## Install on a machine (development plugin)

Allow about 10 minutes. You need macOS or Windows, the **Figma desktop app**, and **Node.js 20
or newer** ([nodejs.org](https://nodejs.org), LTS installer).

1. Get the code and build it:
   ```bash
   git clone https://github.com/rhettjthomas/psd-bridge.git
   cd psd-bridge
   npm install
   npm run build
   ```
2. In Figma desktop, open any design file, then choose
   **Plugins → Development → Import plugin from manifest…** and select `psd-bridge/manifest.json`.
3. Run it from **Plugins → Development → PSD Bridge**.

Development plugins work with any Figma account that has these files. After pulling updates,
run `npm run build` again and reopen the plugin; there's no need to import the manifest again.

**Moving your font matches:** in the plugin, choose *Settings (gear) → Font map*, then click
**Copy** (or select the text and press ⌘C). On the other machine, open the same window, paste,
and click **Save**. Saved matches belong to this plugin ID on each machine.

## Using it

1. Prep the PSD (see the [prep guide](docs/PSD-PREP.md)) and save it.
2. Open PSD Bridge, then choose or drop the `.psd` (or `.psb`) file. The file's size and layer count
   appear, along with a **Preflight** list of anything that will be approximated or skipped.
3. If fonts are missing, pick replacements in **Font matching**. Check *Remember this match*
   to reuse them next time.
4. Adjust the options if needed:

   | Option | Default | Effect |
   | --- | --- | --- |
   | Editable text | On | Text layers become Figma text (off: pixels) |
   | Editable vectors | On | Shape layers become Figma vectors (off: pixels) |
   | Import hidden layers | On | Hidden layers come along, still hidden |
   | Rebuild shadows | On | Drop and inner shadows become Figma effects |
   | Flatten groups | Off | Places all layers directly in the frame; masked groups and artboards are kept |

5. Click **Import to Figma**. You can cancel partway through, and a canceled import adds
   nothing to the file.
6. Review the **Import report**. Click a layer to select it; *Copy* copies the report.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "isn't a valid Photoshop document" | Re-save the file from Photoshop as `.psd` or `.psb`. |
| "too large to load" | Close other plugins, delete unused layers, or split the file. |
| A font keeps showing as missing | Install or activate a desktop copy of the font, then click **Rescan fonts**. For Adobe Fonts, pick a replacement and choose *Remember*. |
| Font map Copy or Download does nothing | Figma can block the clipboard and downloads. In *Settings → Font map*, the text is already selected, so press ⌘C. |
| Colors look off | Convert the PSD to 8-bit RGB before importing. |
| Plugin didn't pick up code changes | Run `npm run build`, then close and reopen the plugin. |

To see debug output, open *Plugins → Development → Show/Hide console*; the parsed layer tree is
logged there.

## Development

| Command | What it does |
| --- | --- |
| `npm run watch` | Rebuilds `dist/` on save. Reopen the plugin in Figma to pick up changes |
| `npm run build` | Production build |
| `npm test` | Unit tests: the core mapping, and the importer run against a Figma API mock |
| `npm run typecheck` | TypeScript check |
| `npm run inspect -- file.psd` | Prints a PSD's layer tree and preflight report in the terminal |
| `npm run fixture` | Regenerates `test/fixtures/sample.psd` |

**Architecture:**
- **UI iframe** (`src/ui/`): parses the PSD with
  [ag-psd](https://github.com/Agamnentzar/ag-psd), converts it to a neutral layer model
  (`src/core/`), and encodes each layer's pixels as PNG.
- **Main thread** (`src/code.ts`, `src/main/`): loads fonts and builds the Figma nodes.
- **Messaging:** the two sides talk only through `postMessage` (`src/core/messages.ts`), and
  layers are sent in batches.
- **Licensing:** every payment check lives in `src/licensing.ts`, stubbed to "paid" for
  development.

Real client PSDs are gitignored. Keep test files outside the repo, or anywhere in it except
`test/fixtures/sample.psd`.

## Before publishing to the Community

- The plugin ID (`1682467824285455363`) is set in `manifest.json`. Never change it.
- Confirm Figma's current seller requirements, then set `LICENSING_ENABLED` in `src/licensing.ts`.
- The plugin has no network access and collects no data. Its only outbound action is opening the
  prep guide in your browser when you click the link.
