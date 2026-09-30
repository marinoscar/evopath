/**
 * `/gyms/:gymId/scan` (E3.4): the gates (AI off, no vision model, missing
 * permission) with "Continue manually"; resume-or-create of the intake;
 * Photos -> Scanning -> Review -> Apply against the stateful MSW intake API
 * with the two reference examples' drafts; edit/reject/add-missing/accept-all;
 * Apply disabled while items are pending; a failed batch; a failed scan;
 * Cancel while scanning.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import GymScanPage from '../../pages/GymScanPage';
import { clearPhotoUrlCache } from '../../components/intake/StoragePhotoThumb';
import { SCAN_PHOTOS_HELPER, type GymDetailLocationState } from '../../services/gymScan';
import { mockGymDetail, statefulGymsApi } from '../mocks/fixtures/gyms';
import {
  CARDIO_ROW_DRAFTS,
  LEG_CURL_DRAFTS,
  PHOTO0,
  mockIntakePhoto,
  mockScanIntake,
  statefulIntakeApi,
  toItems,
} from '../mocks/fixtures/intakes';
import { mockAiFeaturesView, mockBlockedFeatureView } from '../mocks/fixtures/aiFeatures';

const GYM_ID = '00000000-0000-4000-8000-a00000000777';
const SCANNER = {
  ...mockUser,
  permissions: [...mockUser.permissions, 'storage:write', 'intakes:read', 'intakes:write'],
};

function GymStandIn() {
  const location = useLocation();
  const state = (location.state ?? {}) as GymDetailLocationState;
  return (
    <div>
      <h1>Gym detail stand-in</h1>
      <p data-testid="nav-state">{JSON.stringify(state)}</p>
    </div>
  );
}

function renderScan(options: { user?: typeof mockUser; aiEnabled?: boolean } = {}) {
  return render(
    <Routes>
      <Route path="/gyms/:gymId" element={<GymStandIn />} />
      <Route path="/gyms/:gymId/scan" element={<GymScanPage />} />
    </Routes>,
    {
      wrapperOptions: {
        route: `/gyms/${GYM_ID}/scan`,
        user: options.user ?? SCANNER,
        aiEnabled: options.aiEnabled ?? true,
      },
    },
  );
}

const rows = () => screen.getAllByTestId('draft-item-row');
const row = (text: string) => {
  const match = rows().find((entry) => within(entry).queryAllByText(text).length > 0);
  if (!match) throw new Error(`No draft row with "${text}"`);
  return match;
};

function readyIntake(drafts = CARDIO_ROW_DRAFTS, extra: Parameters<typeof mockScanIntake>[1] = {}) {
  return mockScanIntake(GYM_ID, {
    status: 'ready',
    provider: 'openai',
    modelId: 'gpt-5-mini',
    photos: [mockIntakePhoto(PHOTO0, 'cardio-row-wide.jpg')],
    items: toItems(drafts),
    resultMeta: { promptVersion: 1, chunks: 1, photoCount: 1, ignoredObjects: ['fire extinguisher', 'window blinds'], failedChunks: [] },
    ...extra,
  });
}

describe('GymScanPage', () => {
  beforeEach(() => {
    clearPhotoUrlCache();
    statefulGymsApi([mockGymDetail({ id: GYM_ID, name: 'Home Gym' })]);
  });

  it('with AI off shows the notice and Continue manually returns to the picker', async () => {
    const api = statefulIntakeApi();
    const user = userEvent.setup();
    renderScan({ aiEnabled: false });

    expect(await screen.findByText('AI is turned off for this app')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue manually' }));
    expect(await screen.findByRole('heading', { name: 'Gym detail stand-in' })).toBeInTheDocument();
    expect(screen.getByTestId('nav-state')).toHaveTextContent('{"openPicker":true}');
    expect(api.calls).toEqual([]);
  });

  it('without an assigned model says so and creates no intake', async () => {
    const api = statefulIntakeApi();
    server.use(
      http.get('*/api/ai/features', () =>
        HttpResponse.json({ data: mockAiFeaturesView({ gym_scan: mockBlockedFeatureView('gym_scan', 'missing_capability', 'admin') }) }),
      ),
    );
    renderScan();
    expect(
      await screen.findByText("Your administrator hasn't assigned an AI model that can read photos yet."),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue manually' })).toBeInTheDocument();
    expect(api.calls).toEqual([]);
  });

  it('without storage:write explains why and offers the manual path', async () => {
    const api = statefulIntakeApi();
    renderScan({ user: { ...mockUser, permissions: [...mockUser.permissions, 'intakes:read', 'intakes:write'] } });
    expect(
      await screen.findByText('Scanning needs permission to upload photos, which your account does not have.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue manually' })).toBeInTheDocument();
    expect(api.calls).toEqual([]);
  });

  it('creates an intake for this gym and shows the Photos step', async () => {
    const api = statefulIntakeApi();
    renderScan();

    expect(await screen.findByTestId('gym-scan-photos')).toBeInTheDocument();
    expect(api.calls[0].path).toBe(`/intakes?kind=gym_equipment&subjectId=${GYM_ID}&status=draft%2Cscanning%2Cready&limit=1`);
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
      kind: 'gym_equipment',
      context: { gymId: GYM_ID },
      subjectType: 'gym',
      subjectId: GYM_ID,
    });
    expect(screen.getByText(SCAN_PHOTOS_HELPER)).toBeInTheDocument();
    expect(screen.getByText('Photos are sent to your AI provider. Avoid capturing people.')).toBeInTheDocument();
    expect(screen.getByTestId('ai-vision-disclosure')).toHaveTextContent(
      'These photos will be sent to openai (GPT-5 mini) using your own key.',
    );
    expect(screen.getByRole('button', { name: 'Scan' })).toBeDisabled();
  });

  it('resumes an unfinished scan, scans and shows the review (cardio row example)', async () => {
    const draft = mockScanIntake(GYM_ID, { photos: [mockIntakePhoto(PHOTO0, 'cardio-row-wide.jpg')] });
    const api = statefulIntakeApi([draft], { scanResult: CARDIO_ROW_DRAFTS, scanningReads: 1 });
    const user = userEvent.setup();
    renderScan();

    const scan = await screen.findByRole('button', { name: 'Scan' });
    await waitFor(() => expect(scan).toBeEnabled());
    expect(api.calls.some((c) => c.method === 'POST' && c.path === '/intakes')).toBe(false);

    await user.click(scan);
    expect(await screen.findByTestId('gym-scan-scanning')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Analyzing 1 photo in 1 request.');
    expect(screen.getByTestId('gym-scan-elapsed')).toHaveTextContent(/Elapsed 0:0\d/);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(api.calls.find((c) => c.path.endsWith('/analyze'))?.body).toEqual({});

    expect(await screen.findByTestId('gym-scan-review', {}, { timeout: 8000 })).toBeInTheDocument();
    expect(rows()).toHaveLength(4);

    const elliptical = row('Elliptical');
    expect(within(elliptical).getByText('×3')).toBeInTheDocument();
    expect(within(elliptical).getByText('count uncertain')).toBeInTheDocument();
    expect(within(elliptical).getByText('AI guess')).toBeInTheDocument();
    expect(within(elliptical).getByText('Medium confidence')).toBeInTheDocument();
    expect(within(elliptical).getByTestId('equipment-draft-brand')).toHaveTextContent('Precor');
    expect(within(elliptical).getByTestId('equipment-draft-brand')).toHaveTextContent(/evidence: No logo is readable/);

    expect(within(row('upright or recumbent (unclear)')).getByText('Matrix')).toBeInTheDocument();
    const unknown = row('Unidentified machine (partly out of frame)');
    expect(within(unknown).getByText('Low confidence')).toBeInTheDocument();
    expect(within(unknown).getByText('Not in the catalog')).toBeInTheDocument();

    expect(screen.queryByText(/extinguisher|blinds/i)).toBeNull();
  }, 15000);

  it('keeps Apply disabled while items are pending, then applies and returns with the summary', async () => {
    const api = statefulIntakeApi([readyIntake()], { applyResult: { created: 3, merged: 1, photosAttached: 1 } });
    const user = userEvent.setup();
    renderScan();

    const apply = await screen.findByRole('button', { name: 'Apply to gym' });
    expect(apply).toBeDisabled();
    expect(apply).toHaveAccessibleDescription(/4 items are still waiting for review/);

    await user.click(screen.getByRole('button', { name: 'Accept all (4)' }));
    const confirm = await screen.findByRole('dialog', { name: 'Accept all 4 items?' });
    expect(confirm).toHaveTextContent('1 item has low confidence');
    await user.click(within(confirm).getByRole('button', { name: 'Accept all' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply to gym' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Apply to gym' }));

    expect(await screen.findByRole('heading', { name: 'Gym detail stand-in' })).toBeInTheDocument();
    expect(screen.getByTestId('nav-state')).toHaveTextContent(
      JSON.stringify({ flash: '3 added, 1 already there. Photos saved to this gym.' }),
    );
    expect(api.calls.filter((c) => c.path.endsWith('/apply'))).toHaveLength(1);
  });

  it('edits, rejects and adds missing items', async () => {
    const api = statefulIntakeApi([readyIntake()]);
    const user = userEvent.setup();
    renderScan();
    await screen.findByTestId('gym-scan-review');

    // Edit the elliptical count 3 -> 4.
    const ellipticalRow = row('Elliptical');
    await user.click(within(ellipticalRow).getByRole('button', { name: 'Edit' }));
    const editor = within(ellipticalRow).getByTestId('equipment-draft-editor');
    expect(within(editor).getByRole('combobox', { name: 'Equipment' })).toHaveValue('Elliptical');
    await user.click(within(editor).getByRole('button', { name: 'Increase quantity' }));
    await user.click(within(ellipticalRow).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(within(row('Elliptical')).getByText('You verified')).toBeInTheDocument());
    const edited = row('Elliptical');
    const [current, original] = within(edited).getAllByTestId('equipment-draft-value');
    expect(within(current).getByText('×4')).toBeInTheDocument();
    expect(within(current).queryByText('count uncertain')).toBeNull();
    // "AI said: …" keeps what the AI proposed.
    expect(within(edited).getByTestId('draft-item-ai-said')).toContainElement(original);
    expect(within(original).getByText('×3')).toBeInTheDocument();
    expect(within(original).getByText('count uncertain')).toBeInTheDocument();
    const patch = api.calls.find((c) => c.method === 'PATCH')?.body as { value: { quantity: number; quantityUncertain: boolean } };
    expect(patch.value).toMatchObject({ quantity: 4, quantityUncertain: false, equipmentTypeSlug: 'elliptical' });

    // Reject the unidentified machine.
    await user.click(within(row('Unidentified machine (partly out of frame)')).getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('Rejected (1)')).toBeInTheDocument();

    // Add missing: Dumbbells x1 from the catalog.
    await user.click(screen.getByRole('button', { name: 'Add missing item' }));
    const add = screen.getByTestId('draft-item-add');
    await user.type(within(add).getByRole('combobox', { name: 'Equipment' }), 'dumb');
    await user.click(await screen.findByRole('option', { name: 'Dumbbells' }));
    await user.click(within(add).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path.endsWith('/items'))).toBe(true));
    const added = api.calls.find((c) => c.method === 'POST' && c.path.endsWith('/items'))?.body as {
      kind: string;
      value: { equipmentTypeSlug: string; name: string; quantity: number };
    };
    expect(added.kind).toBe('equipment');
    expect(added.value).toMatchObject({ equipmentTypeSlug: 'dumbbells', name: 'Dumbbells', quantity: 1 });
    expect(await screen.findByText('You added')).toBeInTheDocument();
  });

  it('shows the leg curl example with its high confidence, brand, configuration and targets', async () => {
    statefulIntakeApi([readyIntake(LEG_CURL_DRAFTS)]);
    renderScan();
    await screen.findByTestId('gym-scan-review');
    const legCurl = row('Leg curl machine');
    expect(within(legCurl).getByText('High confidence')).toBeInTheDocument();
    expect(within(legCurl).getByTestId('equipment-draft-brand')).toHaveTextContent('Precor');
    expect(within(legCurl).getByText('seated, selectorized')).toBeInTheDocument();
    expect(within(legCurl).getByText('Leg curl')).toBeInTheDocument();
    expect(within(legCurl).getByText('Targets hamstrings')).toBeInTheDocument();
  });

  it('warns about a batch that could not be analyzed and offers Try again', async () => {
    const api = statefulIntakeApi([
      readyIntake(CARDIO_ROW_DRAFTS, {
        resultMeta: {
          promptVersion: 1,
          chunks: 2,
          photoCount: 20,
          ignoredObjects: [],
          failedChunks: [{ index: 1, code: 'AI_PROVIDER_UNAVAILABLE', firstPhotoIndex: 16, lastPhotoIndex: 19 }],
        },
      }),
    ]);
    const user = userEvent.setup();
    renderScan();
    const warning = await screen.findByTestId('gym-scan-failed-chunk');
    expect(warning).toHaveTextContent('Photos 17-20 could not be analyzed.');
    await user.click(within(warning).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.calls.some((c) => c.path.endsWith('/analyze'))).toBe(true));
  });

  it('a failed scan shows the error with Try again and Continue manually', async () => {
    // A scan in progress when the page opens; the job then fails terminally.
    const api = statefulIntakeApi(
      [mockScanIntake(GYM_ID, { status: 'scanning', photos: [mockIntakePhoto(PHOTO0, 'cardio-row-wide.jpg')] })],
      { scanResult: { failed: { code: 'AI_STRUCTURED_OUTPUT_INVALID', message: 'The model answer did not match the schema.' } } },
    );
    const user = userEvent.setup();
    renderScan();

    const failed = await screen.findByTestId('gym-scan-failed', {}, { timeout: 5000 });
    expect(failed.querySelector('[data-ai-error-code="AI_STRUCTURED_OUTPUT_INVALID"]')).not.toBeNull();
    expect(within(failed).getByRole('button', { name: 'Continue manually' })).toBeInTheDocument();
    await user.click(within(failed).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.calls.some((c) => c.path.endsWith('/analyze'))).toBe(true));
  });

  it('Cancel while scanning discards the intake and returns to the gym', async () => {
    const intake = mockScanIntake(GYM_ID, {
      status: 'scanning',
      photos: [mockIntakePhoto(PHOTO0, 'cardio-row-wide.jpg')],
    });
    const api = statefulIntakeApi([intake], { scanningReads: 100 });
    const user = userEvent.setup();
    renderScan();

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel the scan?' });
    await user.click(within(dialog).getByRole('button', { name: 'Discard' }));

    expect(await screen.findByRole('heading', { name: 'Gym detail stand-in' })).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'DELETE' && c.path === `/intakes/${intake.id}`)).toBe(true);
  });

  it.each([
    ['review', () => readyIntake(), 'gym-scan-review'],
    ['photos', () => mockScanIntake(GYM_ID, { photos: [mockIntakePhoto(PHOTO0, 'cardio-row-wide.jpg')] }), 'gym-scan-photos'],
  ] as const)('the %s step has no axe violations', async (_step, intake, testId) => {
    statefulIntakeApi([intake()]);
    const { container } = renderScan();
    await screen.findByTestId(testId);
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
