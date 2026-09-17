/**
 * V2 spikes S2 and S4: what does Photoshop accept from a PSD that ag-psd wrote?
 *
 * Usage: node scripts/spikes/write-test-psd.mjs [outDir]
 *
 * Writes two files, kept separate so a problem in one doesn't hide the other:
 *   spike-a-layers.psd  pixel layer, group, shape layers (with and without
 *                       rendered pixels), a text layer, a layer mask, a drop shadow
 *   spike-b-smart.psd   an embedded smart object (linked file + placed layer)
 *
 * Open each in Photoshop and check what is editable. This tells v2 whether the
 * "editable" export path is real or whether layers have to be rasterized.
 */
import { writePsdBuffer } from 'ag-psd';
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const W = 1200;
const H = 800;
const outDir = process.argv[2] ?? '.';
mkdirSync(outDir, { recursive: true });

const rgba = (w, h, fn) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) fn(data, (y * w + x) * 4, x, y);
  }
  return { width: w, height: h, data };
};

const solid = (w, h, [r, g, b], a = 255) => rgba(w, h, (d, i) => d.set([r, g, b, a], i));
const gradient = (w, h) => rgba(w, h, (d, i, x) => {
  const v = Math.round((x / (w - 1)) * 255);
  d.set([v, v, v, 255], i);
});

const corner = (x, y) => ({ linked: false, points: [x, y, x, y, x, y] });
const rectKnots = (x, y, w, h) => [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)];
const px = (value) => ({ units: 'Pixels', value });

/** Minimal PNG encoder (no canvas in Node): 8-bit RGBA, one IDAT. */
function encodePng({ width, height, data }) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(data.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typeAndBody = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndBody) >>> 0);
    return Buffer.concat([len, typeAndBody, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

// ---------- Spike A: layer kinds ----------

const shapeFill = { type: 'color', color: { r: 198, g: 244, b: 50 } };
const shapeStroke = {
  strokeEnabled: true, fillEnabled: true, lineWidth: px(6), lineDashOffset: px(0), miterLimit: 100,
  lineCapType: 'butt', lineJoinType: 'miter', lineAlignment: 'inside', scaleLock: false, strokeAdjust: false,
  lineDashSet: [], blendMode: 'normal', opacity: 1, content: { type: 'color', color: { r: 20, g: 20, b: 20 } },
  resolution: 72,
};

const liveRect = (x, y, w, h, radius) => ({
  keyOriginType: radius ? 2 : 1,
  keyOriginResolution: 72,
  ...(radius ? { keyOriginRRectRadii: { topLeft: px(radius), topRight: px(radius), bottomRight: px(radius), bottomLeft: px(radius) } } : {}),
  keyOriginShapeBoundingBox: { top: px(y), left: px(x), bottom: px(y + h), right: px(x + w) },
  keyOriginBoxCorners: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
  transform: [1, 0, 0, 1, 0, 0],
});

const spikeA = {
  width: W,
  height: H,
  children: [
    { name: 'A · background (pixels)', left: 0, top: 0, right: W, bottom: H, imageData: solid(W, H, [24, 24, 28]) },
    {
      name: 'B · group',
      opened: true,
      children: [
        {
          name: 'C · pixels + layer mask',
          left: 80, top: 80, right: 680, bottom: 380,
          imageData: solid(600, 300, [200, 90, 60]),
          mask: { left: 80, top: 80, right: 680, bottom: 380, defaultColor: 0, imageData: gradient(600, 300) },
        },
      ],
    },
    {
      // Vector data only: does Photoshop render and edit it without pixels?
      name: 'D · shape, no pixels (rounded rect)',
      vectorMask: { paths: [{ open: false, fillRule: 'non-zero', operation: 'combine', knots: rectKnots(760, 80, 360, 200) }] },
      vectorFill: shapeFill,
      vectorStroke: shapeStroke,
      vectorOrigination: { keyDescriptorList: [liveRect(760, 80, 360, 200, 24)] },
    },
    {
      // Same shape, but with rendered pixels supplied, which is what v2 would write.
      name: 'E · shape + pixels (ellipse-ish)',
      left: 760, top: 320, right: 1120, bottom: 520,
      imageData: solid(360, 200, [198, 244, 50]),
      vectorMask: { paths: [{ open: false, fillRule: 'non-zero', operation: 'combine', knots: rectKnots(760, 320, 360, 200) }] },
      vectorFill: shapeFill,
      vectorOrigination: { keyDescriptorList: [liveRect(760, 320, 360, 200, 0)] },
    },
    {
      name: 'F · text + drop shadow',
      left: 80, top: 560, right: 700, bottom: 660,
      text: {
        text: 'Editable text?',
        transform: [1, 0, 0, 1, 80, 640],
        style: { font: { name: 'ArialMT' }, fontSize: 64, autoLeading: true, tracking: 20, fillColor: { r: 255, g: 255, b: 255 } },
        paragraphStyle: { justification: 'left' },
      },
      effects: {
        dropShadow: [{
          enabled: true, present: true, angle: 120, useGlobalLight: true, distance: px(8), size: px(16),
          choke: px(0), color: { r: 0, g: 0, b: 0 }, opacity: 0.6, blendMode: 'multiply',
        }],
      },
    },
  ],
};

writeFileSync(join(outDir, 'spike-a-layers.psd'), writePsdBuffer(spikeA, { invalidateTextLayers: true, logMissingFeatures: true }));

// ---------- Spike B: smart object ----------

const photo = rgba(400, 300, (d, i, x, y) => d.set([(x * 255) / 400, (y * 255) / 300, 200, 255], i));
const linkedId = '20953ddb-9391-11ec-b4f1-c15674f50bc4';

const spikeB = {
  width: W,
  height: H,
  linkedFiles: [{ id: linkedId, name: 'photo.png', type: 'png', creator: '8BIM', data: new Uint8Array(encodePng(photo)) }],
  children: [
    { name: 'A · background (pixels)', left: 0, top: 0, right: W, bottom: H, imageData: solid(W, H, [24, 24, 28]) },
    {
      name: 'B · smart object (embedded png)',
      left: 100, top: 100, right: 500, bottom: 400,
      imageData: photo,
      placedLayer: {
        id: linkedId,
        type: 'raster',
        // Four corners of the placed image, clockwise from top-left.
        transform: [100, 100, 500, 100, 500, 400, 100, 400],
        width: 400,
        height: 300,
      },
    },
  ],
};

writeFileSync(join(outDir, 'spike-b-smart.psd'), writePsdBuffer(spikeB, { logMissingFeatures: true }));

console.log(`Wrote spike-a-layers.psd and spike-b-smart.psd to ${outDir}`);
