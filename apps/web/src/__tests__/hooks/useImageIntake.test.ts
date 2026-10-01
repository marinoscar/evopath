/**
 * `useImageIntake` — the queue behind `ImageIntake`. `downscaleImage` is
 * mocked (its own test covers the canvas); `uploadPhoto` is a controllable
 * deferred per file so each stage can be observed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../utils/downscaleImage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/downscaleImage')>();
  return { ...actual, downscaleImage: vi.fn(async (file: File) => file) };
});

import { downscaleImage, UnsupportedImageError } from '../../utils/downscaleImage';
import {
  IMAGE_INTAKE_CONCURRENCY,
  INTAKE_PDF_MAX_BYTES,
  isPdfFile,
  useImageIntake,
  type IntakePhotoStage,
  type UploadPhotoContext,
} from '../../hooks/useImageIntake';
import { ApiError } from '../../services/api';

interface Deferred {
  file: File;
  context?: UploadPhotoContext;
  resolve: (id: string) => void;
  reject: (err: unknown) => void;
}

function controlledUpload() {
  const calls: Deferred[] = [];
  const uploadPhoto = vi.fn(
    (file: File, context?: UploadPhotoContext) =>
      new Promise<{ storageObjectId: string }>((resolve, reject) => {
        calls.push({ file, context, resolve: (id) => resolve({ storageObjectId: id }), reject });
      }),
  );
  return { calls, uploadPhoto };
}

const image = (name: string) => new File(['x'], name, { type: 'image/jpeg' });

beforeEach(() => {
  vi.mocked(downscaleImage).mockClear();
  vi.mocked(downscaleImage).mockImplementation(async (file: File) => file);
  URL.createObjectURL = vi.fn((file: Blob) => `blob:${(file as File).name}`);
  URL.revokeObjectURL = vi.fn();
});

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
afterEach(() => {
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

describe('useImageIntake', () => {
  it('moves each photo queued → uploading → processing → ready and reports the aggregate', async () => {
    const { calls, uploadPhoto } = controlledUpload();
    const removePhoto = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useImageIntake({ uploadPhoto, removePhoto }));

    act(() => result.current.addFiles([image('a.jpg'), image('b.jpg')]));
    expect(result.current.items.map((item) => item.name)).toEqual(['a.jpg', 'b.jpg']);
    expect(result.current.items[0].previewUrl).toBe('blob:a.jpg');
    expect(result.current.busy).toBe(true);

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(result.current.items.every((item) => item.stage === 'uploading')).toBe(true);

    act(() => calls[0].context?.setStage('processing'));
    expect(result.current.items[0].stage).toBe('processing');

    await act(async () => calls[0].resolve('obj-a'));
    expect(result.current.items[0]).toMatchObject({ stage: 'ready', storageObjectId: 'obj-a' });
    expect(result.current.readyCount).toBe(1);
    expect(result.current.readyIds).toEqual(['obj-a']);
    expect(result.current.busy).toBe(true);

    await act(async () => calls[1].resolve('obj-b'));
    expect(result.current.readyIds).toEqual(['obj-a', 'obj-b']);
    expect(result.current.busy).toBe(false);
  });

  it(`runs at most ${IMAGE_INTAKE_CONCURRENCY} uploads at once`, async () => {
    const { calls, uploadPhoto } = controlledUpload();
    const { result } = renderHook(() => useImageIntake({ uploadPhoto, removePhoto: vi.fn() }));

    act(() => result.current.addFiles(['1', '2', '3', '4', '5'].map((n) => image(`${n}.jpg`))));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(result.current.items.filter((item) => item.stage === 'queued')).toHaveLength(2);

    await act(async () => calls[0].resolve('o1'));
    await waitFor(() => expect(calls).toHaveLength(4));
    expect(calls[3].file.name).toBe('4.jpg');
  });

  it('shows an error with the reason and retries the same file', async () => {
    const { calls, uploadPhoto } = controlledUpload();
    const { result } = renderHook(() => useImageIntake({ uploadPhoto, removePhoto: vi.fn() }));

    act(() => result.current.addFiles([image('a.jpg')]));
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => calls[0].reject(new Error('Network down')));
    expect(result.current.items[0]).toMatchObject({ stage: 'error', error: 'Network down' });
    expect(result.current.busy).toBe(false);

    act(() => result.current.retry(result.current.items[0].key));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].file.name).toBe('a.jpg');
    await act(async () => calls[1].resolve('obj-a'));
    expect(result.current.items[0].stage).toBe('ready');
  });

  it('says "Convert to JPEG or PNG" for a file the browser cannot decode', async () => {
    vi.mocked(downscaleImage).mockRejectedValueOnce(new UnsupportedImageError('x.heic'));
    const { uploadPhoto } = controlledUpload();
    const { result } = renderHook(() => useImageIntake({ uploadPhoto, removePhoto: vi.fn() }));

    act(() => result.current.addFiles([new File(['x'], 'x.heic', { type: 'image/heic' })]));
    await waitFor(() => expect(result.current.items[0].stage).toBe('error'));
    expect(result.current.items[0].error).toMatch(/Convert to JPEG or PNG/);
    expect(uploadPhoto).not.toHaveBeenCalled();
  });

  it('remove drops the tile, revokes its preview and calls removePhoto for an uploaded photo', async () => {
    const { calls, uploadPhoto } = controlledUpload();
    const removePhoto = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useImageIntake({ uploadPhoto, removePhoto }));

    act(() => result.current.addFiles([image('a.jpg')]));
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => calls[0].resolve('obj-a'));

    await act(async () => result.current.remove(result.current.items[0].key));
    expect(result.current.items).toHaveLength(0);
    expect(removePhoto).toHaveBeenCalledWith('obj-a');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:a.jpg');
  });

  it('detaches a photo removed while it was still uploading once the upload lands', async () => {
    const { calls, uploadPhoto } = controlledUpload();
    const removePhoto = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useImageIntake({ uploadPhoto, removePhoto }));

    act(() => result.current.addFiles([image('a.jpg')]));
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => result.current.remove(result.current.items[0].key));
    expect(removePhoto).not.toHaveBeenCalled();

    await act(async () => calls[0].resolve('obj-late'));
    expect(removePhoto).toHaveBeenCalledWith('obj-late');
    expect(result.current.items).toHaveLength(0);
  });

  it('rejects files beyond maxPhotos with one message', async () => {
    const { uploadPhoto } = controlledUpload();
    const { result } = renderHook(() => useImageIntake({ maxPhotos: 2, uploadPhoto, removePhoto: vi.fn() }));

    act(() => result.current.addFiles([image('1.jpg'), image('2.jpg'), image('3.jpg'), image('4.jpg')]));
    expect(result.current.items).toHaveLength(2);
    expect(result.current.notice).toBe('2 photos were not added: at most 2 photos.');

    act(() => result.current.clearNotice());
    expect(result.current.notice).toBeNull();
  });

  it('skips a non-image file with a message', () => {
    const { uploadPhoto } = controlledUpload();
    const { result } = renderHook(() => useImageIntake({ uploadPhoto, removePhoto: vi.fn() }));
    act(() => result.current.addFiles([new File(['%PDF'], 'doc.pdf', { type: 'application/pdf' }), image('a.jpg')]));
    expect(result.current.items.map((item) => item.name)).toEqual(['a.jpg']);
    expect(result.current.notice).toMatch(/1 file is not an image/);
  });

  it('shows photos already on the server as ready tiles', () => {
    const initialPhotos = [{ storageObjectId: 'obj-1', name: 'old.jpg' }];
    const { result } = renderHook(() =>
      useImageIntake({ uploadPhoto: vi.fn(), removePhoto: vi.fn(), initialPhotos }),
    );
    expect(result.current.items).toEqual([
      expect.objectContaining({ name: 'old.jpg', stage: 'ready', storageObjectId: 'obj-1', previewUrl: null }),
    ]);
    expect(result.current.readyIds).toEqual(['obj-1']);
  });

  it('revokes every preview URL on unmount', async () => {
    const { uploadPhoto } = controlledUpload();
    const { result, unmount } = renderHook(() => useImageIntake({ uploadPhoto, removePhoto: vi.fn() }));
    act(() => result.current.addFiles([image('a.jpg'), image('b.jpg')]));
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:a.jpg');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:b.jpg');
  });
});

describe('useImageIntake: PDFs (H2, #186)', () => {
  const pdf = (name = 'report.pdf', type = 'application/pdf') => new File(['%PDF-1.7 x'], name, { type });

  it('without acceptPdf a PDF is skipped as "not an image"', () => {
    const { uploadPhoto } = controlledUpload();
    const { result } = renderHook(() => useImageIntake({ uploadPhoto, removePhoto: vi.fn() }));
    expect(result.current.acceptPdf).toBe(false);
    act(() => result.current.addFiles([pdf()]));
    expect(result.current.items).toEqual([]);
    expect(result.current.notice).toBe('1 file is not an image and was skipped.');
  });

  it('with acceptPdf a PDF skips the downscale, gets no preview and is uploaded untouched', async () => {
    const { calls, uploadPhoto } = controlledUpload();
    const stages: IntakePhotoStage[] = [];
    const { result } = renderHook(() => {
      const state = useImageIntake({ uploadPhoto, removePhoto: vi.fn(), acceptPdf: true });
      const stage = state.items[0]?.stage;
      if (stage && stages[stages.length - 1] !== stage) stages.push(stage);
      return state;
    });
    const file = pdf();

    act(() => result.current.addFiles([file]));
    expect(result.current.items[0]).toMatchObject({ name: 'report.pdf', kind: 'pdf', previewUrl: null });
    expect(URL.createObjectURL).not.toHaveBeenCalled();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(downscaleImage).not.toHaveBeenCalled();
    expect(calls[0].file).toBe(file);
    expect(calls[0].file.type).toBe('application/pdf');

    await act(async () => calls[0].resolve('obj-pdf'));
    expect(result.current.items[0]).toMatchObject({ stage: 'ready', storageObjectId: 'obj-pdf' });
    expect(stages).not.toContain('downscaling');
  });

  it('types a PDF the platform reported with no type as application/pdf, keeping its bytes and name', async () => {
    const { calls, uploadPhoto } = controlledUpload();
    const { result } = renderHook(() => useImageIntake({ uploadPhoto, removePhoto: vi.fn(), acceptPdf: true }));
    act(() => result.current.addFiles([pdf('scan.PDF', '')]));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].file).toMatchObject({ name: 'scan.PDF', type: 'application/pdf' });
    expect(await calls[0].file.text()).toBe('%PDF-1.7 x');
    expect(downscaleImage).not.toHaveBeenCalled();
  });

  it('images next to a PDF are still downscaled', async () => {
    const { calls, uploadPhoto } = controlledUpload();
    const { result } = renderHook(() => useImageIntake({ uploadPhoto, removePhoto: vi.fn(), acceptPdf: true }));
    act(() => result.current.addFiles([image('a.jpg'), pdf()]));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(downscaleImage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(downscaleImage).mock.calls[0][0].name).toBe('a.jpg');
    expect(result.current.items.map((item) => item.kind)).toEqual(['image', 'pdf']);
  });

  it(`skips a PDF over ${INTAKE_PDF_MAX_BYTES / 1024 / 1024} MiB before any upload, with a friendly message`, () => {
    const { uploadPhoto } = controlledUpload();
    const { result } = renderHook(() => useImageIntake({ uploadPhoto, removePhoto: vi.fn(), acceptPdf: true }));
    const big = pdf('huge.pdf');
    Object.defineProperty(big, 'size', { value: INTAKE_PDF_MAX_BYTES + 1 });
    const atCap = pdf('ok.pdf');
    Object.defineProperty(atCap, 'size', { value: INTAKE_PDF_MAX_BYTES });
    act(() => result.current.addFiles([big, atCap]));
    expect(result.current.items.map((item) => item.name)).toEqual(['ok.pdf']);
    expect(result.current.notice).toBe('huge.pdf is larger than 50 MiB, the limit for a PDF, and was skipped.');
  });

  it('counts PDFs towards maxPhotos and words the notice as files', () => {
    const { uploadPhoto } = controlledUpload();
    const { result } = renderHook(() =>
      useImageIntake({ maxPhotos: 1, uploadPhoto, removePhoto: vi.fn(), acceptPdf: true }),
    );
    act(() => result.current.addFiles([pdf('a.pdf'), image('b.jpg'), new File(['x'], 'notes.txt', { type: 'text/plain' })]));
    expect(result.current.items.map((item) => item.name)).toEqual(['a.pdf']);
    expect(result.current.notice).toBe(
      '1 file was not added: at most 1 files. 1 file is not an image or a PDF and was skipped.',
    );
  });

  it('shows the server refusal of a PDF in words (TOO_MANY_PAGES)', async () => {
    const { calls, uploadPhoto } = controlledUpload();
    const { result } = renderHook(() => useImageIntake({ uploadPhoto, removePhoto: vi.fn(), acceptPdf: true }));
    act(() => result.current.addFiles([pdf()]));
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () =>
      calls[0].reject(
        new ApiError('A PDF may have at most 20 pages', 400, 'BAD_REQUEST', {
          reason: 'TOO_MANY_PAGES',
          pages: 34,
          maxPages: 20,
        }),
      ),
    );
    expect(result.current.items[0]).toMatchObject({ stage: 'error', error: 'This PDF has 34 pages; the limit is 20.' });

    // Retry uploads the same PDF again, still without a downscale.
    act(() => result.current.retry(result.current.items[0].key));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].file.name).toBe('report.pdf');
    expect(downscaleImage).not.toHaveBeenCalled();
  });

  it('a resumed intake shows a stored .pdf as a PDF tile', () => {
    const initialPhotos = [
      { storageObjectId: 'obj-1', name: 'old.jpg' },
      { storageObjectId: 'obj-2', name: 'InBody report.pdf' },
    ];
    const { result } = renderHook(() =>
      useImageIntake({ uploadPhoto: vi.fn(), removePhoto: vi.fn(), initialPhotos, acceptPdf: true }),
    );
    expect(result.current.items.map((item) => item.kind)).toEqual(['image', 'pdf']);
  });

  it('isPdfFile trusts the declared type and falls back to the extension only without one', () => {
    expect(isPdfFile({ name: 'a.pdf', type: 'application/pdf' })).toBe(true);
    expect(isPdfFile({ name: 'a.bin', type: 'application/pdf' })).toBe(true);
    expect(isPdfFile({ name: 'a.pdf', type: '' })).toBe(true);
    expect(isPdfFile({ name: 'a.pdf', type: 'image/jpeg' })).toBe(false);
    expect(isPdfFile({ name: 'a.jpg', type: '' })).toBe(false);
  });
});
