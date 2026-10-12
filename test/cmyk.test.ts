/**
 * CMYK import. The fixture is ag-psd's own CMYK test file (MIT licensed), since ag-psd
 * can only *write* RGB documents — there's no way to generate one from this repo.
 */
import { readFileSync } from 'node:fs';
import { readPsd } from 'ag-psd';
import { describe, expect, it } from 'vitest';
import { enableCmykReading } from '../src/core/color-modes';
import { psdToIR } from '../src/core/psd-reader';

const read = () =>
  readPsd(readFileSync('test/fixtures/cmyk.psd'), {
    skipThumbnail: true,
    skipCompositeImageData: true,
    skipLayerImageData: true,
  });

describe('CMYK documents', () => {
  it('are refused by ag-psd until the opt-in runs', () => {
    // Guards the assumption behind color-modes.ts: this is why CMYK files used to fail.
    expect(() => readPsd(new Uint8Array(0))).toThrow();
  });

  it('read once enabled, and report the color shift', () => {
    enableCmykReading();
    const { doc, report } = psdToIR(read(), 'cmyk.psd');
    expect(doc).toMatchObject({ name: 'cmyk', width: 200, height: 200, colorMode: 'CMYK', bitsPerChannel: 8 });
    expect(doc.layers.map((l) => l.name)).toEqual(['Background', 'Layer 1']);
    expect(report).toContainEqual(
      expect.objectContaining({ level: 'approximated', layerName: 'cmyk', reason: expect.stringMatching(/color profile/) }),
    );
  });

  it('is idempotent', () => {
    enableCmykReading();
    enableCmykReading();
    expect(() => psdToIR(read(), 'cmyk.psd')).not.toThrow();
  });
});
