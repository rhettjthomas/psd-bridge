// Usage: npm run inspect -- path/to/file.psd
// Prints the layer tree and preflight report exactly as the plugin will see it.
import * as esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { readPsd } from 'ag-psd';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run inspect -- path/to/file.psd');
  process.exit(1);
}

// Bundle the TS reader on the fly so this script needs no build step.
const out = await esbuild.build({
  entryPoints: ['src/core/psd-reader.ts'],
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { psdToIR, formatTree } = await import(
  'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64')
);

const buf = await readFile(file);
const t0 = performance.now();
const psd = readPsd(buf, {
  skipThumbnail: true, skipCompositeImageData: true, skipLayerImageData: true, skipLinkedFilesData: true,
});
const { doc, report } = psdToIR(psd, basename(file));
console.log(formatTree(doc));
console.log(`\nParsed in ${Math.round(performance.now() - t0)} ms`);
const kinds = {};
for (const l of doc.layers) kinds[l.kind] = (kinds[l.kind] ?? 0) + 1;
console.log('Kinds:', kinds);
if (report.length) {
  console.log('\nReport:');
  for (const r of report) console.log(`  [${r.level}] ${r.layerName}: ${r.reason}`);
}
