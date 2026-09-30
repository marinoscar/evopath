/**
 * AdaptationReviewPage (E6.1): the live run (adapt stages, the provider wait,
 * Cancel) bound to the adaptation's runId, the refetch when the stream ends
 * and the review that follows; failure copy (the "try N+10" sentence),
 * cancelled, and 404. Against MSW with a fake run stream.
 */
import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor, within } from '../utils/test-utils';
import { server } from '../mocks/server';
import AdaptationReviewPage from '../../pages/AdaptationReviewPage';
import { fakeRunStream } from '../utils/fakeRunStream';
import { mockRun } from '../mocks/fixtures/programs';
import { ADAPTATION_ID, ADAPT_RUN_ID, adaptRunEvents, mockAdaptation } from '../mocks/fixtures/adaptations';
import type { AdaptationView } from '../../services/trainingAdaptation';
import { mockGymDetail, statefulGymsApi } from '../mocks/fixtures/gyms';

function serve(initial: AdaptationView) {
  let current = initial;
  let cancels = 0;
  server.use(
    http.get(`*/api/ai/training/adaptations/${ADAPTATION_ID}`, () => HttpResponse.json({ data: current })),
    http.post(`*/api/ai/training/adaptations/${ADAPTATION_ID}/cancel`, () => {
      cancels += 1;
      return HttpResponse.json({ data: current });
    }),
    http.get(`*/api/ai/training/runs/${ADAPT_RUN_ID}`, () =>
      HttpResponse.json({ data: mockRun({ id: ADAPT_RUN_ID, kind: 'adapt', status: 'running', startedAt: new Date().toISOString() }) }),
    ),
  );
  return { set: (next: Partial<AdaptationView>) => (current = { ...current, ...next }), cancels: () => cancels };
}

function renderPage(stream = fakeRunStream()) {
  render(
    <Routes>
      <Route
        path="/train/adapt/:adaptationId"
        element={<AdaptationReviewPage runOptions={{ connect: stream.connect, pollMs: 0, reconnectDelayMs: 0 }} previewDelayMs={0} />}
      />
    </Routes>,
    { wrapperOptions: { route: `/train/adapt/${ADAPTATION_ID}`, aiEnabled: true } },
  );
  return stream;
}

describe('AdaptationReviewPage', () => {
  it('follows the run through the adapt stages, then shows the review with focus on its heading', async () => {
    const api = serve(mockAdaptation({ status: 'running', proposal: null, criticReport: null, guardrailReport: null }));
    const stream = renderPage();
    await waitFor(() => expect(stream.connections).toHaveLength(1));
    expect(stream.connections[0].runId).toBe(ADAPT_RUN_ID);
    stream.open();
    const events = adaptRunEvents();

    stream.emit(...events.slice(0, 6));
    expect(screen.getByTestId('adapt-stage-context')).toHaveAttribute('data-state', 'done');
    expect(screen.getByTestId('adapt-stage-plan')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('status')).toHaveTextContent('Adapting the workout.');

    stream.emit(...events.slice(6, 11));
    expect(screen.getByTestId('adapt-stage-critique')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('status')).toHaveTextContent('The critic is reviewing the workout.');

    stream.emit(...events.slice(11));
    api.set({ status: 'ready', proposal: mockAdaptation().proposal, guardrailReport: mockAdaptation().guardrailReport, criticReport: mockAdaptation().criticReport });
    stream.end('succeeded');

    const heading = await screen.findByRole('heading', { name: 'Upper A, 30 minutes with dumbbells' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByRole('button', { name: 'Use for today only' })).toBeInTheDocument();
  });

  it('shows the provider wait and cancels', async () => {
    const api = serve(mockAdaptation({ status: 'queued', proposal: null }));
    const user = userEvent.setup();
    const stream = renderPage();
    await waitFor(() => expect(stream.connections).toHaveLength(1));
    stream.open();
    stream.emit(
      { seq: 1, type: 'run.started', data: {} },
      { seq: 2, type: 'stage.started', data: { node: 'context' } },
      { seq: 3, type: 'run.deferred', data: { retryAfterMs: 20_000 } },
    );
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for the provider, about 20 seconds.');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(api.cancels()).toBe(1));
  });

  it('explains a failure with the server sentence and offers the ways forward', async () => {
    serve(
      mockAdaptation({
        status: 'failed',
        proposal: null,
        errorCode: 'ADAPTATION_CANNOT_FIT',
        errorMessage: "Can't fit these lifts in 20 minutes; try 30",
      }),
    );
    renderPage();
    const failed = await screen.findByTestId('adapt-failed');
    expect(failed).toHaveTextContent("Can't fit these lifts in 20 minutes; try 30");
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start the planned workout instead' })).toHaveAttribute('href', '/train');
  });

  it('Adjust again from a cancelled adaptation opens the sheet with the last request', async () => {
    serve(mockAdaptation({ status: 'cancelled', proposal: null, request: { minutes: 30, useReadiness: true } }));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Adjust again' }));
    expect(await screen.findByRole('dialog', { name: "Adjust today's workout" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '30 minutes' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('says so when the adaptation is not the caller’s', async () => {
    server.use(
      http.get(`*/api/ai/training/adaptations/${ADAPTATION_ID}`, () =>
        HttpResponse.json({ statusCode: 404, message: 'Not found' }, { status: 404 }),
      ),
    );
    renderPage();
    expect(await screen.findByText(/does not exist, it expired, or it is not yours/)).toBeInTheDocument();
  });

  describe('a temporary gym applied as a plan change (E6.2)', () => {
    const HOTEL_ID = '00000000-0000-4000-8000-a00000000e62';

    it('asks "Save {name} for future use?" and saves it', async () => {
      const gyms = statefulGymsApi([
        mockGymDetail({ id: HOTEL_ID, name: 'Hotel gym Sep 30', type: 'hotel', isDefault: false, isTemporary: true }),
      ]);
      serve(mockAdaptation({ status: 'applied', appliedAs: 'plan_change', gymId: HOTEL_ID }));
      const user = userEvent.setup();
      renderPage();
      const prompt = await screen.findByRole('region', { name: 'Save Hotel gym Sep 30 for future use?' });
      expect(within(prompt).getByRole('heading', { level: 2 })).toBeInTheDocument();
      await user.click(within(prompt).getByRole('button', { name: 'Save gym' }));
      await user.click(within(prompt).getByRole('button', { name: 'Save' }));
      expect(await screen.findByTestId('save-gym-saved')).toBeInTheDocument();
      expect(gyms.gyms[0].isTemporary).toBe(false);
    });

    it('does not ask when the adaptation was used for today only', async () => {
      statefulGymsApi([
        mockGymDetail({ id: HOTEL_ID, name: 'Hotel gym Sep 30', type: 'hotel', isDefault: false, isTemporary: true }),
      ]);
      serve(mockAdaptation({ status: 'applied', appliedAs: 'one_off', gymId: HOTEL_ID }));
      renderPage();
      await screen.findByText('Used for today.');
      expect(screen.queryByTestId('save-gym-prompt')).toBeNull();
    });
  });
});
