// Writes test/fixtures/sample.psd: a small synthetic sermon-series comp that covers
// the mapping rules (groups, hidden, opacity, blend modes, clipping, pixel and vector
// masks, masked groups, drop/inner shadows, text, and an adjustment layer). Real client PSDs are gitignored.
import { writePsdBuffer } from 'ag-psd';
import { mkdir, writeFile } from 'node:fs/promises';

const W = 1920, H = 1080;

function solid(w, h, [r, g, b], a = 255) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set([r, g, b, a], i);
  return { width: w, height: h, data };
}

function noise(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = 42;
  for (let i = 0; i < data.length; i += 4) {
    s = (s * 16807) % 2147483647;
    const v = s % 256;
    data.set([v, v, v, 255], i);
  }
  return { width: w, height: h, data };
}

const square = (x, y, s) =>
  [[x, y], [x + s, y], [x + s, y + s], [x, y + s]].map(([a, b]) => ({ linked: false, points: [a, b, a, b, a, b] }));

const px = (name, left, top, w, h, color, extra = {}) => ({
  name, left, top, right: left + w, bottom: top + h, imageData: solid(w, h, color), ...extra,
});

const psd = {
  width: W,
  height: H,
  imageData: solid(W, H, [20, 20, 24]),
  children: [
    px('Background', 0, 0, W, H, [20, 20, 24]),
    {
      name: 'Texture',
      left: 0, top: 0, right: 512, bottom: 512,
      imageData: noise(512, 512),
      blendMode: 'overlay',
      opacity: 0.6,
    },
    {
      name: 'Hero',
      opened: true,
      children: [
        px('Photo', 200, 150, 800, 600, [180, 120, 60]),
        px('Grade (clipped)', 200, 150, 800, 600, [40, 60, 200], { clipping: true, blendMode: 'soft light' }),
        px('Vignette (masked)', 0, 0, 960, 540, [0, 0, 0], {
          opacity: 0.5,
          blendMode: 'multiply',
          mask: { left: 100, top: 100, right: 400, bottom: 300, defaultColor: 0, imageData: solid(300, 200, [255, 255, 255]) },
        }),
        px('Glow (unsupported)', 1200, 700, 200, 200, [255, 220, 150], { blendMode: 'vivid light' }),
      ],
    },
    {
      name: 'Title',
      left: 240, top: 800, right: 1200, bottom: 920,
      text: {
        text: 'THE WAY HOME',
        transform: [1, 0, 0, 1, 240, 900],
        style: { font: { name: 'Inter-Bold' }, fontSize: 96, tracking: 50, fillColor: { r: 255, g: 255, b: 255 } },
      },
      effects: {
        dropShadow: [{
          enabled: true, present: true, angle: 120, useGlobalLight: false,
          distance: { units: 'Pixels', value: 10 }, size: { units: 'Pixels', value: 20 },
          choke: { units: 'Pixels', value: 0 }, color: { r: 0, g: 0, b: 0 }, opacity: 0.5, blendMode: 'multiply',
        }],
        outerGlow: { enabled: true, present: true, size: { units: 'Pixels', value: 10 }, color: { r: 255, g: 255, b: 0 } },
      },
    },
    px('Badge (vector mask)', 1500, 100, 300, 300, [240, 200, 40], {
      vectorMask: {
        paths: [
          { open: false, fillRule: 'non-zero', operation: 'combine', knots: square(1500, 100, 300) },
          { open: false, fillRule: 'non-zero', operation: 'subtract', knots: square(1600, 200, 100) },
        ],
      },
    }),
    {
      name: 'Frame (masked group)',
      opened: true,
      // White outside the mask: the group shows everywhere except the black square.
      mask: { left: 1450, top: 450, right: 1550, bottom: 550, defaultColor: 255, imageData: solid(100, 100, [0, 0, 0]) },
      children: [px('Card', 1400, 400, 300, 200, [230, 230, 230], {
        effects: {
          innerShadow: [{
            enabled: true, present: true, angle: 90, useGlobalLight: false,
            distance: { units: 'Pixels', value: 4 }, size: { units: 'Pixels', value: 8 },
            choke: { units: 'Pixels', value: 50 }, color: { r: 0, g: 0, b: 0 }, opacity: 0.25, blendMode: 'multiply',
          }],
        },
      })],
    },
    px('Source photo (hidden)', 0, 0, 400, 300, [90, 90, 90], { hidden: true }),
    { name: 'Curves', adjustment: { type: 'brightness/contrast', brightness: 10, contrast: 0 } },
    { name: 'Empty layer', left: 0, top: 0, right: 0, bottom: 0 },
  ],
};

await mkdir('test/fixtures', { recursive: true });
await writeFile('test/fixtures/sample.psd', writePsdBuffer(psd, { invalidateTextLayers: true }));
console.log('Wrote test/fixtures/sample.psd');
