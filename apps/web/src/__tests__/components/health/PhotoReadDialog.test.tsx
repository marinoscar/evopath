/**
 * `PhotoReadDialog` (issue #64, E2.6) over E3.1's kit and a stateful MSW
 * `/api/intakes`: each vision status, the scale and cuff happy paths, edit
 * before accept, the pending-count gate, apply refusals, unreadable, every AI
 * failure mapping (each with Try again and Enter manually), resume and
 * discard, and an axe pass.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser, type MockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';

vi.mock('../../../utils/downscaleImage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/downscaleImage')>();
  return { ...actual, downscaleImage: vi.fn(async (file: File) => file) };
});

import {
  PhotoReadDialog,
  PHOTO_READ_HELPER_TEXT,
  UNREADABLE_MESSAGE,
} from '../../../components/health/PhotoReadDialog';
import { clearPhotoUrlCache } from '../../../components/intake/StoragePhotoThumb';
import { RETAIN_FILES_HELPER_TEXT, RETAIN_FILES_LABEL } from '../../../components/intake';
import { resetMeasurementCatalogCache } from '../../../hooks/useMeasurementCatalog';
import { mockAiPublicConfigEnabled } from '../../mocks/fixtures/ai';
import { mockAiFeaturesView, mockBlockedFeatureView } from '../../mocks/fixtures/aiFeatures';
import {
  apiError,
  cuffItems,
  readingIntake,
  readingIntakeApi,
  readingItem,
  scaleItems,
  type ReadingIntakeApiOptions,
} from '../../mocks/fixtures/bodyMetricIntake';
import { mockHealthProfileSaved } from '../../mocks/fixtures/health';

const reader: MockUser = {
  ...mockUser,
  permissions: [...mockUser.permissions, 'storage:write', 'intakes:read', 'intakes:write'],
};

function setup(options: ReadingIntakeApiOptions = {}, props: { profile?: typeof mockHealthProfileSaved | null } = {}) {
  const api = readingIntakeApi(options);
  const onClose = vi.fn();
  const onEnterManually = vi.fn();
  const onSaved = vi.fn();
  const user = userEvent.setup();
  const utils = render(
    <PhotoReadDialog
      open
      onClose={onClose}
      onEnterManually={onEnterManually}
      onSaved={onSaved}
      profile={props.profile ?? null}
      pollIntervalMs={10}
    />,
    { wrapperOptions: { user: reader, aiEnabled: true } },
  );
  return { ...utils, api, onClose, onEnterManually, onSaved, user };
}

const dialog = () => screen.getByRole('dialog', { name: 'Read from photo' });
const photo = () => new File(['x'], 'scale.jpg', { type: 'image/jpeg' });

/** Wait for the photo step, add one photo and press Read. */
async function addPhotoAndRead(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText(PHOTO_READ_HELPER_TEXT);
  await user.upload(screen.getByLabelText('Add photos'), photo());
  await waitFor(() => expect(screen.getByTestId('intake-photo-tile')).toHaveAttribute('data-stage', 'ready'));
  const read = within(dialog()).getByRole('button', { name: 'Read' });
  await waitFor(() => expect(read).toBeEnabled());
  await user.click(read);
}

const rows = () => screen.getAllByTestId('draft-item-row');

beforeEach(() => {
  resetMeasurementCatalogCache();
  clearPhotoUrlCache();
});

describe('PhotoReadDialog: vision availability', () => {
  it.each([
    ['ai_disabled', { enabled: false, features: mockAiFeaturesView() }, 'AI is turned off for this app'],
    [
      'no_key',
      {
        enabled: true,
        features: mockAiFeaturesView({
          body_metric_reading: mockBlockedFeatureView('body_metric_reading', 'no_key', 'keys'),
        }),
      },
      'Add your own AI key in Settings → AI Keys',
    ],
    [
      'no_models',
      {
        enabled: true,
        features: mockAiFeaturesView({
          body_metric_reading: mockBlockedFeatureView('body_metric_reading', 'no_models', 'admin'),
        }),
      },
      "Your administrator hasn't assigned an AI model that can read photos yet.",
    ],
  ])('%s shows the notice, makes no intake request, and Continue manually hands over', async (_status, scenario, title) => {
    const api = readingIntakeApi();
    server.use(
      http.get('*/api/ai/config', () =>
        HttpResponse.json({ data: { ...mockAiPublicConfigEnabled, enabled: scenario.enabled } }),
      ),
      http.get('*/api/ai/features', () => HttpResponse.json({ data: scenario.features })),
    );
    const onEnterManually = vi.fn();
    const user = userEvent.setup();
    // No AI provider in the wrapper: the dialog reads `GET /ai/config` itself.
    render(
      <PhotoReadDialog open onClose={vi.fn()} onEnterManually={onEnterManually} onSaved={vi.fn()} pollIntervalMs={10} />,
      { wrapperOptions: { user: reader } },
    );

    expect(await screen.findByText(title)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue manually' }));
    expect(onEnterManually).toHaveBeenCalledTimes(1);
    expect(api.requests).toEqual([]);
  });

  it('shows "Checking AI availability" while loading', () => {
    readingIntakeApi();
    setup();
    expect(screen.getByText('Checking AI availability')).toBeInTheDocument();
  });
});

describe('PhotoReadDialog: scale', () => {
  it('discloses the model, reads, and shows one pending "AI guess" weight; nothing is saved before Save to Health', async () => {
    const { api, user, onSaved, onClose } = setup();

    await screen.findByText(PHOTO_READ_HELPER_TEXT);
    expect(api.created).toBe(1);
    expect(api.requests[0].path).toBe('/api/intakes?kind=body_metric_reading&status=draft%2Cscanning%2Cready&limit=1');
    expect(api.requests[1]).toMatchObject({ method: 'POST', path: '/api/intakes', body: { kind: 'body_metric_reading' } });
    expect(screen.getByLabelText('Take photo')).toHaveAttribute('capture', 'environment');

    const disclosure = screen.getByTestId('ai-vision-disclosure');
    expect(disclosure).toHaveTextContent('openai');
    expect(disclosure).toHaveTextContent('your own key');

    await addPhotoAndRead(user);
    // The server picks the model: the body names none.
    expect(api.analyzed).toEqual([{}]);
    expect(await screen.findByLabelText('Reading the photo')).toBeInTheDocument();

    await waitFor(() => expect(rows()).toHaveLength(1));
    const row = rows()[0];
    expect(row).toHaveTextContent('Weight 208.4 lb');
    expect(row).toHaveTextContent('Scale');
    expect(within(row).getByText('AI guess')).toBeInTheDocument();
    expect(within(row).getByText('High confidence')).toBeInTheDocument();

    const save = within(dialog()).getByRole('button', { name: /Save to Health/ });
    expect(save).toBeDisabled();
    expect(save).toHaveTextContent('Save to Health (1 pending)');
    expect(screen.getByText('1 item needs a decision before saving')).toBeInTheDocument();
    expect(api.applied).toBe(0);

    await user.click(within(row).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(within(dialog()).getByRole('button', { name: 'Save to Health' })).toBeEnabled());
    await user.click(within(dialog()).getByRole('button', { name: 'Save to Health' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(api.applied).toBe(1);
    expect(onSaved.mock.calls[0][0]).toHaveLength(1);
    expect(onClose).toHaveBeenCalled();
    expect(await screen.findByText('Saved to Health')).toBeInTheDocument();
  });

  it('edits a drafted value before accepting: the PATCH carries the new value and the row shows "AI said"', async () => {
    const { api, user } = setup();
    await addPhotoAndRead(user);
    await waitFor(() => expect(rows()).toHaveLength(1));

    await user.click(within(rows()[0]).getByRole('button', { name: 'Edit' }));
    const editor = screen.getByTestId('reading-editor');
    const value = within(editor).getByRole('textbox', { name: 'Value' });
    await user.clear(value);
    await user.type(value, '209.4');
    await user.click(within(rows()[0]).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.itemPatches).toHaveLength(1));
    expect(api.itemPatches[0].body).toEqual({ value: { metricKey: 'weight', value: 209.4, unit: 'lb', method: 'scale' } });
    await waitFor(() => expect(rows()[0]).toHaveTextContent('Weight 209.4 lb'));
    expect(within(rows()[0]).getByTestId('draft-item-ai-said')).toHaveTextContent('Weight 208.4 lb');
    expect(within(rows()[0]).getByText('You verified')).toBeInTheDocument();
  });

  it('the editor explains an out-of-range value in the device unit', async () => {
    const { user } = setup();
    await addPhotoAndRead(user);
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(within(rows()[0]).getByRole('button', { name: 'Edit' }));
    const value = within(screen.getByTestId('reading-editor')).getByRole('textbox', { name: 'Value' });
    await user.clear(value);
    await user.type(value, '9999');
    expect(screen.getByText('Enter a value between 44.1 and 1102.3 lb')).toBeInTheDocument();
  });

  it('shows a flagged out-of-range reading (low, unsure, range note) and the refused apply naming the field', async () => {
    const flagged = readingItem(
      { metricKey: 'weight', value: 9999, unit: 'kg', method: 'scale' },
      { confidence: 'low', uncertain: true, uncertaintyNote: 'Outside the usual range for Weight', status: 'accepted', userVerified: true },
    );
    const { user } = setup({
      result: { items: [flagged] },
      applyError: apiError(400, 'Weight: must be between 20 and 500 kg; edit or reject it', {
        issues: [{ path: `items.${flagged.id}.value.value`, message: 'Weight: must be between 20 and 500 kg; edit or reject it' }],
      }),
    });
    await addPhotoAndRead(user);
    await waitFor(() => expect(rows()).toHaveLength(1));
    const row = rows()[0];
    expect(within(row).getByText('Low confidence')).toBeInTheDocument();
    expect(within(row).getByText('Unsure')).toBeInTheDocument();
    expect(within(row).getByTestId('draft-item-uncertainty')).toHaveTextContent('Outside the usual range for Weight');

    await user.click(within(dialog()).getByRole('button', { name: 'Save to Health' }));
    expect(await screen.findByTestId('photo-read-apply-issues')).toHaveTextContent(
      'Weight: must be between 20 and 500 kg; edit or reject it',
    );
  });
});

describe('PhotoReadDialog: blood-pressure cuff', () => {
  it('drafts systolic, diastolic and an unsure pulse; the pending count gates Save; a lone systolic is refused and the intake stays', async () => {
    const { api, user, onSaved } = setup({
      result: { items: cuffItems(), resultMeta: { deviceKind: 'bp_cuff' } },
      applyError: apiError(400, 'Enter both blood pressure numbers', {
        issues: [{ path: 'items', message: 'Enter both blood pressure numbers' }],
      }),
    });
    await addPhotoAndRead(user);
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows()[0]).toHaveTextContent('Blood pressure: systolic 128 mmHg');
    expect(rows()[1]).toHaveTextContent('Blood pressure: diastolic 84 mmHg');
    expect(rows()[2]).toHaveTextContent('Resting heart rate 72 bpm');
    expect(within(rows()[2]).getByTestId('draft-item-uncertainty')).toHaveTextContent(
      'Pulse from a blood-pressure cuff may not be a resting rate',
    );
    expect(within(dialog()).getByRole('button', { name: /Save to Health/ })).toHaveTextContent('(3 pending)');

    await user.click(within(rows()[0]).getByRole('button', { name: 'Accept' }));
    await user.click(within(rows()[1]).getByRole('button', { name: 'Reject' }));
    await user.click(within(rows()[1]).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(within(dialog()).getByRole('button', { name: 'Save to Health' })).toBeEnabled());
    expect(screen.getByText('1 reading will be saved')).toBeInTheDocument();

    await user.click(within(dialog()).getByRole('button', { name: 'Save to Health' }));
    expect(await screen.findByTestId('photo-read-apply-issues')).toHaveTextContent('Enter both blood pressure numbers');
    expect(onSaved).not.toHaveBeenCalled();
    // Still reviewable: the refusal left the intake `ready`.
    expect(within(dialog()).getByRole('button', { name: 'Save to Health' })).toBeInTheDocument();
    expect(api.applied).toBe(0);
  });

  it('shows the refusal for a duplicate metric', async () => {
    const { user } = setup({
      result: { items: [...scaleItems(), ...scaleItems()] },
      applyError: apiError(400, 'Weight is accepted more than once; reject one of them', {
        issues: [{ path: 'items.item-x.value.metricKey', message: 'Weight is accepted more than once; reject one of them' }],
      }),
    });
    await addPhotoAndRead(user);
    await waitFor(() => expect(rows()).toHaveLength(2));
    await user.click(within(dialog()).getByRole('button', { name: /Accept all/ }));
    await waitFor(() => expect(within(dialog()).getByRole('button', { name: 'Save to Health' })).toBeEnabled());
    await user.click(within(dialog()).getByRole('button', { name: 'Save to Health' }));
    expect(await screen.findByText('Weight is accepted more than once; reject one of them')).toBeInTheDocument();
  });
});

describe('PhotoReadDialog: unreadable', () => {
  it('says so, and Add missing item posts a hand-typed reading in the profile unit', async () => {
    const { api, user, onEnterManually } = setup(
      { result: { items: [], resultMeta: { unreadable: true } } },
      { profile: mockHealthProfileSaved },
    );
    await addPhotoAndRead(user);
    expect(await screen.findByText(UNREADABLE_MESSAGE)).toBeInTheDocument();
    expect(screen.queryAllByTestId('draft-item-row')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Add missing item' }));
    const editor = within(screen.getByTestId('draft-item-add'));
    await user.type(editor.getByRole('textbox', { name: 'Value' }), '80.5');
    await user.click(editor.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(api.itemPosts).toHaveLength(1));
    const unit = mockHealthProfileSaved.unitSystem === 'imperial' ? 'lb' : 'kg';
    expect(api.itemPosts[0]).toEqual({ kind: 'reading', value: { metricKey: 'weight', value: 80.5, unit } });
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(within(rows()[0]).getByText('You added')).toBeInTheDocument();

    await user.click(within(dialog()).getByRole('button', { name: 'Enter manually' }));
    expect(onEnterManually).toHaveBeenCalledTimes(1);
  });
});

describe('PhotoReadDialog: failures offer Try again and Enter manually', () => {
  it.each([
    ['AI_KEY_REQUIRED', 403, 'Add your API key'],
    ['AI_MODEL_NOT_ENABLED', 403, "This model isn't available to you"],
    ['AI_CAPABILITY_UNSUPPORTED', 400, "This model can't do that"],
    ['AI_RATE_LIMITED', 429, 'Provider rate limit'],
    ['AI_DISABLED', 403, 'AI is disabled by your administrator'],
  ])('analyze refused with %s', async (reason, status, title) => {
    const { user, onEnterManually, api } = setup({
      analyzeError: apiError(status, 'Refused', { reason }, 'FORBIDDEN'),
    });
    await addPhotoAndRead(user);
    const failure = await screen.findByTestId('photo-read-failure');
    expect(within(failure).getByText(title, { exact: false })).toBeInTheDocument();
    if (reason === 'AI_KEY_REQUIRED') {
      expect(within(failure).getByRole('link', { name: 'Add API key' })).toHaveAttribute('href', '/settings/ai');
    }
    const before = api.requests.filter((r) => r.path.endsWith('/analyze')).length;
    await user.click(within(failure).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.requests.filter((r) => r.path.endsWith('/analyze')).length).toBe(before + 1));
    await user.click(within(screen.getByTestId('photo-read-failure')).getByRole('button', { name: 'Enter manually' }));
    expect(onEnterManually).toHaveBeenCalled();
  });

  it.each([
    ['AI_STRUCTURED_OUTPUT_INVALID', "The answer didn't match the schema"],
    ['AI_RATE_LIMITED', 'Provider rate limit'],
    ['AI_DISABLED', 'AI is disabled by your administrator'],
    ['READ_FAILED', 'Something went wrong'],
  ])('a scan that failed with %s shows the mapped message; Try again reads again', async (errorCode, title) => {
    const { api, user } = setup({
      result: { status: 'failed', errorCode, errorMessage: 'The photo could not be read' },
    });
    await addPhotoAndRead(user);
    const failure = await screen.findByTestId('photo-read-failure');
    expect(within(failure).getByText(title, { exact: false })).toBeInTheDocument();
    // The photos stay; Read again from here.
    expect(screen.getByTestId('intake-photo-tile')).toBeInTheDocument();
    await user.click(within(failure).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.analyzed).toHaveLength(2));
    // The second scan fails the same way; Enter manually is still there.
    const again = await screen.findByTestId('photo-read-failure');
    expect(within(again).getByRole('button', { name: 'Enter manually' })).toBeInTheDocument();
  });

  it('storage unavailable on upload: the tile says so with Retry, and Enter manually stays available', async () => {
    readingIntakeApi();
    server.use(
      http.post('*/api/storage/objects', () =>
        HttpResponse.json(
          { code: 'SERVICE_UNAVAILABLE', message: 'File storage is not configured', details: { reason: 'storage_not_configured' } },
          { status: 503 },
        ),
      ),
    );
    const onEnterManually = vi.fn();
    const user = userEvent.setup();
    render(
      <PhotoReadDialog open onClose={vi.fn()} onEnterManually={onEnterManually} onSaved={vi.fn()} pollIntervalMs={10} />,
      { wrapperOptions: { user: reader, aiEnabled: true } },
    );
    await screen.findByText(PHOTO_READ_HELPER_TEXT);
    await user.upload(screen.getByLabelText('Add photos'), photo());
    await waitFor(() => expect(screen.getByTestId('intake-photo-tile')).toHaveAttribute('data-stage', 'error'));
    expect(screen.getByText('File storage is not configured')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry scale.jpg' })).toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: 'Read' })).toBeDisabled();
    await user.click(within(dialog()).getByRole('button', { name: 'Enter manually' }));
    expect(onEnterManually).toHaveBeenCalled();
  });

  it('a network failure starting the intake offers Try again', async () => {
    const api = readingIntakeApi({ createError: 'network' });
    const user = userEvent.setup();
    render(
      <PhotoReadDialog open onClose={vi.fn()} onEnterManually={vi.fn()} onSaved={vi.fn()} pollIntervalMs={10} />,
      { wrapperOptions: { user: reader, aiEnabled: true } },
    );
    const failure = await screen.findByTestId('photo-read-failure');
    expect(failure).toHaveTextContent('Could not reach the server');
    const posts = () => api.requests.filter((r) => r.method === 'POST').length;
    const before = posts();
    await user.click(within(failure).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(posts()).toBe(before + 1));
  });
});

describe('PhotoReadDialog: resume and discard', () => {
  it('resumes the newest unfinished intake instead of creating another', async () => {
    const existing = readingIntake('ready', {
      id: 'intake-old',
      photos: [{ id: 'p-1', storageObjectId: 'obj-1', name: 'scale.jpg', sortOrder: 0, healthDocumentId: 'doc-1', retention: 'keep' }],
      items: scaleItems(),
    });
    const { api } = setup({ existing: [existing] });
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveTextContent('Weight 208.4 lb');
    expect(api.created).toBe(0);
  });

  it('resumes a scan that is still running and shows its progress', async () => {
    const existing = readingIntake('scanning', { id: 'intake-scan' });
    const { api } = setup({ existing: [existing], scanPolls: 50 });
    expect(await screen.findByLabelText('Reading the photo')).toBeInTheDocument();
    expect(api.created).toBe(0);
  });

  it('Discard deletes the intake and closes', async () => {
    const existing = readingIntake('ready', { id: 'intake-old', items: scaleItems() });
    const { api, user, onClose } = setup({ existing: [existing] });
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.click(within(dialog()).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(api.discarded).toBe(1));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('PhotoReadDialog: keep or delete the file (#185)', () => {
  const keepBox = () => within(dialog()).getByRole('checkbox', { name: RETAIN_FILES_LABEL });
  const createBody = (api: ReturnType<typeof readingIntakeApi>) =>
    api.requests.find((r) => r.method === 'POST' && r.path === '/api/intakes')?.body;
  const attachBodies = (api: ReturnType<typeof readingIntakeApi>) =>
    api.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/photos')).map((r) => r.body);

  it('is checked by default, explained by its helper text, and a new intake is created keeping files', async () => {
    const { api } = setup();
    await screen.findByText(PHOTO_READ_HELPER_TEXT);
    expect(keepBox()).toBeChecked();
    expect(keepBox()).toHaveAccessibleDescription(RETAIN_FILES_HELPER_TEXT);
    expect(createBody(api)).toEqual({ kind: 'body_metric_reading', retainFiles: true });
    expect(api.intakePatches).toEqual([]);
  });

  it('unchecking sends retainFiles: false, and a photo added afterwards carries it', async () => {
    const { api, user } = setup();
    await screen.findByText(PHOTO_READ_HELPER_TEXT);
    await user.click(keepBox());
    await waitFor(() => expect(api.intakePatches).toEqual([{ id: 'intake-new-1', body: { retainFiles: false } }]));
    await waitFor(() => expect(keepBox()).not.toBeChecked());

    await user.upload(screen.getByLabelText('Add photos'), photo());
    await waitFor(() => expect(attachBodies(api)).toHaveLength(1));
    expect(attachBodies(api)[0]).toMatchObject({ retainFiles: false });
    expect(api.intakes.get('intake-new-1')?.photos[0]?.retention).toBe('delete_after_processing');
  });

  it('a photo added with the default choice is attached keeping the file', async () => {
    const { api, user } = setup();
    await screen.findByText(PHOTO_READ_HELPER_TEXT);
    await user.upload(screen.getByLabelText('Add photos'), photo());
    await waitFor(() => expect(attachBodies(api)).toHaveLength(1));
    expect(attachBodies(api)[0]).toMatchObject({ retainFiles: true });
  });

  it('a resumed intake shows its stored choice, and re-checking it PATCHes retainFiles: true', async () => {
    const existing = readingIntake('ready', {
      id: 'intake-old',
      retainFiles: false,
      retention: 'delete_after_processing',
      items: scaleItems(),
    });
    const { api, user } = setup({ existing: [existing] });
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(keepBox()).not.toBeChecked();
    await user.click(keepBox());
    await waitFor(() => expect(api.intakePatches).toEqual([{ id: 'intake-old', body: { retainFiles: true } }]));
    await waitFor(() => expect(keepBox()).toBeChecked());
    expect(api.created).toBe(0);
  });

  it('a refused change is put back', async () => {
    const { api, user } = setup();
    await screen.findByText(PHOTO_READ_HELPER_TEXT);
    server.use(
      http.patch('*/api/intakes/:id', () =>
        HttpResponse.json({ code: 'INTAKE_APPLIED', message: 'This intake was already applied' }, { status: 409 }),
      ),
    );
    await user.click(keepBox());
    expect(await screen.findByText('This intake was already applied')).toBeInTheDocument();
    await waitFor(() => expect(keepBox()).toBeChecked());
    expect(api.intakePatches).toEqual([]);
  });
});

describe('PhotoReadDialog: accessibility', () => {
  it('has no axe violations on the photo step and on the review', async () => {
    const { user, container } = setup({ result: { items: cuffItems() } });
    await screen.findByText(PHOTO_READ_HELPER_TEXT);
    // The kit's file pickers are real buttons, so the photo step is checked in full too.
    expect(await axe(document.body)).toHaveNoViolations();
    await addPhotoAndRead(user);
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(await axe(document.body)).toHaveNoViolations();
    expect(container).toBeTruthy();
  });
});
