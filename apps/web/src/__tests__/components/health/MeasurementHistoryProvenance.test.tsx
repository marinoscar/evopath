/**
 * Photo provenance in History (issue #64, E2.6): "Read from photo" for an
 * entry with an AI-read reading, "You edited" when `sourceRef.userEdited`,
 * and "View photo" showing the first source photo through a signed URL.
 * Manual entries are unchanged. A file erased after processing (#185,
 * `fileDeleted: true`) shows "File deleted" instead of "View photo".
 */
import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { fireEvent, render, screen, waitFor, within } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { FILE_DELETED_CHIP, MeasurementHistory, entryPhotoProvenance } from '../../../components/health/MeasurementHistory';
import type { MeasurementDto } from '../../../services/health';
import { mockListPage, mockMeasurement, mockMetricCatalog } from '../../mocks/fixtures/measurements';

const METHOD_LABELS = new Map(mockMetricCatalog.methods.map((m) => [m.key, m.label]));
const at = (day: number) => new Date(Date.UTC(2026, 8, day, 8)).toISOString();

const aiRef = (userEdited: boolean, storageObjectIds = ['obj-photo-1']) => ({
  kind: 'photo_intake',
  intakeId: 'intake-1',
  draftItemId: 'item-1',
  storageObjectIds,
  aiDraft: { metricKey: 'weight', value: 208.4, unit: 'lb', method: 'scale' },
  confidence: 'high',
  userEdited,
});

function rows(): MeasurementDto[] {
  return [
    mockMeasurement('weight', 94.5327, {
      entryId: 'e-ai-edited',
      measuredAt: at(29),
      origin: 'ai',
      method: 'scale',
      sourceRef: aiRef(true),
    }),
    mockMeasurement('weight', 94.5327, {
      entryId: 'e-ai',
      measuredAt: at(28),
      origin: 'ai',
      method: 'scale',
      sourceRef: aiRef(false, ['obj-photo-2']),
    }),
    mockMeasurement('weight', 80, { entryId: 'e-manual', measuredAt: at(27) }),
  ];
}

function renderHistory(data: MeasurementDto[] = rows()) {
  server.use(http.get('*/api/measurements', () => HttpResponse.json({ data: mockListPage(data) })));
  const user = userEvent.setup();
  const utils = render(
    <MeasurementHistory
      metrics={mockMetricCatalog.metrics}
      methodLabels={METHOD_LABELS}
      unitSystem="imperial"
      canWrite
      onEdit={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
  return { ...utils, user };
}

const entries = async () => {
  await waitFor(() => expect(screen.getAllByTestId('history-entry')).toHaveLength(3));
  return screen.getAllByTestId('history-entry');
};

describe('entryPhotoProvenance', () => {
  it('reads AI rows only, tolerates odd sourceRefs, and takes the first photo', () => {
    const entry = (readings: MeasurementDto[]) => ({
      entryId: 'x',
      measuredAt: at(1),
      readings,
      notes: null,
      edited: false,
      origin: readings[0].origin,
    });
    expect(entryPhotoProvenance(entry([mockMeasurement('weight', 80)]))).toEqual({
      readFromPhoto: false,
      userEdited: false,
      photoId: null,
      fileDeleted: false,
    });
    expect(
      entryPhotoProvenance(
        entry([
          mockMeasurement('bp_systolic', 128, { origin: 'manual', sourceRef: { kind: 'photo_intake', intakeId: 'i' } }),
          mockMeasurement('bp_diastolic', 84, { origin: 'ai', sourceRef: aiRef(false, ['a', 'b']) }),
        ]),
      ),
    ).toEqual({ readFromPhoto: true, userEdited: false, photoId: 'a', fileDeleted: false });
    expect(
      entryPhotoProvenance(entry([mockMeasurement('weight', 80, { origin: 'ai', sourceRef: { kind: 'other' } })])),
    ).toEqual({ readFromPhoto: true, userEdited: false, photoId: null, fileDeleted: false });
    expect(
      entryPhotoProvenance(
        entry([mockMeasurement('weight', 80, { origin: 'ai', sourceRef: aiRef(false, ['gone']), fileDeleted: true })]),
      ),
    ).toEqual({ readFromPhoto: true, userEdited: false, photoId: null, fileDeleted: true });
  });
});

describe('MeasurementHistory: photo provenance', () => {
  it('shows Read from photo (and You edited) on AI rows, and the origin on manual ones', async () => {
    renderHistory();
    const [edited, unedited, manual] = await entries();

    expect(within(edited).getByText('Read from photo')).toBeInTheDocument();
    expect(within(edited).getByText('You edited')).toBeInTheDocument();
    expect(within(edited).getByText('208.4 lb')).toBeInTheDocument();

    expect(within(unedited).getByText('Read from photo')).toBeInTheDocument();
    expect(within(unedited).queryByText('You edited')).not.toBeInTheDocument();

    expect(within(manual).getByText('Manual')).toBeInTheDocument();
    expect(within(manual).queryByText('Read from photo')).not.toBeInTheDocument();
    expect(within(manual).queryByRole('button', { name: /View photo/ })).not.toBeInTheDocument();
  });

  it('View photo opens the first stored photo through a signed URL', async () => {
    const asked: string[] = [];
    server.use(
      http.get('*/api/storage/objects/:id/download', ({ params }) => {
        asked.push(String(params.id));
        return HttpResponse.json({ data: { url: `https://signed.example.test/${String(params.id)}`, expiresIn: 300 } });
      }),
    );
    const { user } = renderHistory();
    const [, unedited] = await entries();
    expect(asked).toEqual([]);

    await user.click(within(unedited).getByRole('button', { name: /^View photo for weight entry from/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Photo' });
    const img = await within(dialog).findByRole('img');
    expect(img).toHaveAttribute('src', 'https://signed.example.test/obj-photo-2');
    expect(within(dialog).getByRole('link', { name: 'Open in a new tab' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(asked).toEqual(['obj-photo-2']);

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Photo' })).not.toBeInTheDocument());
  });

  it('a source the image cannot draw (a PDF, H2 #186) offers the new tab instead', async () => {
    server.use(
      http.get('*/api/storage/objects/:id/download', ({ params }) =>
        HttpResponse.json({ data: { url: `https://signed.example.test/${String(params.id)}`, expiresIn: 300 } }),
      ),
    );
    const { user } = renderHistory();
    const [, unedited] = await entries();
    await user.click(within(unedited).getByRole('button', { name: /^View photo for weight entry from/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Photo' });
    fireEvent.error(await within(dialog).findByRole('img'));
    expect(await within(dialog).findByText(/can't be shown here\. Open it in a new tab\./)).toBeInTheDocument();
    expect(within(dialog).queryByRole('img')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Open in a new tab' })).toHaveAttribute(
      'href',
      'https://signed.example.test/obj-photo-2',
    );
  });

  it('says so when the photo is gone', async () => {
    server.use(
      http.get('*/api/storage/objects/:id/download', () =>
        HttpResponse.json({ code: 'NOT_FOUND', message: 'Not found' }, { status: 404 }),
      ),
    );
    const { user } = renderHistory();
    const [edited] = await entries();
    await user.click(within(edited).getByRole('button', { name: /^View photo/ }));
    expect(await screen.findByText('This photo is no longer available.')).toBeInTheDocument();
  });

  it('shows File deleted, and no View photo, when the file was erased after processing', async () => {
    const data = rows();
    data[1] = { ...data[1], fileDeleted: true };
    data[0] = { ...data[0], fileDeleted: false };
    renderHistory(data);
    const [kept, erased, manual] = await entries();

    expect(within(erased).getByText(FILE_DELETED_CHIP)).toBeInTheDocument();
    expect(within(erased).getByText('Read from photo')).toBeInTheDocument();
    expect(within(erased).queryByRole('button', { name: /View photo/ })).not.toBeInTheDocument();

    expect(within(kept).queryByText(FILE_DELETED_CHIP)).not.toBeInTheDocument();
    expect(within(kept).getByRole('button', { name: /View photo/ })).toBeInTheDocument();
    expect(within(manual).queryByText(FILE_DELETED_CHIP)).not.toBeInTheDocument();
  });

  it('has no axe violations with the chips', async () => {
    const { container } = renderHistory();
    await entries();
    expect(await axe(container)).toHaveNoViolations();
  });
});
