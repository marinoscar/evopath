/**
 * `ImageIntake` over the real `useImageIntake`, with `downscaleImage` and the
 * caller's `uploadPhoto` controlled per file so each stage can be seen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { act, fireEvent, render, screen, waitFor, within, mockUser, type MockUser } from '../../utils/test-utils';

vi.mock('../../../utils/downscaleImage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/downscaleImage')>();
  return { ...actual, downscaleImage: vi.fn() };
});

import { downscaleImage } from '../../../utils/downscaleImage';
import { ImageIntake } from '../../../components/intake';
import { useImageIntake, type IntakePhotoStage, type UploadPhotoContext } from '../../../hooks/useImageIntake';

const uploader: MockUser = { ...mockUser, permissions: [...mockUser.permissions, 'storage:write'] };

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

let downscales: (Pending<File> & { file: File })[];
let uploads: (Pending<{ storageObjectId: string }> & { file: File; context?: UploadPhotoContext })[];
let removePhoto: ReturnType<typeof vi.fn>;
let history: Map<string, IntakePhotoStage[]>;

function Harness({ maxPhotos, acceptPdf }: { maxPhotos?: number; acceptPdf?: boolean }) {
  const state = useImageIntake({
    maxPhotos,
    acceptPdf,
    uploadPhoto: (file, context) =>
      new Promise((resolve, reject) => uploads.push({ file, context, resolve, reject })),
    removePhoto: removePhoto as unknown as (id: string) => Promise<void>,
  });
  for (const item of state.items) {
    const seen = history.get(item.name) ?? [];
    if (seen[seen.length - 1] !== item.stage) seen.push(item.stage);
    history.set(item.name, seen);
  }
  return <ImageIntake state={state} maxPhotos={maxPhotos} />;
}

const image = (name: string) => new File(['x'], name, { type: 'image/jpeg' });
const tiles = () => screen.queryAllByTestId('intake-photo-tile');

beforeEach(() => {
  downscales = [];
  uploads = [];
  history = new Map();
  removePhoto = vi.fn().mockResolvedValue(undefined);
  vi.mocked(downscaleImage).mockImplementation(
    (file: File) => new Promise<File>((resolve, reject) => downscales.push({ file, resolve, reject })),
  );
});

afterEach(() => {
  vi.mocked(downscaleImage).mockReset();
});

describe('ImageIntake', () => {
  it('offers Add photos (multiple) and Take photo (capture="environment") file inputs', () => {
    render(<Harness />, { wrapperOptions: { user: uploader } });
    const add = screen.getByLabelText('Add photos');
    expect(add).toHaveAttribute('type', 'file');
    expect(add).toHaveAttribute('accept', 'image/*');
    expect(add).toHaveAttribute('multiple');
    const take = screen.getByLabelText('Take photo');
    expect(take).toHaveAttribute('capture', 'environment');
    expect(take).toHaveAttribute('accept', 'image/*');
    expect(take).not.toHaveAttribute('multiple');
  });

  it('opens each file input from a real button (no label role="button")', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />, { wrapperOptions: { user: uploader } });
    expect(container.querySelector('label[role="button"]')).toBeNull();
    for (const name of ['Add photos', 'Take photo']) {
      const input = screen.getByLabelText(name) as HTMLInputElement;
      const click = vi.spyOn(input, 'click');
      await user.click(screen.getByRole('button', { name }));
      expect(click).toHaveBeenCalledTimes(1);
    }
  });

  it('shows 3 tiles moving downscaling → uploading → processing → ready, with an aggregate count', async () => {
    const user = userEvent.setup();
    render(<Harness />, { wrapperOptions: { user: uploader } });

    await user.upload(screen.getByLabelText('Add photos'), [image('a.jpg'), image('b.jpg'), image('c.jpg')]);
    expect(tiles()).toHaveLength(3);
    await waitFor(() => expect(downscales).toHaveLength(3));
    expect(within(tiles()[0]).getByText('Shrinking')).toBeInTheDocument();

    for (const entry of downscales.splice(0)) await act(async () => entry.resolve(entry.file));
    await waitFor(() => expect(uploads).toHaveLength(3));
    expect(within(tiles()[1]).getByText('Uploading')).toBeInTheDocument();

    act(() => uploads.forEach((entry) => entry.context?.setStage('processing')));
    expect(within(tiles()[2]).getByText('Processing')).toBeInTheDocument();

    await act(async () => uploads[0].resolve({ storageObjectId: 'o-a' }));
    expect(screen.getByTestId('image-intake-progress')).toHaveTextContent('1 of 3 ready');

    await act(async () => {
      uploads[1].resolve({ storageObjectId: 'o-b' });
      uploads[2].resolve({ storageObjectId: 'o-c' });
    });
    expect(screen.getByTestId('image-intake-progress')).toHaveTextContent('3 of 3 ready');
    for (const name of ['a.jpg', 'b.jpg', 'c.jpg']) {
      expect(history.get(name)).toEqual(['downscaling', 'uploading', 'processing', 'ready']);
    }
    expect(screen.getByRole('status')).toHaveTextContent(/Ready/);
  });

  it('queues photos beyond the three in flight', async () => {
    const user = userEvent.setup();
    render(<Harness />, { wrapperOptions: { user: uploader } });
    await user.upload(screen.getByLabelText('Add photos'), ['1', '2', '3', '4'].map((n) => image(`${n}.jpg`)));
    expect(within(tiles()[3]).getByText('Waiting')).toBeInTheDocument();
  });

  it('shows Retry after a failed upload and retries it', async () => {
    const user = userEvent.setup();
    render(<Harness />, { wrapperOptions: { user: uploader } });
    await user.upload(screen.getByLabelText('Add photos'), [image('a.jpg')]);
    await waitFor(() => expect(downscales).toHaveLength(1));
    await act(async () => downscales[0].resolve(downscales[0].file));
    await waitFor(() => expect(uploads).toHaveLength(1));
    await act(async () => uploads[0].reject(new Error('Attach failed')));

    const tile = tiles()[0];
    expect(within(tile).getByText('Failed')).toBeInTheDocument();
    expect(within(tile).getByText('Attach failed')).toBeInTheDocument();

    await user.click(within(tile).getByRole('button', { name: 'Retry a.jpg' }));
    await waitFor(() => expect(downscales).toHaveLength(2));
  });

  it('delete removes the tile and calls removePhoto; its name is in the accessible name', async () => {
    const user = userEvent.setup();
    render(<Harness />, { wrapperOptions: { user: uploader } });
    await user.upload(screen.getByLabelText('Add photos'), [image('bench.jpg')]);
    await waitFor(() => expect(downscales).toHaveLength(1));
    await act(async () => downscales[0].resolve(downscales[0].file));
    await waitFor(() => expect(uploads).toHaveLength(1));
    await act(async () => uploads[0].resolve({ storageObjectId: 'o-bench' }));

    await user.click(screen.getByRole('button', { name: 'Remove bench.jpg' }));
    expect(tiles()).toHaveLength(0);
    expect(removePhoto).toHaveBeenCalledWith('o-bench');
  });

  it('accepts dropped files', () => {
    render(<Harness />, { wrapperOptions: { user: uploader } });
    const zone = screen.getByTestId('image-intake');
    const files = [image('d.jpg')];
    fireEvent.dragOver(zone, { dataTransfer: { files } });
    fireEvent.drop(zone, { dataTransfer: { files } });
    expect(tiles()).toHaveLength(1);
  });

  it('rejects files beyond maxPhotos with a single message', async () => {
    const user = userEvent.setup();
    render(<Harness maxPhotos={2} />, { wrapperOptions: { user: uploader } });
    await user.upload(screen.getByLabelText('Add photos'), [image('1.jpg'), image('2.jpg'), image('3.jpg')]);
    expect(tiles()).toHaveLength(2);
    expect(screen.getByText('1 photo was not added: at most 2 photos.')).toBeInTheDocument();
    expect(screen.getByLabelText('Add photos')).toBeDisabled();
  });

  it('is disabled with the reason for a user who cannot upload (no storage:write)', () => {
    render(<Harness />, { wrapperOptions: { user: mockUser } });
    expect(screen.getByLabelText('Add photos')).toBeDisabled();
    expect(screen.getByLabelText('Take photo')).toBeDisabled();
    expect(screen.getByText(/Your role cannot upload photos/)).toBeInTheDocument();
  });
});

describe('ImageIntake: PDFs (H2, #186)', () => {
  const pdf = (name: string) => new File(['%PDF-1.7'], name, { type: 'application/pdf' });

  it('an image-only kind keeps "Add photos" with accept="image/*" and ignores a chosen PDF', async () => {
    const user = userEvent.setup();
    render(<Harness />, { wrapperOptions: { user: uploader } });
    expect(screen.getByRole('button', { name: 'Add photos' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add photos or PDFs' })).toBeNull();
    expect(screen.getByLabelText('Add photos')).toHaveAttribute('accept', 'image/*');
    // The picker's accept filters the PDF out, as a browser's dialog would.
    await user.upload(screen.getByLabelText('Add photos'), pdf('report.pdf'));
    expect(tiles()).toHaveLength(0);
  });

  it('a kind that takes PDFs reads "Add photos or PDFs" and accepts image/*,application/pdf; Take photo stays image-only', () => {
    render(<Harness acceptPdf />, { wrapperOptions: { user: uploader } });
    expect(screen.getByRole('button', { name: 'Add photos or PDFs' })).toBeInTheDocument();
    const add = screen.getByLabelText('Add photos or PDFs');
    expect(add).toHaveAttribute('accept', 'image/*,application/pdf');
    expect(add).toHaveAttribute('multiple');
    const take = screen.getByLabelText('Take photo');
    expect(take).toHaveAttribute('accept', 'image/*');
    expect(take).toHaveAttribute('capture', 'environment');
    expect(screen.getByText('Add up to 48 photos or PDFs, or drop them here.')).toBeInTheDocument();
  });

  it('shows a PDF as a file icon tile with its name and a PDF label, uploading without a downscale', async () => {
    const user = userEvent.setup();
    render(<Harness acceptPdf />, { wrapperOptions: { user: uploader } });
    await user.upload(screen.getByLabelText('Add photos or PDFs'), pdf('InBody report.pdf'));

    const [tile] = tiles();
    expect(tile).toHaveAttribute('data-kind', 'pdf');
    expect(within(tile).getByRole('img', { name: 'InBody report.pdf (PDF)' })).toBeInTheDocument();
    expect(within(tile).getByText('PDF')).toBeInTheDocument();
    expect(within(tile).getByText('InBody report.pdf')).toBeInTheDocument();
    expect(tile.querySelector('img')).toBeNull();

    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(downscales).toHaveLength(0);
    expect(uploads[0].file.type).toBe('application/pdf');
    expect(history.get('InBody report.pdf')).not.toContain('downscaling');
    await act(async () => uploads[0].resolve({ storageObjectId: 'o-pdf' }));
    expect(tile).toHaveAttribute('data-stage', 'ready');
  });

  it('a dropped PDF over 50 MiB is refused with a message and never uploaded', () => {
    render(<Harness acceptPdf />, { wrapperOptions: { user: uploader } });
    const big = pdf('huge.pdf');
    Object.defineProperty(big, 'size', { value: 50 * 1024 * 1024 + 1 });
    const zone = screen.getByTestId('image-intake');
    fireEvent.dragOver(zone, { dataTransfer: { files: [big] } });
    fireEvent.drop(zone, { dataTransfer: { files: [big] } });
    expect(tiles()).toHaveLength(0);
    expect(screen.getByText('huge.pdf is larger than 50 MiB, the limit for a PDF, and was skipped.')).toBeInTheDocument();
    expect(uploads).toHaveLength(0);
  });
});
