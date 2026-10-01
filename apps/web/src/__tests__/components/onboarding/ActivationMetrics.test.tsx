/**
 * `ActivationMetrics` + `useOnboardingMetrics` (#212): tile text, the empty
 * cohort, the window toggle (?days=, stale responses dropped), error + Retry,
 * and the step list.
 */
import { describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor, within } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { ActivationMetrics, formatHours, formatRate } from '../../../components/onboarding/ActivationMetrics';
import type { OnboardingMetrics } from '../../../types';

function metrics(overrides: Partial<OnboardingMetrics> = {}): OnboardingMetrics {
  return {
    windowDays: 30,
    activationWindowDays: 7,
    cohortSize: 40,
    eligible: 20,
    activated: 6,
    activationRate: 0.3,
    medianHoursToFirstWorkout: 5.5,
    steps: [
      { id: 'health_profile', completed: 30, rate: 0.75 },
      { id: 'gym', completed: 20, rate: 0.5 },
      { id: 'first_workout', completed: 12, rate: 0.3 },
      { id: 'ai_plan', completed: 0, rate: 0 },
    ],
    ...overrides,
  };
}

function serve(data: OnboardingMetrics) {
  const requested: string[] = [];
  server.use(
    http.get('*/api/admin/onboarding/metrics', ({ request }) => {
      requested.push(new URL(request.url).searchParams.get('days') ?? '');
      return HttpResponse.json({ data });
    }),
  );
  return requested;
}

const tile = (label: string | RegExp) => screen.getByText(label).closest('div')!;

describe('formatters', () => {
  it('formats rates and hours', () => {
    expect(formatRate(0.304)).toBe('30%');
    expect(formatRate(null)).toBeNull();
    expect(formatHours(null)).toBeNull();
    expect(formatHours(0.4)).toBe('Under 1 hour');
    expect(formatHours(1)).toBe('1 hour');
    expect(formatHours(5.55)).toBe('5.6 hours');
    expect(formatHours(47)).toBe('47 hours');
    expect(formatHours(72)).toBe('3 days');
  });
});

describe('ActivationMetrics', () => {
  it('renders tiles as text: rate, "X of N eligible", median in hours', async () => {
    const requested = serve(metrics());
    render(<ActivationMetrics />);
    expect(screen.getByRole('heading', { level: 2, name: 'Activation' })).toBeInTheDocument();

    expect(await screen.findByText('30%')).toBeInTheDocument();
    expect(requested[0]).toBe('30');
    expect(screen.getByText('40')).toBeInTheDocument();
    expect(screen.getByText('Signed up in the last 30 days')).toBeInTheDocument();
    expect(screen.getByText('Activation rate (7-day)')).toBeInTheDocument();
    expect(screen.getByText('6 of 20 eligible users logged a workout within 7 days')).toBeInTheDocument();
    expect(screen.getByText('5.5 hours')).toBeInTheDocument();
  });

  it('formats a long median in days and a singular eligible user', async () => {
    serve(metrics({ eligible: 1, activated: 1, activationRate: 1, medianHoursToFirstWorkout: 96 }));
    render(<ActivationMetrics />);
    expect(await screen.findByText('100%')).toBeInTheDocument();
    expect(screen.getByText('1 of 1 eligible user logged a workout within 7 days')).toBeInTheDocument();
    expect(screen.getByText('4 days')).toBeInTheDocument();
  });

  it('says no one has passed their first 7 days when nobody is eligible', async () => {
    serve(metrics({ eligible: 0, activated: 0, activationRate: null, medianHoursToFirstWorkout: null }));
    render(<ActivationMetrics />);
    expect(await screen.findByText('Not yet')).toBeInTheDocument();
    expect(screen.getByText('No one has passed their first 7 days yet')).toBeInTheDocument();
    expect(screen.getByText('No workouts yet')).toBeInTheDocument();
    expect(screen.getByText('No new user has logged a workout')).toBeInTheDocument();
  });

  it('shows the empty cohort message and no tiles', async () => {
    serve(metrics({ cohortSize: 0, eligible: 0, steps: [] }));
    render(<ActivationMetrics />);
    expect(await screen.findByText('No new users in this window.')).toBeInTheDocument();
    expect(screen.queryByText('Activation rate (7-day)')).not.toBeInTheDocument();
  });

  it('lists each step with text counts and aria-labelled progress bars', async () => {
    serve(metrics());
    render(<ActivationMetrics />);
    const list = await screen.findByRole('list', { name: 'Steps completed by new users' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(within(items[0]).getByText('Completed the health profile')).toBeInTheDocument();
    expect(within(items[0]).getByText('30 of 40, 75%')).toBeInTheDocument();
    expect(within(items[3]).getByText('0 of 40, 0%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Added a gym: 20 of 40, 50%' })).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByRole('progressbar', { name: 'Created an AI plan and met the coach: 0 of 40, 0%' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Logged a first workout: 12 of 40, 30%' })).toBeInTheDocument();
  });

  it('switching the window requests ?days= for it', async () => {
    const requested = serve(metrics());
    const user = userEvent.setup();
    render(<ActivationMetrics />);
    await screen.findByText('30%');

    await user.click(screen.getByRole('button', { name: 'Last 7 days' }));
    await waitFor(() => expect(requested).toContain('7'));
    await user.click(screen.getByRole('button', { name: 'Last 90 days' }));
    await waitFor(() => expect(requested).toContain('90'));
    expect(screen.getByRole('button', { name: 'Last 90 days' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('drops a stale response for a window the viewer has left', async () => {
    let releaseSlow: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    server.use(
      http.get('*/api/admin/onboarding/metrics', async ({ request }) => {
        const days = Number(new URL(request.url).searchParams.get('days'));
        if (days === 30) {
          await gate;
          return HttpResponse.json({ data: metrics({ windowDays: 30, cohortSize: 111 }) });
        }
        return HttpResponse.json({ data: metrics({ windowDays: 7, cohortSize: 222 }) });
      }),
    );
    const user = userEvent.setup();
    render(<ActivationMetrics />);
    await user.click(screen.getByRole('button', { name: 'Last 7 days' }));
    expect(await screen.findByText('222')).toBeInTheDocument();

    releaseSlow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.getByText('222')).toBeInTheDocument();
    expect(screen.queryByText('111')).not.toBeInTheDocument();
  });

  it('shows the error with Retry, which re-reads', async () => {
    let fail = true;
    server.use(
      http.get('*/api/admin/onboarding/metrics', () =>
        fail
          ? HttpResponse.json({ statusCode: 500, code: 'INTERNAL', message: 'Metrics are down' }, { status: 500 })
          : HttpResponse.json({ data: metrics() }),
      ),
    );
    const user = userEvent.setup();
    render(<ActivationMetrics />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Metrics are down');

    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('30%')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
