/**
 * `StoragePhotoThumb`: a stored photo through a signed URL, and a stored PDF
 * (H2, #186) as a file icon with no URL fetched (an `<img>` cannot draw it).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { StoragePhotoThumb, clearPhotoUrlCache } from '../../../components/intake/StoragePhotoThumb';

let downloads: string[];

beforeEach(() => {
  clearPhotoUrlCache();
  downloads = [];
  server.use(
    http.get('*/api/storage/objects/:id/download', ({ params }) => {
      downloads.push(String(params.id));
      return HttpResponse.json({ data: { url: `https://files.test/${String(params.id)}`, expiresIn: 300 } });
    }),
  );
});

describe('StoragePhotoThumb', () => {
  it('shows a photo through its signed URL', async () => {
    render(<StoragePhotoThumb storageObjectId="obj-1" name="scale.jpg" />);
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'scale.jpg' })).toHaveAttribute('src', 'https://files.test/obj-1'),
    );
    expect(downloads).toEqual(['obj-1']);
  });

  it('shows a PDF as a file icon labelled PDF and fetches no URL', async () => {
    render(<StoragePhotoThumb storageObjectId="obj-2" name="Clinic Report.PDF" />);
    expect(screen.getByRole('img', { name: 'Clinic Report.PDF (PDF)' })).toBeInTheDocument();
    expect(screen.getByText('PDF')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(downloads).toEqual([]);
  });

  it('a missing PDF still reads "photo removed"', () => {
    render(<StoragePhotoThumb storageObjectId={null} name="report.pdf" />);
    expect(screen.getByRole('img', { name: 'report.pdf: photo removed' })).toBeInTheDocument();
  });
});
