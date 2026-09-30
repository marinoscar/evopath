/**
 * The "Adjust today's workout" entry (E6.1): hidden with a one-line reason
 * when AI is off or the role lacks `ai:use`; opens the sheet otherwise; and
 * the "Adjusted workout ready" chip for a ready, unapplied adaptation this
 * browser started in the last 24 hours. The Today card keeps Start workout
 * whatever the entry shows.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor, mockUser } from '../../../utils/test-utils';
import { server } from '../../../mocks/server';
import {
  AdjustWorkoutEntry,
  RESUME_CHIP_LABEL,
} from '../../../../components/training/adapt/AdjustWorkoutEntry';
import { TodayWorkout } from '../../../../components/today/TodayWorkout';
import { LATEST_ADAPTATION_KEY, rememberAdaptation } from '../../../../services/trainingAdaptation';
import { ADAPTATION_ID, mockAdaptation } from '../../../mocks/fixtures/adaptations';

const noAi = { ...mockUser, permissions: mockUser.permissions.filter((p) => p !== 'ai:use') };

function serveAdaptation(view = mockAdaptation()) {
  let calls = 0;
  server.use(
    http.get(`*/api/ai/training/adaptations/${view.id}`, () => {
      calls += 1;
      return HttpResponse.json({ data: view });
    }),
  );
  return () => calls;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('AdjustWorkoutEntry', () => {
  it('says "AI is off" instead of the button while AI is off', () => {
    render(<AdjustWorkoutEntry />, { wrapperOptions: { aiEnabled: false } });
    expect(screen.getByTestId('adjust-unavailable')).toHaveTextContent("Adjust today's workout: AI is off");
    expect(screen.queryByRole('button', { name: "Adjust today's workout" })).toBeNull();
  });

  it('says the role cannot use AI without ai:use', () => {
    render(<AdjustWorkoutEntry />, { wrapperOptions: { aiEnabled: true, user: noAi } });
    expect(screen.getByTestId('adjust-unavailable')).toHaveTextContent("Your role can't use AI");
    expect(screen.queryByRole('button', { name: "Adjust today's workout" })).toBeNull();
  });

  it('opens the sheet', async () => {
    const user = userEvent.setup();
    render(<AdjustWorkoutEntry />, { wrapperOptions: { aiEnabled: true } });
    await user.click(screen.getByRole('button', { name: "Adjust today's workout" }));
    expect(await screen.findByRole('dialog', { name: "Adjust today's workout" })).toBeInTheDocument();
  });

  it('offers the resume chip for a ready, unapplied adaptation', async () => {
    serveAdaptation();
    rememberAdaptation(ADAPTATION_ID);
    render(<AdjustWorkoutEntry showResume />, { wrapperOptions: { aiEnabled: true } });
    const chip = await screen.findByRole('link', { name: RESUME_CHIP_LABEL });
    expect(chip).toHaveAttribute('href', `/train/adapt/${ADAPTATION_ID}`);
  });

  it('forgets an adaptation that was applied, and never asks without a remembered id', async () => {
    const calls = serveAdaptation(mockAdaptation({ status: 'applied', appliedAs: 'one_off' }));
    rememberAdaptation(ADAPTATION_ID);
    render(<AdjustWorkoutEntry showResume />, { wrapperOptions: { aiEnabled: true } });
    await waitFor(() => expect(calls()).toBe(1));
    await waitFor(() => expect(window.localStorage.getItem(LATEST_ADAPTATION_KEY)).toBeNull());
    expect(screen.queryByRole('link', { name: RESUME_CHIP_LABEL })).toBeNull();
  });

  it('drops a remembered id older than 24 hours without a request', async () => {
    const calls = serveAdaptation();
    rememberAdaptation(ADAPTATION_ID, Date.now() - 25 * 60 * 60_000);
    render(<AdjustWorkoutEntry showResume />, { wrapperOptions: { aiEnabled: true } });
    expect(screen.getByRole('button', { name: "Adjust today's workout" })).toBeInTheDocument();
    await waitFor(() => expect(window.localStorage.getItem(LATEST_ADAPTATION_KEY)).toBeNull());
    expect(calls()).toBe(0);
  });

  it('never replaces Start workout on the Today card', async () => {
    server.use(
      http.get('*/api/workouts/summary', () =>
        HttpResponse.json({ data: { inProgress: null, last: null, thisWeek: { workoutCount: 0, weekStart: '2026-09-28' }, daysSinceLast: null } }),
      ),
    );
    render(<TodayWorkout />, { wrapperOptions: { aiEnabled: false } });
    expect(await screen.findByRole('button', { name: 'Start workout' })).toBeInTheDocument();
    expect(screen.getByTestId('adjust-unavailable')).toHaveTextContent('AI is off');
  });
});
