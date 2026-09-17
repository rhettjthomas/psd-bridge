# psd-bridge
PSD Bridge is a Figma plugin that imports a prepped PSD ("Photoshop Document") into Figma as a layered, editable frame, with real Figma text wherever possible.

**Status:** Milestone 1 (scaffold). The plugin opens in Figma and parses a PSD's layer
tree. Placing layers on the canvas arrives in Milestone 2. See [docs/PLAN.md](docs/PLAN.md).

## Install on a machine (development plugin)

1. Install [Node.js LTS](https://nodejs.org) (v20 or newer) and the Figma desktop app.
2. Clone the repo and build it:
   ```bash
   git clone https://github.com/rhettjthomas/psd-bridge.git
   cd psd-bridge
   npm install
   npm run build
   ```
3. In Figma desktop, open any design file, then choose **Plugins → Development → Import
   plugin from manifest…** and select `psd-bridge/manifest.json`.
4. Run it from **Plugins → Development → PSD Bridge**.

To see the layer tree log, open **Plugins → Development → Show/Hide console**.

## Development

| Command | What it does |
| --- | --- |
| `npm run watch` | Rebuilds `dist/` on save. Re-run the plugin in Figma to pick up changes |
| `npm run build` | Production build |
| `npm test` | Unit tests for `src/core` |
| `npm run typecheck` | TypeScript check |
| `npm run inspect -- file.psd` | Prints a PSD's layer tree and preflight report in the terminal |
| `npm run fixture` | Regenerates `test/fixtures/sample.psd` |

Architecture: the UI iframe (`src/ui/`) parses the PSD with
[ag-psd](https://github.com/Agamnentzar/ag-psd) and converts it to a neutral layer model
(`src/core/model.ts`). The main thread (`src/code.ts`) builds the Figma nodes. The two
sides talk only through `postMessage` (`src/core/messages.ts`).

Real client PSDs are gitignored. Keep test files outside the repo, or anywhere in it except
`test/fixtures/sample.psd`.
