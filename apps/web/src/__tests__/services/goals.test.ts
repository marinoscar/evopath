/** `services/goals.ts` (#268): every route's method, path, body, If-Match, and the error helpers. */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { ApiError } from '../../services/api';
import {
  GOAL_LIMIT_MESSAGE,
  GOAL_STALE_MESSAGE,
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

  it('falls back to the message, then the fallback', () => {
    expect(goalErrorMessage(new ApiError('Bad target', 400), 'f')).toBe('Bad target');
    expect(goalErrorMessage('nope', 'fallback')).toBe('fallback');
  });
});
