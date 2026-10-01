/**
 * Activity goals fixtures (#268): goals, templates, progress and a stateful
 * MSW stand-in for `/api/goals*` and `/api/activity-entries` that follows the
 * binding contract (epic #260): status filters, If-Match on PATCH (`428
 * IF_MATCH_REQUIRED` when missing, `412 GOAL_VERSION_MISMATCH` when stale),
 * `409 GOAL_ARCHIVED` on editing an archived goal, `409
 * GOAL_ILLEGAL_TRANSITION` (a transition to the current state is a no-op),
 * `409 GOAL_LIMIT_REACHED` past ten active goals, `400
 * ENTRY_DATE_OUT_OF_RANGE` with `today` set, and progress that counts posted
 * entries (a much simplified version of the server's matching: an "any
 * workout" goal counts `workout_any` entries, manual or workout-derived).
 */
import { http, HttpResponse } from 'msw';
import { server } from '../server';
import type {
  ActivityEntry,
  Goal,
  GoalHistoryPeriod,
  GoalProgress,
  GoalTemplate,
} from '../../../services/goals';

const API = '*/api';

let seq = 0;
const uuid = () => {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
};

export const GOAL_TEMPLATES: GoalTemplate[] = [
  { key: 'walk_4x_week', title: 'Walk 4 times a week', activityKind: 'walk', metric: 'sessions', target: 4, period: 'week' },
  { key: 'cardio_150_min_week', title: '150 minutes of cardio a week', activityKind: 'cardio_any', metric: 'minutes', target: 150, period: 'week' },
  { key: 'steps_8000_day', title: '8,000 steps a day', activityKind: 'walk', metric: 'steps', target: 8000, period: 'day' },
  { key: 'workout_3x_week', title: 'Work out 3 times a week', activityKind: 'workout_any', metric: 'sessions', target: 3, period: 'week' },
];

export function mockGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: uuid(),
    title: 'Walk 4 times a week',
    activityKind: 'walk',
    customLabel: null,
    metric: 'sessions',
    target: 4,
    period: 'week',
    status: 'active',
    startsOn: '2026-09-28',
    version: 1,
    createdAt: '2026-09-28T08:00:00.000Z',
    updatedAt: '2026-09-28T08:00:00.000Z',
    ...overrides,
  };
}

export function mockEntry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: uuid(),
    occurredOn: '2026-09-29',
    occurredAt: null,
    activityKind: 'walk',
    completed: true,
    durationSeconds: null,
    steps: null,
    distanceMeters: null,
    source: 'manual',
    workoutId: null,
    provider: null,
    note: null,
    createdAt: '2026-09-29T12:00:00.000Z',
    updatedAt: '2026-09-29T12:00:00.000Z',
    ...overrides,
  };
}

export function mockProgress(goal: Goal, overrides: Partial<GoalProgress> = {}): GoalProgress {
  const done = overrides.done ?? 0;
  return {
    goalId: goal.id,
    goal,
    periodStart: goal.period === 'week' ? '2026-09-28' : '2026-09-29',
    periodEnd: goal.period === 'week' ? '2026-10-04' : '2026-09-29',
    done,
    target: goal.target,
    remaining: Math.max(0, goal.target - done),
    daysLeft: goal.period === 'week' ? 6 : 1,
    onTrack: true,
    hit: done >= goal.target,
    streakPeriods: 0,
    entries: [],
    ...overrides,
  };
}

export interface GoalsApiState {
  goals: Goal[];
  entries: ActivityEntry[];
  history: Record<string, GoalHistoryPeriod[]>;
  calls: Array<{ method: string; path: string; body?: unknown; ifMatch?: string | null }>;
  /** Answer the next PATCH with `412` (another device edited the goal). */
  failNextPatchStale: boolean;
  /** When set, an entry's `occurredOn` must lie in [today-7, today]. */
  today: string | null;
}

const refusal = (status: number, code: string, message: string, details: Record<string, unknown>) =>
  HttpResponse.json({ statusCode: status, code, message, details }, { status });

const TRANSITIONS: Record<string, { from: Goal['status'][]; to: Goal['status'] }> = {
  pause: { from: ['active'], to: 'paused' },
  resume: { from: ['paused'], to: 'active' },
  archive: { from: ['active', 'paused'], to: 'archived' },
};

function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function matches(goal: Goal, entry: ActivityEntry): boolean {
  if (goal.metric === 'steps') return entry.steps !== null;
  if (entry.activityKind === 'steps') return false;
  if (goal.activityKind === 'cardio_any') return ['walk', 'run', 'cardio_any'].includes(entry.activityKind);
  return goal.activityKind === entry.activityKind;
}

function progressFor(goal: Goal, entries: ActivityEntry[]): GoalProgress {
  const mine = entries.filter((e) => matches(goal, e));
  let raw = 0;
  for (const e of mine) {
    if (goal.metric === 'sessions') raw += e.completed ? 1 : 0;
    else if (goal.metric === 'minutes') raw += e.durationSeconds ?? 0;
    else if (goal.metric === 'steps') raw += e.steps ?? 0;
    else raw += e.distanceMeters ?? 0;
  }
  // The server's units: whole minutes and whole meters over the period.
  const done = goal.metric === 'minutes' ? Math.floor(raw / 60) : goal.metric === 'distance_m' ? Math.floor(raw) : raw;
  return mockProgress(goal, { done, entries: mine.map((e) => ({ ...e, superseded: false })) });
}

export function statefulGoalsApi(
  initial: Goal[] = [],
  options: { templates?: GoalTemplate[]; entries?: ActivityEntry[] } = {},
): GoalsApiState {
  const state: GoalsApiState = {
    goals: initial.map((g) => ({ ...g })),
    entries: [...(options.entries ?? [])],
    history: {},
    calls: [],
    failNextPatchStale: false,
    today: null,
  };
  const templates = options.templates ?? GOAL_TEMPLATES;
  const find = (id: string) => state.goals.find((g) => g.id === id);
  const notFound = () =>
    HttpResponse.json({ statusCode: 404, code: 'NOT_FOUND', message: 'Goal not found' }, { status: 404 });
  const limit = () =>
    HttpResponse.json(
      {
        statusCode: 409,
        code: 'CONFLICT',
        message: 'You already have 10 active goals',
        details: { reason: 'GOAL_LIMIT_REACHED' },
      },
      { status: 409 },
    );
  const record = async (request: Request, path: string) => {
    let body: unknown;
    if (request.method !== 'GET') body = await request.clone().json().catch(() => undefined);
    state.calls.push({ method: request.method, path, body, ifMatch: request.headers.get('If-Match') });
    return body;
  };
  const activeCount = () => state.goals.filter((g) => g.status === 'active').length;
  const bump = (goal: Goal) => {
    goal.version += 1;
    goal.updatedAt = new Date().toISOString();
  };

  server.use(
    http.get(`${API}/goals/templates`, () => HttpResponse.json({ data: templates })),
    http.get(`${API}/goals/progress`, () =>
      HttpResponse.json({
        data: state.goals.filter((g) => g.status === 'active').map((g) => progressFor(g, state.entries)),
      }),
    ),
    http.get(`${API}/goals/:id/history`, ({ params }) =>
      HttpResponse.json({ data: state.history[String(params.id)] ?? [] }),
    ),
    http.get(`${API}/goals`, ({ request }) => {
      const status = new URL(request.url).searchParams.get('status') ?? 'active';
      return HttpResponse.json({ data: state.goals.filter((g) => g.status === status) });
    }),
    http.post(`${API}/goals`, async ({ request }) => {
      const body = (await record(request, '/goals')) as Partial<Goal>;
      if (activeCount() >= 10) return limit();
      const goal = mockGoal({ ...body, customLabel: body.customLabel ?? null, status: 'active', version: 1 });
      state.goals.push(goal);
      return HttpResponse.json({ data: goal }, { status: 201 });
    }),
    http.patch(`${API}/goals/:id`, async ({ request, params }) => {
      const body = (await record(request, `/goals/${params.id}`)) as Partial<Goal>;
      const goal = find(String(params.id));
      if (!goal) return notFound();
      if (state.failNextPatchStale) {
        state.failNextPatchStale = false;
        bump(goal);
        goal.title = `${goal.title} (edited elsewhere)`;
      }
      const ifMatch = request.headers.get('If-Match');
      if (!ifMatch || !/^\d+$/.test(ifMatch.replace(/^W\//, '').replace(/"/g, ''))) {
        // The filter has no code for 428: the envelope says `ERROR`.
        return refusal(428, 'ERROR', 'Send If-Match with the goal version you loaded', { reason: 'IF_MATCH_REQUIRED' });
      }
      if (Number(ifMatch.replace(/^W\//, '').replace(/"/g, '')) !== goal.version) {
        return refusal(412, 'PRECONDITION_FAILED', 'The goal changed since you loaded it; reload and retry', {
          reason: 'GOAL_VERSION_MISMATCH',
          currentVersion: goal.version,
        });
      }
      if (goal.status === 'archived') {
        return refusal(409, 'CONFLICT', 'An archived goal cannot be edited', { reason: 'GOAL_ARCHIVED' });
      }
      Object.assign(goal, body);
      bump(goal);
      return HttpResponse.json({ data: goal });
    }),
    http.post(`${API}/goals/:id/:action`, async ({ request, params }) => {
      await record(request, `/goals/${params.id}/${params.action}`);
      const goal = find(String(params.id));
      if (!goal) return notFound();
      const rule = TRANSITIONS[String(params.action)];
      if (!rule) return notFound();
      if (goal.status === rule.to) return HttpResponse.json({ data: goal });
      if (!rule.from.includes(goal.status)) {
        return refusal(409, 'CONFLICT', `A ${goal.status} goal cannot be ${String(params.action)}d`, {
          reason: 'GOAL_ILLEGAL_TRANSITION',
          status: goal.status,
        });
      }
      if (rule.to === 'active' && activeCount() >= 10) return limit();
      goal.status = rule.to;
      bump(goal);
      return HttpResponse.json({ data: goal });
    }),
    http.post(`${API}/activity-entries`, async ({ request }) => {
      const body = (await record(request, '/activity-entries')) as Partial<ActivityEntry>;
      if (state.today && body.occurredOn && (body.occurredOn > state.today || body.occurredOn < shiftDay(state.today, -7))) {
        return refusal(400, 'BAD_REQUEST', `The day must be today or at most 7 days earlier (today is ${state.today})`, {
          reason: 'ENTRY_DATE_OUT_OF_RANGE',
          path: 'occurredOn',
          today: state.today,
        });
      }
      const entry = mockEntry({
        activityKind: body.activityKind,
        occurredOn: body.occurredOn ?? '2026-09-29',
        durationSeconds: body.durationSeconds ?? null,
        steps: body.steps ?? null,
        distanceMeters: body.distanceMeters ?? null,
        completed: body.completed ?? true,
        note: body.note ?? null,
      });
      state.entries.push(entry);
      return HttpResponse.json({ data: entry }, { status: 201 });
    }),
  );
  return state;
}
