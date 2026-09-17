/** Pixel data → PNG bytes, using the browser canvas (UI iframe only). */
import type { PixelData } from 'ag-psd';
import { fitImageSize } from '../core/units';

export interface EncodedImage {
  png: Uint8Array;
  width: number;
  height: number;
  downscaled: boolean;
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function makeCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

function context2d(c: AnyCanvas) {
  const ctx = c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('Canvas 2D is unavailable.');
  return ctx;
}

async function toPng(c: AnyCanvas): Promise<Uint8Array> {
  const blob =
    'convertToBlob' in c
      ? await c.convertToBlob({ type: 'image/png' })
      : await new Promise<Blob>((resolve, reject) =>
          c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed.'))), 'image/png'),
        );
  return new Uint8Array(await blob.arrayBuffer());
}

/** 16-bit and 32-bit PSDs decode to wider arrays; the canvas needs 8-bit RGBA. */
export function to8Bit(data: PixelData['data']): Uint8ClampedArray {
  if (data instanceof Uint8ClampedArray) return data;
  if (data instanceof Uint8Array) return new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  const out = new Uint8ClampedArray(data.length);
  if (data instanceof Uint16Array) {
    for (let i = 0; i < data.length; i++) out[i] = data[i] >> 8;
  } else {
    // 32-bit float (0–1). Alpha is linear already; color is written as-is and reported upstream.
    for (let i = 0; i < data.length; i++) out[i] = data[i] * 255;
  }
  return out;
}

export async function encodePixels(img: PixelData): Promise<EncodedImage> {
  const { width, height } = img;
  const src = makeCanvas(width, height);
  const pixels = to8Bit(img.data) as Uint8ClampedArray<ArrayBuffer>;
  context2d(src).putImageData(new ImageData(pixels, width, height), 0, 0);

  const fit = fitImageSize(width, height);
  if (!fit.downscaled) return { png: await toPng(src), width, height, downscaled: false };

  const dst = makeCanvas(fit.width, fit.height);
  const ctx = context2d(dst);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, fit.width, fit.height);
  return { png: await toPng(dst), width: fit.width, height: fit.height, downscaled: true };
}
