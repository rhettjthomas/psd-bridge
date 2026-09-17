// Writes test/fixtures/sample.psd: a small synthetic sermon-series comp that covers
// the mapping rules (groups, hidden, opacity, blend modes, clipping, pixel and vector
// masks, masked groups, drop/inner shadows, live and path shapes with solid, gradient,
// and noise fills and strokes, text, and an adjustment layer). Real client PSDs are gitignored.
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

const corner = (x, y) => ({ linked: false, points: [x, y, x, y, x, y] });
const rectKnots = (x, y, w, h) => [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)];
// Four-knot circle approximation (k = 0.5523).
const ellipseKnots = (x, y, w, h) => {
  const cx = x + w / 2, cy = y + h / 2, kx = (w / 2) * 0.5523, ky = (h / 2) * 0.5523;
  return [
    { linked: true, points: [cx - kx, y, cx, y, cx + kx, y] },
    { linked: true, points: [x + w, cy - ky, x + w, cy, x + w, cy + ky] },
    { linked: true, points: [cx + kx, y + h, cx, y + h, cx - kx, y + h] },
    { linked: true, points: [x, cy + ky, x, cy, x, cy - ky] },
  ];
};
const liveBox = (type, x, y, w, h, r = 0) => ({
  keyOriginType: type,
  keyOriginResolution: 72,
  ...(type === 2 ? { keyOriginRRectRadii: { topLeft: px_(r), topRight: px_(r), bottomRight: px_(r), bottomLeft: px_(r) } } : {}),
  keyOriginShapeBoundingBox: { top: px_(y), left: px_(x), bottom: px_(y + h), right: px_(x + w) },
  keyOriginBoxCorners: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
  transform: [1, 0, 0, 1, 0, 0],
});
const px_ = (value) => ({ units: 'Pixels', value });
const stroke = ({ width, align, color, dashes = [], fill = true }) => ({
  strokeEnabled: true, fillEnabled: fill, lineWidth: px_(width), lineDashOffset: px_(0), miterLimit: 100,
  lineCapType: 'butt', lineJoinType: 'miter', lineAlignment: align, scaleLock: false, strokeAdjust: false,
  lineDashSet: dashes.map((d) => ({ units: 'None', value: d })), blendMode: 'normal', opacity: 1,
  content: { type: 'color', color }, resolution: 72,
});
const shape = (name, knots, extra, open = false) => ({
  name,
  vectorMask: { paths: [{ open, fillRule: 'non-zero', operation: 'combine', knots }] },
  ...extra,
});

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
    {
      name: 'Shapes',
      opened: true,
      children: [
        shape('Button (rounded rect)', rectKnots(100, 950, 200, 60), {
          vectorFill: { type: 'color', color: { r: 198, g: 244, b: 50 } },
          vectorOrigination: { keyDescriptorList: [liveBox(2, 100, 950, 200, 60, 12)] },
        }),
        shape('Dot (ellipse)', ellipseKnots(400, 950, 60, 60), {
          vectorFill: { type: 'color', color: { r: 255, g: 255, b: 255 } },
          vectorStroke: stroke({ width: 4, align: 'inside', color: { r: 0, g: 0, b: 0 } }),
          vectorOrigination: { keyDescriptorList: [liveBox(5, 400, 950, 60, 60)] },
        }),
        shape('Ribbon (path + gradient)', [
          ...[[600, 950], [900, 950], [860, 990], [900, 1030], [600, 1030]].map(([x, y]) => corner(x, y)),
        ], {
          vectorFill: {
            type: 'solid', name: 'Custom', style: 'linear', angle: 90, scale: 1, align: true,
            colorStops: [
              { color: { r: 255, g: 0, b: 0 }, location: 0, midpoint: 0.5 },
              { color: { r: 0, g: 0, b: 255 }, location: 1, midpoint: 0.5 },
            ],
            opacityStops: [
              { opacity: 1, location: 0, midpoint: 0.5 },
              { opacity: 0.5, location: 1, midpoint: 0.5 },
            ],
          },
          vectorStroke: stroke({ width: 2, align: 'center', color: { r: 20, g: 20, b: 20 }, dashes: [2, 1] }),
        }),
        shape('Rule (open path)', [corner(950, 990), corner(1150, 990)], {
          vectorStroke: stroke({ width: 3, align: 'outside', color: { r: 255, g: 255, b: 255 }, fill: false }),
        }, true),
        shape('Noise (unsupported)', rectKnots(1200, 950, 100, 60), {
          vectorFill: { type: 'noise', name: 'Noise', style: 'linear', roughness: 0.5, colorModel: 'rgb', min: [0, 0, 0, 0], max: [1, 1, 1, 1] },
          imageData: solid(100, 60, [128, 128, 128]),
          left: 1200, top: 950, right: 1300, bottom: 1010,
        }),
      ],
    },
    px('Source photo (hidden)', 0, 0, 400, 300, [90, 90, 90], { hidden: true }),
    { name: 'Curves', adjustment: { type: 'brightness/contrast', brightness: 10, contrast: 0 } },
    { name: 'Empty layer', left: 0, top: 0, right: 0, bottom: 0 },
  ],
};

await mkdir('test/fixtures', { recursive: true });
await writeFile('test/fixtures/sample.psd', writePsdBuffer(psd, { invalidateTextLayers: true }));
console.log('Wrote test/fixtures/sample.psd');
