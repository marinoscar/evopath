/**
 * Shrink a photo in the browser before it is uploaded.
 *
 * Phone photos are 4000+ px and several MB; a vision model reads them no
 * better than a 2048 px copy, and the upload is the slow part of a photo
 * intake. The image is decoded with `createImageBitmap(file, {
 * imageOrientation: 'from-image' })` and redrawn on a canvas, so:
 *
 * - the EXIF orientation is BAKED INTO THE PIXELS (a portrait photo stays
 *   portrait without any metadata), and
 * - ALL METADATA IS DROPPED, including EXIF GPS: a canvas export carries none.
 *
 * Returned untouched: a GIF or WebP (animation and alpha would be lost, and
 * both are usually small), and any image already within `maxEdgePx` on its
 * long edge and at most 1.5 MB.
 *
 * A file the browser cannot decode (HEIC on most desktop browsers, a
 * corrupt file) throws {@link UnsupportedImageError}; the UI says "Convert
 * to JPEG or PNG".
 */

export interface DownscaleImageOptions {
  /** Longest edge of the output, in pixels. 2048 by default. */
  maxEdgePx?: number;
  /** Encoder quality, 0–1. 0.85 by default. */
  quality?: number;
  /** Output type. `image/jpeg` by default. */
  mimeType?: string;
}

/** Files at or under this size and edge are uploaded as they are. */
export const DOWNSCALE_SKIP_BYTES = 1.5 * 1024 * 1024;

const PASSTHROUGH_TYPES = new Set(['image/gif', 'image/webp']);

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** The browser cannot decode this file as an image. */
export class UnsupportedImageError extends Error {
  constructor(readonly fileName: string) {
    super(`${fileName} cannot be read as an image here. Convert to JPEG or PNG.`);
    this.name = 'UnsupportedImageError';
  }
}

function renamed(name: string, mimeType: string): string {
  const ext = EXTENSIONS[mimeType] ?? 'jpg';
  const stem = name.replace(/\.[^./\\]+$/, '') || 'photo';
  return `${stem}.${ext}`;
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality));
}

export async function downscaleImage(file: File, options: DownscaleImageOptions = {}): Promise<File> {
  const { maxEdgePx = 2048, quality = 0.85, mimeType = 'image/jpeg' } = options;

  if (PASSTHROUGH_TYPES.has(file.type)) return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new UnsupportedImageError(file.name);
  }

  try {
    const { width, height } = bitmap;
    if (!width || !height) throw new UnsupportedImageError(file.name);
    const longEdge = Math.max(width, height);
    if (longEdge <= maxEdgePx && file.size <= DOWNSCALE_SKIP_BYTES) return file;

    const scale = Math.min(1, maxEdgePx / longEdge);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new UnsupportedImageError(file.name);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const blob = await canvasToBlob(canvas, mimeType, quality);
    if (!blob) throw new UnsupportedImageError(file.name);
    return new File([blob], renamed(file.name, mimeType), {
      type: blob.type || mimeType,
      lastModified: file.lastModified,
    });
  } finally {
    bitmap.close?.();
  }
}
