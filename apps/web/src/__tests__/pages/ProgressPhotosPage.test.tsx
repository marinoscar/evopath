/**
 * The Progress photos page (E7.9, #249) against MSW: the gallery grouped by
 * month, the pose filter and "Load more" going to the API, the add flow
 * (ghost overlay request, upload, then create), `?add=1`, delete with
 * confirmation, compare defaults and guidance, permission gating and axe.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser, type MockUser } from '../utils/test-utils';
import ProgressPhotosPage from '../../pages/ProgressPhotosPage';
import { clearPhotoUrlCache } from '../../components/intake/StoragePhotoThumb';
import { HEALTH_DATA_UNAVAILABLE } from '../../services/health';
import { PHOTOS_UNAVAILABLE } from '../../services/gyms';
import { mockProgressPhoto, mockProgressPhotoSet, progressPhotosApi } from '../mocks/fixtures/progressPhotos';

const PRIVACY = 'Private to you. Never shared with AI or put in notifications.';

/** The default mock user is a viewer; uploading needs `storage:write`. */
const uploader: MockUser = { ...mockUser, permissions: [...mockUser.permissions, 'storage:write'] };

function photoFile(name = 'me.jpg') {
  return new File(['jpeg-bytes'], name, { type: 'image/jpeg' });
}

beforeEach(() => clearPhotoUrlCache());

describe('ProgressPhotosPage', () => {
  it('groups photos by month, newest first, shows the privacy copy and has no axe violations', async () => {
    const calls = progressPhotosApi(mockProgressPhotoSet());
    const { container } = render(<ProgressPhotosPage />, { wrapperOptions: { user: uploader } });

    expect(screen.getByRole('heading', { level: 1, name: 'Progress photos' })).toBeInTheDocument();
    expect(screen.getByText(PRIVACY)).toBeInTheDocument();

    const months = await screen.findAllByTestId('progress-photo-month');
    expect(months.map((m) => within(m).getByRole('heading', { level: 2 }).textContent)).toEqual([
      expect.stringMatching(/September.*2026/),
      expect.stringMatching(/August.*2026/),
      expect.stringMatching(/July.*2026/),
    ]);
    expect(within(months[0]).getAllByTestId('progress-photo-tile')).toHaveLength(2);
    // Alternative text is the date and pose, nothing else.
    expect(
      await within(months[0]).findByRole('img', { name: 'Progress photo, front pose, Sep 28, 2026' }),
    ).toBeInTheDocument();
    expect(calls.lists).toEqual(['limit=30']);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('sends the pose filter to the API and pages with Load more', async () => {
    const many = Array.from({ length: 35 }, (_, i) =>
      mockProgressPhoto({ localDate: `2026-0${9 - Math.floor(i / 28)}-${String(28 - (i % 28)).padStart(2, '0')}` }),
    );
    const calls = progressPhotosApi([...many, mockProgressPhoto({ localDate: '2026-01-01', pose: 'back' })]);
    const user = userEvent.setup();
    render(<ProgressPhotosPage />);

    await waitFor(() => expect(screen.getAllByTestId('progress-photo-tile')).toHaveLength(30));
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByTestId('progress-photo-tile')).toHaveLength(36));
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(calls.lists).toEqual(['limit=30', 'limit=30&cursor=30']);

    const filter = screen.getByRole('group', { name: 'Filter by pose' });
    await user.click(within(filter).getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getAllByTestId('progress-photo-tile')).toHaveLength(1));
    expect(within(filter).getByRole('button', { name: 'Back' })).toHaveAttribute('aria-pressed', 'true');
    expect(calls.lists.at(-1)).toBe('pose=back&limit=30');
  });

  it('shows an empty state that leads to Add photo', async () => {
    progressPhotosApi([]);
    render(<ProgressPhotosPage />, { wrapperOptions: { user: uploader } });
    expect(await screen.findByRole('heading', { name: 'No progress photos yet' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add photo' })).toHaveLength(2);
  });

  it('adds a photo: asks for the ghost of the chosen pose, uploads, then creates', async () => {
    const ghost = mockProgressPhoto({ localDate: '2026-09-01', pose: 'side' });
    const calls = progressPhotosApi([ghost]);
    const user = userEvent.setup();
    render(<ProgressPhotosPage />, { wrapperOptions: { user: uploader } });
    await screen.findAllByTestId('progress-photo-tile');

    await user.click(screen.getByRole('button', { name: 'Add photo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add progress photo' });
    expect(within(dialog).getByText(PRIVACY)).toBeInTheDocument();
    // Front by default: no earlier front photo, so no overlay and no error.
    await waitFor(() => expect(calls.lists).toContain('pose=front&limit=1'));
    expect(await within(dialog).findByText(/No earlier front photo yet/)).toBeInTheDocument();
    expect(within(dialog).queryByTestId('ghost-overlay')).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('radio', { name: 'Side' }));
    await waitFor(() => expect(calls.lists).toContain('pose=side&limit=1'));
    expect(await within(dialog).findByTestId('ghost-overlay')).toBeInTheDocument();
    expect(within(dialog).getByText(/Your last side photo \(Sep 1, 2026\)/)).toBeInTheDocument();

    await user.upload(within(dialog).getByTestId('progress-photo-file-input'), photoFile());
    expect(within(dialog).getByTestId('progress-photo-chosen')).toHaveTextContent('me.jpg');
    await user.type(within(dialog).getByRole('textbox', { name: 'Note (optional)' }), 'Week 6');
    const date = within(dialog).getByLabelText('Date');
    await user.clear(date);
    await user.type(date, '2026-09-30');
    await user.click(within(dialog).getByRole('button', { name: 'Save photo' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.uploads).toBe(1);
    expect(calls.creates).toEqual([
      { storageObjectId: '22222222-2222-4222-8222-222222222222', localDate: '2026-09-30', pose: 'side', note: 'Week 6' },
    ]);
    expect(await screen.findByText('Photo added.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByTestId('progress-photo-tile')).toHaveLength(2));
  });

  it('explains an API refusal and keeps the dialog open', async () => {
    progressPhotosApi([], {
      createResponse: HttpResponse.json(
        { code: 'BAD_REQUEST', message: 'x', details: { reason: 'PROGRESS_PHOTO_NOT_IMAGE' } },
        { status: 400 },
      ),
    });
    const user = userEvent.setup();
    render(<ProgressPhotosPage />, { wrapperOptions: { route: '/health/progress-photos?add=1', user: uploader } });
    const dialog = await screen.findByRole('dialog', { name: 'Add progress photo' });
    await user.upload(within(dialog).getByTestId('progress-photo-camera-input'), photoFile());
    await user.click(within(dialog).getByRole('button', { name: 'Save photo' }));
    expect(await within(dialog).findByText('That file is not a JPEG, PNG or WebP image.')).toBeInTheDocument();
  });

  it('opens the add flow directly with ?add=1', async () => {
    progressPhotosApi([]);
    render(<ProgressPhotosPage />, { wrapperOptions: { route: '/health/progress-photos?add=1', user: uploader } });
    expect(await screen.findByRole('dialog', { name: 'Add progress photo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take photo' })).toBeEnabled();
  });

  it('without storage:write, the add flow says why and cannot upload', async () => {
    progressPhotosApi([]);
    render(<ProgressPhotosPage />, { wrapperOptions: { route: '/health/progress-photos?add=1' } });
    const dialog = await screen.findByRole('dialog', { name: 'Add progress photo' });
    expect(within(dialog).getByText(PHOTOS_UNAVAILABLE)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Take photo' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Save photo' })).toBeDisabled();
  });

  it('deletes a photo only after confirmation', async () => {
    const [first, ...rest] = mockProgressPhotoSet();
    const calls = progressPhotosApi([first, ...rest]);
    const user = userEvent.setup();
    render(<ProgressPhotosPage />);
    await screen.findAllByTestId('progress-photo-tile');

    await user.click(screen.getByRole('button', { name: 'Delete front photo from Sep 28, 2026' }));
    let dialog = await screen.findByRole('dialog', { name: 'Delete photo?' });
    expect(within(dialog).getByText(/your front photo from Sep 28, 2026/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.deletes).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Delete front photo from Sep 28, 2026' }));
    dialog = await screen.findByRole('dialog', { name: 'Delete photo?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getAllByTestId('progress-photo-tile')).toHaveLength(3));
    expect(calls.deletes).toEqual([first.id]);
    expect(screen.getByText('Photo deleted.')).toBeInTheDocument();
  });

  it('compares the oldest and newest photo of a pose by default, and guides with fewer than two', async () => {
    progressPhotosApi(mockProgressPhotoSet());
    const user = userEvent.setup();
    render(<ProgressPhotosPage />);
    await screen.findAllByTestId('progress-photo-tile');

    await user.click(screen.getByRole('button', { name: 'Compare' }));
    const dialog = await screen.findByRole('dialog', { name: 'Compare photos' });
    expect(await within(dialog).findByRole('img', { name: 'Before: Progress photo, front pose, Jul 1, 2026' })).toBeInTheDocument();
    expect(within(dialog).getByRole('img', { name: 'After: Progress photo, front pose, Sep 28, 2026' })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('combobox', { name: 'Pose' }));
    await user.click(await screen.findByRole('option', { name: 'Side' }));
    expect(await within(dialog).findByText(/You have one side photo/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('img', { name: /^Before:/ })).not.toBeInTheDocument();
  });

  it('a reader without health_data:write sees no Add or Delete', async () => {
    progressPhotosApi(mockProgressPhotoSet());
    render(<ProgressPhotosPage />, { wrapperOptions: { user: { ...mockUser, permissions: ['health_data:read'] } } });
    await screen.findAllByTestId('progress-photo-tile');
    expect(screen.queryByRole('button', { name: 'Add photo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Compare' })).toBeInTheDocument();
  });

  it('without health_data:read, says so and asks nothing', async () => {
    const calls = progressPhotosApi(mockProgressPhotoSet());
    render(<ProgressPhotosPage />, { wrapperOptions: { user: { ...mockUser, permissions: [] } } });
    expect(screen.getByText(HEALTH_DATA_UNAVAILABLE)).toBeInTheDocument();
    expect(calls.lists).toEqual([]);
  });
});
