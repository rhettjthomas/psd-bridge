# PSD Bridge

A Figma plugin that imports a Photoshop file as a layered, editable frame: real Figma text,
editable shapes, groups, masks, blend modes, and shadows. Build the textured artwork in
Photoshop, then finish layout and deliverables in Figma without rebuilding the comp by hand.

**Full documentation:**
[the PSD Bridge wiki](https://www.notion.so/PSD-Bridge-3ed7e438758280f79c88ca2baa41ebca) —
quick start, fonts, troubleshooting, and FAQ.
**Questions, feedback, or feature requests:** hello@midwoodroad.com

## Install

Find **PSD Bridge** in the Figma Community and install it. It works in the Figma desktop app
and in the browser.

To run it from source instead (contributors, or testing an unreleased change), see
[Development](#development).

## Quick start

1. In Figma, run **Plugins → PSD Bridge**.
2. Choose a PSD, or drop one into the plugin window. `.psd` and `.psb` both work.
3. Check the **Preflight** list: what will be approximated or skipped, layer by layer.
4. Match any missing fonts, and tick *Remember this match* to reuse them next time.
5. Click **Import to Figma**. You can cancel partway through, and a canceled import adds
   nothing to your file.
6. Read the **Import report**. Click a layer name to select it in Figma; *Copy* copies the list.

## What comes across

| In Photoshop | In Figma |
| --- | --- |
| Pixel layers | Images at the same position, with opacity and blend mode |
| Groups | Groups, with names, order, and visibility kept |
| Artboards | One frame per artboard, with its background color |
| Shape layers | Editable vectors, or native rectangles and ellipses with corner radii |
| Fills | Solid colors, gradients (linear, radial, angle, diamond), tiled patterns |
| Strokes | Width, alignment, caps, joins, dashes |
| Text layers | Editable Figma text: font, size, color, tracking, leading, underline, caps |
| Layer, vector, and clipping masks | Figma masks |
| Drop and inner shadows | Figma effects |
| Hidden layers | Imported, still hidden |

**Not imported, and listed in the report with a reason:** adjustment layers; bevels, glows,
satin, and overlays; blend modes Figma doesn't have (these become Normal); warped, on-path, and
vertical text (these become pixels); mask feather and density; noise gradients. Smart objects
import as a single flat image.

A PSD with several artboards arrives as separate top-level frames, laid out as in Photoshop.
See [docs/PSD-PREP.md](docs/PSD-PREP.md) for how to prep a file so less lands in the report.

## Import options

| Option | Default | Effect |
| --- | --- | --- |
| Editable text | On | Text layers become Figma text (off: pixels) |
| Editable vectors | On | Shape layers become Figma vectors (off: pixels) |
| Import hidden layers | On | Hidden layers come along, still hidden |
| Rebuild shadows | On | Drop and inner shadows become Figma effects |
| Flatten groups | Off | Places all layers directly in the frame; masked groups, artboards, and clipping bases are kept |

Options are remembered between sessions. *Settings (gear) → Reset import options* restores them.

## Fonts

Fonts Figma can't find open a matching window before anything is placed: pick a replacement,
preview it on that layer's own text, and tick **Remember this match**. **Rescan fonts** re-checks
Figma's font list after you install or activate one.

Adobe Fonts activated through Creative Cloud usually don't appear in Figma. Pick the closest
installed font, or install a desktop copy from the foundry and rescan.

**Moving matches to another machine:** *Settings (gear) → Font map* → **Copy**, then paste into
the same window on the other machine and click **Save**. Matches are stored per machine.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "isn't a valid Photoshop document" | Re-save the file from Photoshop as `.psd` or `.psb`. |
| "too large to load" | Close other plugins, delete unused layers, or split the file. |
| A font keeps showing as missing | Install or activate a desktop copy, then click **Rescan fonts**. For Adobe Fonts, pick a replacement and choose *Remember*. |
| Font map Copy or Download does nothing | Figma can block the clipboard and downloads. The text is already selected, so press ⌘C (Ctrl+C). |
| Colors look off | Convert the PSD to 8-bit RGB before importing. |
| A layer came in as pixels instead of editable | Check the report; it names the reason. |
| Plugin didn't pick up code changes (from source) | Run `npm run build`, then close and reopen the plugin. |

Debug output, including the parsed layer tree, goes to *Plugins → Development → Show/Hide console*.

## Privacy

The plugin has no network access and collects no data. PSDs are read on your own machine and
nothing leaves it. The only outbound action is opening the prep guide in your browser when you
click that link.

## Development

Requires **Node.js 20 or newer** and the **Figma desktop app**. About 10 minutes.

```bash
git clone https://github.com/rhettjthomas/psd-bridge.git
cd psd-bridge
npm install
npm run build
```

Then in Figma desktop: **Plugins → Development → Import plugin from manifest…** and select
`psd-bridge/manifest.json`. After pulling changes, run `npm run build` again and reopen the
plugin; re-importing the manifest isn't needed.

| Command | What it does |
| --- | --- |
| `npm run watch` | Rebuilds `dist/` on save |
| `npm run build` | Production build |
| `npm test` | Unit tests: the core mapping, and the importer against a Figma API mock |
| `npm run typecheck` | TypeScript check |
| `npm run inspect -- file.psd` | Prints a PSD's layer tree and preflight report in the terminal |
| `npm run fixture` | Regenerates `test/fixtures/sample.psd` |

**Architecture**
- **UI iframe** (`src/ui/`): parses the PSD with
  [ag-psd](https://github.com/Agamnentzar/ag-psd), converts it to a format-neutral layer model
  (`src/core/`), and encodes each layer's pixels as PNG.
- **Main thread** (`src/code.ts`, `src/main/`): matches and loads fonts, builds the Figma nodes.
- **Messaging:** the two sides talk only through `postMessage` (`src/core/messages.ts`), with
  layers sent in acknowledged batches.
- **Licensing:** every payment check lives in `src/licensing.ts`, stubbed to "paid" for
  development.

Real client PSDs are gitignored. Keep test files outside the repo, or anywhere in it except
`test/fixtures/sample.psd`.

**Docs**
- [docs/PSD-PREP.md](docs/PSD-PREP.md) — prepping a PSD for import
- [docs/PLAN.md](docs/PLAN.md) — build plan, milestones, acceptance tests
- [docs/UI-PATTERNS.md](docs/UI-PATTERNS.md) — the UI/UX conventions, reusable for other plugins
- [docs/V2-PLAN.md](docs/V2-PLAN.md) — export research (parked: the plugin imports only)

## Releasing

- The plugin ID (`1682467824285455363`) is in `manifest.json`. Never change it.
- Bump `version` in `package.json`; the plugin window shows it.
- `npm run build`, then in Figma: **Plugins → Manage plugins → PSD Bridge → Publish new version**.
- For a paid release, confirm Figma's current seller requirements, then set `LICENSING_ENABLED`
  in `src/licensing.ts`.
