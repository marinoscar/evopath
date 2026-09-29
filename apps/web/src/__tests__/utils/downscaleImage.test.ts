/**
 * `downscaleImage` — the canvas is not available in jsdom, so
 * `createImageBitmap`, `getContext` and `toBlob` are mocked; what is tested
 * is the decision (skip or shrink), the output geometry and type, and the
 * fact that the output is the canvas export (no EXIF), not the input bytes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOWNSCALE_SKIP_BYTES, downscaleImage, UnsupportedImageError } from '../../utils/downscaleImage';

const EXIF_MARKER = 'Exif\u0000\u0000GPSLatitude';

function makeFile(name: string, type: string, size: number): File {
  const head = new TextEncoder().encode(EXIF_MARKER);
  const bytes = new Uint8Array(Math.max(size, head.length));
  bytes.set(head, 0);
  return new File([bytes], name, { type });
}

async function text(blob: Blob): Promise<string> {
  return new TextDecoder().decode(await blob.arrayBuffer());
}

let drawImage: ReturnType<typeof vi.fn>;
let toBlob: ReturnType<typeof vi.fn>;
let createImageBitmapMock: ReturnType<typeof vi.fn>;
let bitmapClose: ReturnType<typeof vi.fn>;
let canvases: HTMLCanvasElement[];
const originalToBlob = HTMLCanvasElement.prototype.toBlob;

function bitmapOf(width: number, height: number) {
  createImageBitmapMock.mockResolvedValue({ width, height, close: bitmapClose });
}

beforeEach(() => {
  drawImage = vi.fn();
  bitmapClose = vi.fn();
  canvases = [];
  createImageBitmapMock = vi.fn();
  vi.stubGlobal('createImageBitmap', createImageBitmapMock);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    canvases.push(this);
    return { drawImage } as unknown as CanvasRenderingContext2D;
  } as never);
  toBlob = vi.fn(function (this: HTMLCanvasElement, callback: BlobCallback, type?: string) {
    callback(new Blob([`canvas:${this.width}x${this.height}`], { type: type ?? 'image/png' }));
  });
  HTMLCanvasElement.prototype.toBlob = toBlob as unknown as HTMLCanvasElement['toBlob'];
});

afterEach(() => {
  HTMLCanvasElement.prototype.toBlob = originalToBlob;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('downscaleImage', () => {
  it('shrinks a large photo to maxEdgePx on the long edge, as a JPEG without the input bytes (no EXIF)', async () => {
    bitmapOf(4032, 3024);
    const input = makeFile('IMG_0001.HEIC.png', 'image/png', 3 * 1024 * 1024);

    const output = await downscaleImage(input, { maxEdgePx: 2048 });

    expect(createImageBitmapMock).toHaveBeenCalledWith(input, { imageOrientation: 'from-image' });
    expect(output).not.toBe(input);
    expect(output.type).toBe('image/jpeg');
    expect(output.name).toBe('IMG_0001.HEIC.jpg');
    expect(Math.max(canvases[0].width, canvases[0].height)).toBe(2048);
    expect(canvases[0].width).toBe(2048);
    expect(canvases[0].height).toBe(1536);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 2048, 1536);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.85);
    const body = await text(output);
    expect(body).toBe('canvas:2048x1536');
    expect(body).not.toContain('Exif');
    expect(bitmapClose).toHaveBeenCalled();
  });

  it('keeps a portrait photo portrait (long edge is the height)', async () => {
    bitmapOf(3000, 4000);
    const output = await downscaleImage(makeFile('p.jpg', 'image/jpeg', 2 * 1024 * 1024), { maxEdgePx: 1000 });
    expect(canvases[0].width).toBe(750);
    expect(canvases[0].height).toBe(1000);
    expect(output.type).toBe('image/jpeg');
  });

  it('re-encodes a small-dimension photo that is over 1.5 MB', async () => {
    bitmapOf(1600, 1200);
    const input = makeFile('big.jpg', 'image/jpeg', DOWNSCALE_SKIP_BYTES + 1);
    const output = await downscaleImage(input);
    expect(output).not.toBe(input);
    expect(canvases[0].width).toBe(1600);
  });

  it('returns a small file unchanged', async () => {
    bitmapOf(1024, 768);
    const input = makeFile('small.jpg', 'image/jpeg', 200 * 1024);
    await expect(downscaleImage(input)).resolves.toBe(input);
    expect(toBlob).not.toHaveBeenCalled();
  });

  it.each(['image/gif', 'image/webp'])('returns a %s unchanged without decoding it', async (type) => {
    const input = makeFile('anim', type, 5 * 1024 * 1024);
    await expect(downscaleImage(input)).resolves.toBe(input);
    expect(createImageBitmapMock).not.toHaveBeenCalled();
  });

  it('throws UnsupportedImageError when the browser cannot decode the file', async () => {
    createImageBitmapMock.mockRejectedValue(new DOMException('The source image could not be decoded.'));
    const input = makeFile('IMG_0002.heic', 'image/heic', 3 * 1024 * 1024);
    const error = await downscaleImage(input).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(UnsupportedImageError);
    expect((error as Error).message).toMatch(/Convert to JPEG or PNG/);
  });

  it('honours quality and mimeType', async () => {
    bitmapOf(4000, 4000);
    const output = await downscaleImage(makeFile('x.jpg', 'image/jpeg', 4 * 1024 * 1024), {
      quality: 0.5,
      mimeType: 'image/png',
    });
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png', 0.5);
    expect(output.type).toBe('image/png');
    expect(output.name).toBe('x.png');
  });
});
