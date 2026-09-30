/**
 * AdaptWorkoutSheet (E6.1): "Tell us what to change" before the round trip,
 * the debounced preview (base, models, what will be sent), the start
 * request and the hand-off to `/train/adapt/:id`, and the refusals
 * (`409 ADAPTATION_IN_PROGRESS`, `409 TRAINING_ROLE_UNAVAILABLE`). E6.2:
 * "Different place" (the hotel step) and `400
 * ADAPTATION_GYM_EQUIPMENT_UNCONFIRMED`. Against MSW.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useParams } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor, within } from '../../../utils/test-utils';
import { server } from '../../../mocks/server';
import { AdaptWorkoutSheet } from '../../../../components/training/adapt/AdaptWorkoutSheet';
import { LATEST_ADAPTATION_KEY, type AdaptationRequest } from '../../../../services/trainingAdaptation';
import { ADAPTATION_ID, ADAPT_RUN_ID, mockPreview, roleModel } from '../../../mocks/fixtures/adaptations';
import { mockGymDetail, statefulGymsApi } from '../../../mocks/fixtures/gyms';

function AdaptStandIn() {
  const { adaptationId } = useParams();
  return <h1>Adaptation {adaptationId}</h1>;
}

function renderSheet() {
  return render(
    <Routes>
      <Route path="/" element={<AdaptWorkoutSheet open onClose={() => {}} previewDelayMs={0} />} />
      <Route path="/train/adapt/:adaptationId" element={<AdaptStandIn />} />
    </Routes>,
    { wrapperOptions: { aiEnabled: true } },
  );
}

function servePreview(preview = mockPreview()) {
  const bodies: AdaptationRequest[] = [];
  server.use(
    http.post('*/api/ai/training/adaptations/context-preview', async ({ request }) => {
      bodies.push((await request.json()) as AdaptationRequest);
      return HttpResponse.json({ data: preview });
    }),
  );
  return bodies;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('AdaptWorkoutSheet', () => {
  it('opens with the title and asks what to change before sending anything', async () => {
    const previews = servePreview();
    let started = 0;
    server.use(
      http.post('*/api/ai/training/adaptations', () => {
        started += 1;
        return HttpResponse.json({ data: {} }, { status: 202 });
      }),
    );
    const user = userEvent.setup();
    renderSheet();
    expect(screen.getByRole('dialog', { name: "Adjust today's workout" })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Adjust workout' }));
    expect(await screen.findByTestId('adapt-invalid')).toHaveTextContent('Tell us what to change');
    expect(started).toBe(0);
    expect(previews).toHaveLength(0);
  });

  it('previews what will be sent once a chip changes, then starts and hands off to the adaptation page', async () => {
    const previews = servePreview();
    let sent: AdaptationRequest | null = null;
    server.use(
      http.post('*/api/ai/training/adaptations', async ({ request }) => {
        sent = (await request.json()) as AdaptationRequest;
        return HttpResponse.json(
          { data: { adaptationId: ADAPTATION_ID, jobId: 'job', runId: ADAPT_RUN_ID, status: 'queued' } },
          { status: 202 },
        );
      }),
    );
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole('button', { name: '30 minutes' }));
    expect(await screen.findByTestId('adapt-base')).toHaveTextContent('Adjusting Upper A');
    await waitFor(() => expect(previews.at(-1)).toMatchObject({ minutes: 30, useReadiness: true }));
    expect(screen.getByTestId('role-model-banner')).toHaveTextContent('Planner: Frontier One');

    await user.click(screen.getByRole('button', { name: 'What will be sent' }));
    expect(screen.getByText("Today's planned exercises (2)")).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: /Anything else/ }), 'tight hips');
    expect(screen.getByText('10/500')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Adjust workout' }));

    expect(await screen.findByRole('heading', { name: `Adaptation ${ADAPTATION_ID}` })).toBeInTheDocument();
    expect(sent).toMatchObject({ minutes: 30, freeText: 'tight hips', useReadiness: true });
    expect(JSON.parse(window.localStorage.getItem(LATEST_ADAPTATION_KEY) ?? '{}')).toMatchObject({ id: ADAPTATION_ID });
  });

  it('shows the safety guidance the preview returns', async () => {
    servePreview(
      mockPreview({ willCallProvider: false, blocked: { reason: 'urgent:chest_pain', guidance: 'Stop and seek medical care now.' } }),
    );
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole('button', { name: 'Low energy' }));
    expect(await screen.findByTestId('adapt-blocked')).toHaveTextContent('Stop and seek medical care now.');
  });

  it('disables the start while a role cannot run, and says how to fix it', async () => {
    servePreview(
      mockPreview({
        models: {
          planner: roleModel('planner', { state: 'no_key', runnable: false, model: null, fix: 'keys' }),
          critic: roleModel('critic'),
        },
        willCallProvider: false,
      }),
    );
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole('button', { name: '45 minutes' }));
    const problem = await screen.findByTestId('role-problem-planner');
    expect(within(problem).getByRole('link', { name: 'Add an AI key' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Adjust workout' })).toBeDisabled();
  });

  it('links to the adjustment already running on 409 ADAPTATION_IN_PROGRESS', async () => {
    servePreview();
    server.use(
      http.post('*/api/ai/training/adaptations', () =>
        HttpResponse.json(
          {
            statusCode: 409,
            message: 'An adaptation is already running',
            details: { reason: 'ADAPTATION_IN_PROGRESS', adaptationId: ADAPTATION_ID, status: 'running', runId: ADAPT_RUN_ID },
          },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole('button', { name: '20 minutes' }));
    await user.click(screen.getByRole('button', { name: 'Adjust workout' }));
    const problem = await screen.findByTestId('adapt-problem');
    expect(problem).toHaveTextContent('An adjustment is already running');
    expect(within(problem).getByRole('link', { name: 'Open it' })).toHaveAttribute('href', `/train/adapt/${ADAPTATION_ID}`);
  });

  it('names the role on 409 TRAINING_ROLE_UNAVAILABLE', async () => {
    servePreview();
    server.use(
      http.post('*/api/ai/training/adaptations', () =>
        HttpResponse.json(
          { statusCode: 409, message: 'Role unavailable', details: { reason: 'TRAINING_ROLE_UNAVAILABLE', role: 'critic', state: 'missing_capability', fix: 'settings' } },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole('button', { name: '15 minutes' }));
    await user.click(screen.getByRole('button', { name: 'Adjust workout' }));
    const problem = await screen.findByTestId('adapt-problem');
    expect(problem).toHaveTextContent("Critic: this model can't return structured output.");
    expect(within(problem).getByRole('link', { name: 'Choose a model' })).toBeInTheDocument();
  });

  it('Different place opens the hotel step and comes back with the temporary gym selected', async () => {
    servePreview();
    const gyms = statefulGymsApi([mockGymDetail({ name: 'Home Gym', isDefault: true })]);
    let sent: AdaptationRequest | null = null;
    server.use(
      http.post('*/api/ai/training/adaptations', async ({ request }) => {
        sent = (await request.json()) as AdaptationRequest;
        return HttpResponse.json(
          { data: { adaptationId: ADAPTATION_ID, jobId: 'job', runId: ADAPT_RUN_ID, status: 'queued' } },
          { status: 202 },
        );
      }),
    );
    const user = userEvent.setup();
    render(
      <Routes>
        <Route path="/" element={<AdaptWorkoutSheet open onClose={() => {}} previewDelayMs={0} />} />
        <Route path="/train/adapt/:adaptationId" element={<AdaptStandIn />} />
      </Routes>,
      // AI on for the sheet; this user cannot upload, so the step offers the manual ways only.
      { wrapperOptions: { aiEnabled: true } },
    );

    await user.click(await screen.findByRole('combobox', { name: 'Gym' }));
    await user.click(await screen.findByRole('option', { name: 'Different place (scan a new gym)' }));
    expect(await screen.findByRole('heading', { level: 3, name: 'Scan a new gym' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Adjust workout' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Pick equipment manually' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add equipment' })).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Bodyweight only' }));

    const temp = gyms.gyms.find((g) => g.isTemporary);
    expect(temp).toMatchObject({ type: 'hotel', isDefault: false });
    const gymSelect = await screen.findByRole('combobox', { name: 'Gym' });
    await waitFor(() => expect(gymSelect).toHaveTextContent(`${temp?.name} (temporary)`));
    expect(screen.getByText('A temporary gym. After the workout you can save it for future use.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bodyweight only', pressed: true })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Adjust workout' }));
    expect(await screen.findByRole('heading', { name: `Adaptation ${ADAPTATION_ID}` })).toBeInTheDocument();
    expect(sent).toMatchObject({ gymId: temp?.id, equipment: { mode: 'bodyweight' } });
  });

  it('explains 400 ADAPTATION_GYM_EQUIPMENT_UNCONFIRMED', async () => {
    servePreview();
    server.use(
      http.post('*/api/ai/training/adaptations', () =>
        HttpResponse.json(
          {
            statusCode: 400,
            message: 'Confirm the equipment first',
            details: { reason: 'ADAPTATION_GYM_EQUIPMENT_UNCONFIRMED' },
          },
          { status: 400 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole('button', { name: '20 minutes' }));
    await user.click(screen.getByRole('button', { name: 'Adjust workout' }));
    const problem = await screen.findByTestId('adapt-problem');
    expect(problem).toHaveTextContent('Confirm the equipment first');
    expect(problem).toHaveTextContent('Choose Different place to scan it or add equipment, or choose Bodyweight only.');
  });
});
