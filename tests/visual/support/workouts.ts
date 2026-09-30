import type { Page } from '@playwright/test';
import { GYM_NAME } from './gyms';
import { FIXED_NOW } from './health';

/**
 * Fixture API for the Today "Today's workout" card (E4.6):
 * `GET /api/workouts/summary?today=...`, the `WorkoutSummary` view.
 *
 * The harness (`apps/web/visual/main.tsx`) has no API behind it, so without
 * this the card would land on whichever of its skeleton, "Couldn't load
 * training" or content states the fetch happened to reach. The approach of
 * `support/health.ts` and `support/gyms.ts`: `page.route()`, anything else
 * falls through to the harness's Vite server.
 *
 * Every date is a pure function of {@link FIXED_NOW} (2026-09-29, a Tuesday),
 * which specs pin with `page.clock.setFixedTime`, so "Yesterday" never moves.
 * The answer ignores the `?today=` the app sends: the summary is fixed.
 *
 * Variants:
 *   - `last` (default): no workout in progress; "Push day" yesterday at the
 *     gyms mock's gym, three top lifts, two workouts this week. The card shows
 *     the Start workout button, the last workout and "This week: 2 workouts".
 *   - `inProgress`: the same plus a workout in progress started 25 minutes
 *     before {@link FIXED_NOW} (the card shows Resume workout).
 *   - `empty`: no workouts at all ("No workouts yet.").
 *
 * Weights are kilograms, as the API speaks them; the health mock's profile is
 * imperial, so the card prints pounds.
 */

export type WorkoutsVariant = 'last' | 'inProgress' | 'empty';

const DAY_MS = 24 * 60 * 60 * 1000;
const dateOnly = (msAgo: number) => new Date(FIXED_NOW - msAgo).toISOString().slice(0, 10);

const GYM_REF = { id: '00000000-0000-4000-a000-000000000001', name: GYM_NAME };

/** Monday of the ISO week containing {@link FIXED_NOW} (a Tuesday). */
const WEEK_START = dateOnly(1 * DAY_MS);

const LAST = {
  id: '00000000-0000-4000-b000-000000000001',
  name: 'Push day',
  date: dateOnly(1 * DAY_MS),
  durationSeconds: 62 * 60,
  gym: GYM_REF,
  exerciseCount: 5,
  setCount: 15,
  volumeKg: 4200,
  topLifts: [
    { exerciseName: 'Bench Press', weightKg: 90, reps: 5 },
    { exerciseName: 'Overhead Press', weightKg: 55, reps: 8 },
    { exerciseName: 'Incline Dumbbell Press', weightKg: 30, reps: 10 },
  ],
};

const IN_PROGRESS = {
  id: '00000000-0000-4000-b000-000000000002',
  name: 'Pull day',
  startedAt: new Date(FIXED_NOW - 25 * 60 * 1000).toISOString(),
  gym: GYM_REF,
  exerciseCount: 4,
  completedSetCount: 6,
};

function summary(variant: WorkoutsVariant) {
  if (variant === 'empty') {
    return { inProgress: null, last: null, thisWeek: { workoutCount: 0, weekStart: WEEK_START }, daysSinceLast: null };
  }
  return {
    inProgress: variant === 'inProgress' ? IN_PROGRESS : null,
    last: LAST,
    thisWeek: { workoutCount: 2, weekStart: WEEK_START },
    daysSinceLast: 1,
  };
}

/** Answer `GET /api/workouts/summary` with `variant`. Call before `page.goto()`. */
export async function mockWorkoutsApi(page: Page, variant: WorkoutsVariant = 'last'): Promise<void> {
  await page.route('**/api/workouts/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/workouts/summary' && route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: summary(variant) }),
      });
    }
    return route.fallback();
  });
}
