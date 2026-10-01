/** `services/goals.ts` (#268): every route's method, path, body, If-Match, and the error helpers. */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { ApiError } from '../../services/api';
import {
  ENTRY_DATE_MESSAGE,
  GOAL_ARCHIVED_MESSAGE,
  GOAL_LIMIT_MESSAGE,
  GOAL_STALE_MESSAGE,
  GOAL_TRANSITION_MESSAGE,
  isGoalOutdated,
  createActivityEntry,
  createGoal,
  getGoalHistory,
  getGoalProgress,
  goalErrorMessage,
  isGoalLimitReached,
  isGoalStale,
  listActivityEntries,
  listGoalTemplates,
  listGoals,
  transitionGoal,
  updateGoal,
} from '../../services/goals';

interface Seen {
  url?: string;
  method?: string;
  body?: unknown;
  ifMatch?: string | null;
}

function capture(method: 'get' | 'post' | 'patch', path: string, data: unknown = null, status = 200): Seen {
  const seen: Seen = {};
  server.use(
    http[method](`*/api${path}`, async ({ request }) => {
      seen.url = request.url;
      seen.method = request.method;
      seen.ifMatch = request.headers.get('If-Match');
      const text = await request.clone().text();
      seen.body = text ? JSON.parse(text) : undefined;
      return HttpResponse.json({ data }, { status });
    }),
  );
  return seen;
}

const G = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('goals service', () => {
  it('lists goals by status and the templates', async () => {
    const seen = capture('get', '/goals', []);
    await listGoals('paused');
    expect(new URL(seen.url!).search).toBe('?status=paused');
    const t = capture('get', '/goals/templates', []);
    await listGoalTemplates();
    expect(t.method).toBe('GET');
  });

  it('creates, patches with If-Match, and transitions', async () => {
    const c = capture('post', '/goals', { id: G }, 201);
    await createGoal({ title: 'Walk', activityKind: 'walk', metric: 'sessions', target: 4, period: 'week' });
    expect(c.body).toEqual({ title: 'Walk', activityKind: 'walk', metric: 'sessions', target: 4, period: 'week' });

    const u = capture('patch', `/goals/${G}`, { id: G });
    await updateGoal(G, 3, { target: 5 });
    expect(u.ifMatch).toBe('3');
    expect(u.body).toEqual({ target: 5 });

    const a = capture('post', `/goals/${G}/archive`, { id: G });
    await transitionGoal(G, 'archive');
    expect(a.method).toBe('POST');
  });

  it('reads progress (optionally for a date) and history', async () => {
    const pr = capture('get', '/goals/progress', []);
    await getGoalProgress('2026-09-29');
    expect(new URL(pr.url!).search).toBe('?date=2026-09-29');
    const h = capture('get', `/goals/${G}/history`, []);
    await getGoalHistory(G);
    expect(new URL(h.url!).search).toBe('?limit=12');
  });

  it('posts and lists activity entries', async () => {
    const c = capture('post', '/activity-entries', { id: 'e' }, 201);
    await createActivityEntry({ activityKind: 'steps', steps: 8000 });
    expect(c.body).toEqual({ activityKind: 'steps', steps: 8000 });
    const l = capture('get', '/activity-entries', []);
    await listActivityEntries({ from: '2026-09-01', to: '2026-09-30', kind: 'walk' });
    expect(new URL(l.url!).searchParams.get('kind')).toBe('walk');
  });
});

describe('goal errors', () => {
  it('recognises the active-goal limit (details.reason or code)', () => {
    const viaReason = new ApiError('x', 409, 'CONFLICT', { reason: 'GOAL_LIMIT_REACHED' });
    const viaCode = new ApiError('x', 409, 'GOAL_LIMIT_REACHED');
    expect(isGoalLimitReached(viaReason)).toBe(true);
    expect(isGoalLimitReached(viaCode)).toBe(true);
    expect(goalErrorMessage(viaReason, 'f')).toBe(GOAL_LIMIT_MESSAGE);
    expect(isGoalLimitReached(new ApiError('x', 409, 'CONFLICT'))).toBe(false);
  });

  it('recognises a stale edit (412) and explains it', () => {
    const stale = new ApiError('Precondition failed', 412, 'PRECONDITION_FAILED');
    expect(isGoalStale(stale)).toBe(true);
    expect(goalErrorMessage(stale, 'f')).toBe(GOAL_STALE_MESSAGE);
  });

  it('treats the real 412 and 428 envelopes as stale', () => {
    // As the API sends them: 412 GOAL_VERSION_MISMATCH, 428 IF_MATCH_REQUIRED (envelope code `ERROR`).
    const mismatch = new ApiError('The goal changed', 412, 'PRECONDITION_FAILED', { reason: 'GOAL_VERSION_MISMATCH', currentVersion: 3 });
    const missing = new ApiError('Send If-Match', 428, 'ERROR', { reason: 'IF_MATCH_REQUIRED' });
    expect(isGoalStale(mismatch)).toBe(true);
    expect(isGoalStale(missing)).toBe(true);
    expect(goalErrorMessage(missing, 'f')).toBe(GOAL_STALE_MESSAGE);
  });

  it('explains the other refusals in plain words', () => {
    const archived = new ApiError('An archived goal cannot be edited', 409, 'CONFLICT', { reason: 'GOAL_ARCHIVED' });
    const illegal = new ApiError('A archived goal cannot be paused', 409, 'CONFLICT', { reason: 'GOAL_ILLEGAL_TRANSITION', status: 'archived' });
    expect(goalErrorMessage(archived, 'f')).toBe(GOAL_ARCHIVED_MESSAGE);
    expect(goalErrorMessage(illegal, 'f')).toBe(GOAL_TRANSITION_MESSAGE);
    expect(isGoalOutdated(archived)).toBe(true);
    expect(isGoalOutdated(illegal)).toBe(true);
    expect(isGoalOutdated(new ApiError('x', 409, 'CONFLICT', { reason: 'GOAL_LIMIT_REACHED' }))).toBe(false);
    expect(
      goalErrorMessage(new ApiError('The day must be…', 400, 'BAD_REQUEST', { reason: 'ENTRY_DATE_OUT_OF_RANGE', path: 'occurredOn', today: '2026-09-30' }), 'f'),
    ).toBe(ENTRY_DATE_MESSAGE);
    expect(
      goalErrorMessage(new ApiError('A sessions goal counts per week: use period `week`', 400, 'BAD_REQUEST', { reason: 'INVALID_GOAL', path: 'period' }), 'f'),
    ).toBe('A sessions goal is counted per week.');
    expect(goalErrorMessage(new ApiError('startsOn must be…', 400, 'BAD_REQUEST', { reason: 'START_DATE_OUT_OF_RANGE' }), 'f')).toBe(
      'Pick a start date within a year of today.',
    );
  });

  it('falls back to the message, then the fallback', () => {
    expect(goalErrorMessage(new ApiError('Bad target', 400), 'f')).toBe('Bad target');
    expect(goalErrorMessage('nope', 'fallback')).toBe('fallback');
  });
});
