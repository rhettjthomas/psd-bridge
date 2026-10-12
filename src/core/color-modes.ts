/**
 * ag-psd refuses CMYK documents by default: `supportedColorModes` leaves mode 4 out, so
 * readPsd throws "Color mode not supported: CMYK" before reading a single layer. The
 * decoding itself is there (it converts CMYK pixels to RGB), so opting in is enough.
 *
 * Call this once before readPsd. The conversion is a naive multiply with no ICC profile,
 * so colors shift; the import report says so.
 */
import { supportedColorModes } from 'ag-psd/dist/psdReader';

/** Photoshop color mode values. */
export const COLOR_MODE = { BITMAP: 0, GRAYSCALE: 1, INDEXED: 2, RGB: 3, CMYK: 4 } as const;

export function enableCmykReading(): void {
  const modes = supportedColorModes as unknown as number[];
  if (!modes.includes(COLOR_MODE.CMYK)) modes.push(COLOR_MODE.CMYK);
}
