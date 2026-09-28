/**
 * `buildAssistantQuestion` — the dashboard's prefilled assistant question
 * (issue #579, epic #576). Pure: every panel kind, the window/filter wording,
 * and the length caps.
 */
import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_PROMPT_MAX,
  ASSISTANT_PROMPT_MESSAGE_MAX,
  buildAssistantQuestion,
  clip,
  type AssistantQuestionContext,
} from '../../../../components/telemetry/dashboard/assistantPrompt';
import {
  mockDashboardApiSeries,
  mockDashboardEvent,
  mockDashboardLogsSeries,
  mockDashboardSummary,
  mockDashboardTopErrors,
  mockDashboardTopRoutes,
} from '../../../mocks/fixtures/telemetryDashboard';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const NOW = Date.parse('2026-09-27T11:00:00.000Z');
const HOUR: AssistantQuestionContext = { range: '1h', from: null, to: null, service: null, instance: null, now: NOW };

const lines = (text: string) => text.split('\n');

describe('buildAssistantQuestion', () => {
  it('has the three-line shape with the preset window and "all services"', () => {
    const text = buildAssistantQuestion(
      { kind: 'verdict', title: 'Verdict', verdict: { level: 'critical', reasons: ['5xx rate 12%'] } },
      HOUR,
    );
    expect(lines(text)).toEqual([
      'Investigate "Verdict" for the last hour (all services).',
      'Current state: Critical — 5xx rate 12%.',
      'What is most likely causing this, and what should I check next?',
    ]);
  });

  it('names a zoomed window in UTC and the filters', () => {
    const text = buildAssistantQuestion(
      { kind: 'verdict', title: 'Verdict', verdict: { level: 'healthy', reasons: [] } },
      {
        ...HOUR,
        from: '2026-09-27T10:00:00.000Z',
        to: '2026-09-27T10:20:00.000Z',
        service: 'my-app-api',
        instance: 'node-1',
      },
    );
    expect(lines(text)[0]).toBe(
      'Investigate "Verdict" for 2026-09-27 10:00 UTC – 2026-09-27 10:20 UTC (service my-app-api, instance node-1).',
    );
    expect(lines(text)[1]).toBe('Current state: Healthy.');
  });

  it('lists every tile with its previous-window value', () => {
    const text = buildAssistantQuestion(
      { kind: 'tiles', title: 'Key indicators', tiles: mockDashboardSummary.tiles, runtime: mockDashboardSummary.runtime },
      HOUR,
    );
    const state = lines(text)[1];
    expect(state).toContain('Requests / min 12.5 req/min (previous window 10 req/min)');
    expect(state).toContain('5xx rate 3.2% (previous window 1.6%)');
    expect(state).toContain('p95 latency 1.4 s (previous window 2 s)');
    expect(state).toContain('Error logs 7 (previous window 7)');
    expect(state).toContain('Heap used 128 MB');
    expect(state).toMatch(/Last data (just now|\d+[smhd] ago)/);
  });

  it('summarises the API timeline: totals, worst p95 and the 5xx peak', () => {
    const text = buildAssistantQuestion({ kind: 'api', title: 'API requests', buckets: mockDashboardApiSeries.buckets }, HOUR);
    // 4 buckets: 2xx 10..13 (46), 3xx 4, 4xx 8, 5xx 0+1+2+3 (6) → 64 requests.
    expect(lines(text)[1]).toBe(
      'Current state: 64 requests, 6 5xx (9.38%), 8 4xx; worst p95 480 ms at 2026-09-27 10:03 UTC; most 5xx at 2026-09-27 10:03 UTC (3).',
    );
  });

  it('says so when the API timeline is empty', () => {
    const text = buildAssistantQuestion({ kind: 'api', title: 'API requests', buckets: [] }, HOUR);
    expect(lines(text)[1]).toBe('Current state: no requests in this window.');
  });

  it('counts the selected log severities and the error peak', () => {
    const text = buildAssistantQuestion(
      { kind: 'logs', title: 'Log severity', buckets: mockDashboardLogsSeries.buckets, severities: ['error', 'warn'] },
      HOUR,
    );
    expect(lines(text)[1]).toBe(
      'Current state: 6 error, 4 warn log records; most errors at 2026-09-27 10:03 UTC (3).',
    );
  });

  it('lists the top routes as "route — count, error %, p95"', () => {
    const text = buildAssistantQuestion({ kind: 'routes', title: 'Top failing routes', items: mockDashboardTopRoutes.items }, HOUR);
    expect(lines(text)[1]).toBe(
      'Current state: GET /api/users/:id — 120 requests, 3.33% errors, p95 840 ms; POST /api/jobs — 40 requests, 0% errors, p95 n/a.',
    );
  });

  it('stops lists at five entries', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      ...mockDashboardTopRoutes.items[0],
      route: `/api/r${i}`,
    }));
    const state = lines(buildAssistantQuestion({ kind: 'routes', title: 'Top failing routes', items }, HOUR))[1];
    expect(state).toContain('/api/r4');
    expect(state).not.toContain('/api/r5');
  });

  it('lists the top errors as "message (count)" with at most one sample trace', () => {
    const items = [
      { ...mockDashboardTopErrors.items[0], sampleTraceId: 'not-a-trace' },
      { ...mockDashboardTopErrors.items[0], message: 'Timeout\n  talking to redis', count: 3, sampleTraceId: TRACE },
      { ...mockDashboardTopErrors.items[0], message: 'Other', count: 1, sampleTraceId: 'f'.repeat(32) },
    ];
    const state = lines(buildAssistantQuestion({ kind: 'errors', title: 'Top errors', items }, HOUR))[1];
    expect(state).toBe(
      `Current state: "Database connection refused" (9); "Timeout talking to redis" (3); "Other" (1); sample trace ${TRACE}.`,
    );
    expect(state).not.toContain('f'.repeat(32));
  });

  it('describes recent events with their filter and one sample trace', () => {
    const items = [
      mockDashboardEvent(0, { traceId: 'short' }),
      mockDashboardEvent(1, { traceId: TRACE }),
      mockDashboardEvent(2, { traceId: 'e'.repeat(32) }),
    ];
    const state = lines(
      buildAssistantQuestion({ kind: 'events', title: 'Recent events', items, severities: ['error', 'warn'], q: 'boom' }, HOUR),
    )[1];
    expect(state).toBe(
      `Current state: latest error/warn events matching "boom": [error] Event number 0; [warn] Event number 1; [error] Event number 2; sample trace ${TRACE}.`,
    );
  });

  it('caps every message at 200 characters', () => {
    const long = 'x'.repeat(500);
    const state = lines(
      buildAssistantQuestion(
        { kind: 'events', title: 'Recent events', items: [mockDashboardEvent(0, { body: long })], severities: ['error'], q: '' },
        HOUR,
      ),
    )[1];
    const clipped = state.match(/x+…/)?.[0] ?? '';
    expect(clipped).toHaveLength(ASSISTANT_PROMPT_MESSAGE_MAX);
  });

  it(`never exceeds ${ASSISTANT_PROMPT_MAX} characters and keeps the closing question`, () => {
    const tiles = Array.from({ length: 80 }, (_, i) => ({
      ...mockDashboardSummary.tiles[0],
      key: `t${i}`,
      label: `Indicator number ${i} with a long label ${'y'.repeat(60)}`,
    }));
    const text = buildAssistantQuestion({ kind: 'tiles', title: 'Key indicators', tiles }, HOUR);
    expect(text.length).toBeLessThanOrEqual(ASSISTANT_PROMPT_MAX);
    expect(text.endsWith('What is most likely causing this, and what should I check next?')).toBe(true);
    expect(lines(text)[1]).toMatch(/…\.$/);
  });
});

describe('clip', () => {
  it('collapses whitespace and leaves short text alone', () => {
    expect(clip('  a \n b  ')).toBe('a b');
  });
  it('cuts to the limit including the ellipsis', () => {
    expect(clip('abcdef', 4)).toBe('abc…');
  });
});
