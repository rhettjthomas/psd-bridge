/** Pixel data → PNG bytes, using the browser canvas (UI iframe only). */
import type { PixelData } from 'ag-psd';
import type { Bounds } from '../core/model';
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

export interface EncodedMask extends EncodedImage {
  bounds: Bounds;
}

/**
 * Encodes a layer mask as a grayscale PNG for a Figma luminance mask. Photoshop
 * fills everything outside the mask bounds with `defaultColor`, so when that isn't
 * black the image is extended to cover the layer too.
 */
export async function encodeMask(
  pixels: PixelData | undefined,
  maskBounds: Bounds,
  layerBounds: Bounds,
  defaultColor: number,
): Promise<EncodedMask> {
  const bounds = defaultColor > 0 ? unionBounds(maskBounds, layerBounds) : maskBounds;
  if (defaultColor === 0 && pixels) {
    return { ...(await encodePixels(pixels)), bounds };
  }
  const c = makeCanvas(Math.max(1, bounds.width), Math.max(1, bounds.height));
  const ctx = context2d(c);
  ctx.fillStyle = `rgb(${defaultColor} ${defaultColor} ${defaultColor})`;
  ctx.fillRect(0, 0, bounds.width, bounds.height);
  if (pixels) {
    const src = makeCanvas(pixels.width, pixels.height);
    context2d(src).putImageData(new ImageData(to8Bit(pixels.data) as Uint8ClampedArray<ArrayBuffer>, pixels.width, pixels.height), 0, 0);
    ctx.drawImage(src, maskBounds.left - bounds.left, maskBounds.top - bounds.top);
  }
  const img = ctx.getImageData(0, 0, bounds.width, bounds.height);
  return { ...(await encodePixels(img)), bounds };
}

export function unionBounds(a: Bounds, b: Bounds): Bounds {
  if (a.width <= 0 || a.height <= 0) return b;
  if (b.width <= 0 || b.height <= 0) return a;
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  const right = Math.max(a.left + a.width, b.left + b.width);
  const bottom = Math.max(a.top + a.height, b.top + b.height);
  return { left, top, width: right - left, height: bottom - top };
}
