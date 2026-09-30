/**
 * HotelGymScanStep (E6.2): "Different place" in the adjust-workout sheet.
 * The vision gates with the manual alternatives (AI off, no vision model),
 * the viewer without `storage:write`, a scan that finds equipment (E3's own
 * scan steps on a new temporary gym, capped at 6 photos), a scan that finds
 * nothing (Continue stays disabled), storage not configured, and the
 * 50-gym limit. Against the stateful MSW gyms and intake APIs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, screen, waitFor, within, mockUser } from '../../../utils/test-utils';
import { server } from '../../../mocks/server';
import {
  CONTINUE_HINT,
  HOTEL_PHOTOS_HELPER,
  HotelGymScanStep,
  type HotelGymResult,
} from '../../../../components/training/adapt/HotelGymScanStep';
import { clearPhotoUrlCache } from '../../../../components/intake/StoragePhotoThumb';
import { GYM_LIMIT_MESSAGE } from '../../../../services/gyms';
import { mockAiFeaturesView, mockBlockedFeatureView } from '../../../mocks/fixtures/aiFeatures';
import { DUMBBELLS, mockEquipment, mockGymDetail, statefulGymsApi } from '../../../mocks/fixtures/gyms';
import {
  CARDIO_ROW_DRAFTS,
  PHOTO0,
  mockIntakePhoto,
  mockScanIntake,
  statefulIntakeApi,
  toItems,
  type IntakeApiState,
} from '../../../mocks/fixtures/intakes';
import type { GymsApiState } from '../../../mocks/fixtures/gyms';
import type { GymScanContext } from '../../../../services/gymScan';

const SCANNER = {
  ...mockUser,
  permissions: [...mockUser.permissions, 'storage:write', 'intakes:read', 'intakes:write'],
};

function renderStep(options: { user?: typeof mockUser; aiEnabled?: boolean } = {}) {
  const onDone = vi.fn<(result: HotelGymResult) => void>();
  const onBack = vi.fn();
  const view = render(<HotelGymScanStep onDone={onDone} onBack={onBack} />, {
    wrapperOptions: { user: options.user ?? SCANNER, aiEnabled: options.aiEnabled ?? true },
  });
  return { ...view, onDone, onBack };
}

const createCall = (api: GymsApiState) => api.calls.find((c) => c.method === 'POST' && c.path === '/gyms');

/**
 * New intakes of this test start `ready` with the given drafts, as if the
 * photos were uploaded and the scan ran (the upload path is E3's, covered by
 * the scan page's own tests). Apply writes the accepted items to the gym.
 */
function readyOnCreate(intakes: IntakeApiState, gyms: GymsApiState, drafts = CARDIO_ROW_DRAFTS) {
  server.use(
    http.post('*/api/intakes', async ({ request }) => {
      const body = (await request.json()) as { context: GymScanContext; subjectId?: string };
      intakes.calls.push({ method: 'POST', path: '/intakes', body });
      const intake = mockScanIntake(body.context.gymId, {
        subjectId: body.subjectId ?? null,
        status: 'ready',
        provider: 'openai',
        modelId: 'gpt-5-mini',
        photos: drafts.length ? [mockIntakePhoto(PHOTO0, 'room.jpg')] : [],
        items: toItems(drafts),
        resultMeta: { promptVersion: 1, chunks: 1, photoCount: 1, ignoredObjects: [], failedChunks: [] },
      });
      intakes.intakes.push(intake);
      return HttpResponse.json({ data: intake }, { status: 201 });
    }),
    http.post('*/api/intakes/:id/apply', async ({ params }) => {
      const intake = intakes.intakes.find((i) => i.id === params.id);
      if (!intake) return HttpResponse.json({ message: 'nope' }, { status: 404 });
      intake.status = 'applied';
      const gym = gyms.gyms.find((g) => g.id === intake.context?.gymId);
      const accepted = intake.items.filter((i) => i.status === 'accepted');
      if (gym) for (let n = 0; n < accepted.length; n += 1) gym.equipment.push(mockEquipment(DUMBBELLS, { gymId: gym.id }));
      return HttpResponse.json({
        data: { gymId: gym?.id ?? '', created: accepted.length, merged: 0, photosAttached: intake.photos.length },
      });
    }),
  );
}

describe('HotelGymScanStep', () => {
  beforeEach(() => {
    clearPhotoUrlCache();
  });

  it('with AI off offers the manual path: a temporary hotel gym, equipment by hand, then Continue', async () => {
    const gyms = statefulGymsApi([mockGymDetail({ name: 'Home Gym' })]);
    const intakes = statefulIntakeApi();
    const user = userEvent.setup();
    const { onDone } = renderStep({ aiEnabled: false });

    expect(await screen.findByText('AI is turned off for this app')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Scan a new gym' })).toBeInTheDocument();
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toMatch(/^Hotel gym [A-Z][a-z]{2} \d{1,2}$/);
    await user.clear(screen.getByRole('textbox', { name: 'Name' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Lisbon hotel');

    await user.click(screen.getByRole('button', { name: 'Continue manually' }));
    const picker = await screen.findByRole('dialog', { name: 'Add equipment' });
    expect(createCall(gyms)?.body).toEqual({ name: 'Lisbon hotel', type: 'hotel', isTemporary: true });
    const created = gyms.gyms.find((g) => g.name === 'Lisbon hotel');
    expect(created).toMatchObject({ isTemporary: true, isDefault: false });

    await user.type(within(picker).getByRole('textbox', { name: 'Search equipment' }), 'dumb');
    const results = await within(picker).findByRole('list', { name: 'Search results' });
    await user.click(await within(results).findByRole('button', { name: /Dumbbells/ }));
    await user.click(within(picker).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(await screen.findByRole('listitem')).toHaveTextContent('Dumbbells');
    const next = screen.getByRole('button', { name: 'Continue' });
    await waitFor(() => expect(next).toBeEnabled());
    await user.click(next);
    expect(onDone).toHaveBeenCalledWith({ gym: expect.objectContaining({ id: created?.id }), bodyweight: false });
    expect(intakes.calls).toEqual([]);
  });

  it('keeps Continue disabled on an empty gym and offers Bodyweight only', async () => {
    statefulGymsApi([]);
    const user = userEvent.setup();
    const { onDone } = renderStep({ aiEnabled: false });
    await user.click(await screen.findByRole('button', { name: 'Continue manually' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(await screen.findByTestId('hotel-no-equipment')).toBeInTheDocument();
    const next = screen.getByRole('button', { name: 'Continue' });
    expect(next).toBeDisabled();
    expect(next).toHaveAccessibleDescription(CONTINUE_HINT);
    await user.click(screen.getByRole('button', { name: 'Bodyweight only' }));
    expect(onDone).toHaveBeenCalledWith({ gym: expect.objectContaining({ isTemporary: true }), bodyweight: true });
  });

  it('without a vision model names the problem and creates nothing until a manual choice', async () => {
    const gyms = statefulGymsApi([]);
    const intakes = statefulIntakeApi();
    server.use(
      http.get('*/api/ai/features', () =>
        HttpResponse.json({
          data: mockAiFeaturesView({ gym_scan: mockBlockedFeatureView('gym_scan', 'missing_capability', 'admin') }),
        }),
      ),
    );
    const user = userEvent.setup();
    const { onDone } = renderStep();
    expect(
      await screen.findByText("Your administrator hasn't assigned an AI model that can read photos yet."),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take photos' })).toBeNull();

    // Bodyweight only before any gym was made: no gym at all.
    await user.click(screen.getByRole('button', { name: 'Bodyweight only' }));
    expect(onDone).toHaveBeenCalledWith({ gym: null, bodyweight: true });
    expect(createCall(gyms)).toBeUndefined();
    expect(intakes.calls).toEqual([]);
  });

  it('tells a viewer without storage:write why, keeps the manual path and asks no AI question', async () => {
    statefulGymsApi([]);
    let aiModelReads = 0;
    server.use(
      http.get('*/api/ai/features', () => {
        aiModelReads += 1;
        return HttpResponse.json({ data: mockAiFeaturesView() });
      }),
    );
    renderStep({ user: { ...mockUser, permissions: [...mockUser.permissions, 'intakes:read', 'intakes:write'] } });

    const notice = await screen.findByTestId('hotel-scan-unavailable');
    expect(notice).toHaveTextContent('Scanning needs permission to upload photos, which your account does not have.');
    expect(notice).toHaveTextContent('You can still pick the equipment yourself, or train with bodyweight only.');
    expect(screen.getByRole('button', { name: 'Pick equipment manually' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bodyweight only' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take photos' })).toBeNull();
    expect(aiModelReads).toBe(0);
  });

  it('scans a new temporary gym with E3 steps (6 photos, privacy note), applies and continues', async () => {
    const gyms = statefulGymsApi([]);
    const intakes = statefulIntakeApi();
    readyOnCreate(intakes, gyms);
    const user = userEvent.setup();
    const { onDone } = renderStep();

    await user.click(await screen.findByRole('button', { name: 'Take photos' }));
    await screen.findByTestId('gym-scan-review');
    const gym = gyms.gyms[0];
    expect(createCall(gyms)?.body).toMatchObject({ type: 'hotel', isTemporary: true });
    expect(gym).toMatchObject({ isTemporary: true, isDefault: false });
    expect(intakes.calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      kind: 'gym_equipment',
      context: { gymId: gym.id },
    });
    // Step titles sit under the step's own h3.
    expect(screen.getByRole('heading', { level: 4, name: 'Review what the AI found' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Accept all (4)' }));
    const confirm = await screen.findByRole('dialog', { name: 'Accept all 4 items?' });
    await user.click(within(confirm).getByRole('button', { name: 'Accept all' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply to gym' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Apply to gym' }));

    expect(await screen.findByRole('heading', { level: 3, name: 'Confirm the equipment' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('4 added. Photos saved to this gym.');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onDone).toHaveBeenCalledWith({ gym: expect.objectContaining({ id: gym.id }), bodyweight: false });
    expect(onDone.mock.calls[0][0].gym?.equipment).toHaveLength(4);
  });

  it('shows the 6-photo cap and the provider in the privacy note on the Photos step', async () => {
    statefulGymsApi([]);
    statefulIntakeApi();
    const user = userEvent.setup();
    const { container } = renderStep();
    await user.click(await screen.findByRole('button', { name: 'Take photos' }));
    expect(await screen.findByTestId('gym-scan-photos')).toBeInTheDocument();
    expect(screen.getByText(HOTEL_PHOTOS_HELPER)).toBeInTheDocument();
    expect(
      screen.getByText('These photos are sent to openai to identify equipment. Nothing else is sent. Avoid capturing people.'),
    ).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a scan that finds nothing leaves Continue disabled until equipment is added or Bodyweight only', async () => {
    const gyms = statefulGymsApi([]);
    const intakes = statefulIntakeApi();
    readyOnCreate(intakes, gyms, []);
    const user = userEvent.setup();
    const { onDone } = renderStep();
    await user.click(await screen.findByRole('button', { name: 'Take photos' }));
    await screen.findByTestId('gym-scan-review');
    await user.click(screen.getByRole('button', { name: 'Apply to gym' }));

    expect(await screen.findByTestId('hotel-no-equipment')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add equipment' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Bodyweight only' }));
    expect(onDone).toHaveBeenCalledWith({ gym: expect.objectContaining({ id: gyms.gyms[0].id }), bodyweight: true });
  });

  it('explains storage that is not set up and keeps Continue manually', async () => {
    statefulGymsApi([]);
    server.use(
      http.get('*/api/intakes', () => HttpResponse.json({ data: [] })),
      http.post('*/api/intakes', () =>
        HttpResponse.json(
          {
            statusCode: 503,
            message: 'Object storage is not configured',
            code: 'SERVICE_UNAVAILABLE',
            details: { reason: 'storage_not_configured' },
          },
          { status: 503 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderStep();
    await user.click(await screen.findByRole('button', { name: 'Take photos' }));
    expect(await screen.findByText("File storage isn't available")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue manually' }));
    expect(await screen.findByRole('dialog', { name: 'Add equipment' })).toBeInTheDocument();
  });

  it('explains the 50-gym limit with a link to the gyms page', async () => {
    statefulGymsApi([]);
    server.use(
      http.post('*/api/gyms', () =>
        HttpResponse.json(
          {
            statusCode: 400,
            message: 'You can have at most 50 gyms',
            code: 'BAD_REQUEST',
            details: { reason: 'GYM_LIMIT', max: 50 },
          },
          { status: 400 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderStep({ aiEnabled: false });
    await user.click(await screen.findByRole('button', { name: 'Continue manually' }));
    const problem = await screen.findByTestId('hotel-problem');
    expect(problem).toHaveTextContent(GYM_LIMIT_MESSAGE);
    expect(within(problem).getByRole('link', { name: 'Open gyms' })).toHaveAttribute('href', '/gyms');
  });

  it('Back hands the gym made so far back to the sheet', async () => {
    statefulGymsApi([]);
    const user = userEvent.setup();
    const { onBack } = renderStep({ aiEnabled: false });
    await user.click(await screen.findByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledWith(null);
  });
});
