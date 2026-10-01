/** `services/sleep.ts` (#283 scope update): the routes on the wire and the display helpers. */
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  deleteSleep,
  formatSleepDuration,
  isHealthConnectSleep,
  listSleep,
  sleepStages,
} from '../../services/sleep';
import { mockSleepSession } from '../mocks/fixtures/sleep';

describe('sleep service', () => {
  it('lists sleep for a date range and unwraps the envelope', async () => {
    let url = '';
    server.use(
      http.get('*/api/sleep', ({ request }) => {
        url = request.url;
        return HttpResponse.json({ data: [mockSleepSession()] });
      }),
    );
    const sessions = await listSleep({ from: '2026-09-17', to: '2026-09-30' });
    expect(new URL(url).search).toBe('?from=2026-09-17&to=2026-09-30');
    expect(sessions).toHaveLength(1);
  });

  it('deletes one session', async () => {
    let method = '';
    let path = '';
    server.use(
      http.delete('*/api/sleep/:id', ({ request }) => {
        method = request.method;
        path = new URL(request.url).pathname;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await deleteSleep('slp-1');
    expect(method).toBe('DELETE');
    expect(path).toBe('/api/sleep/slp-1');
  });
});

describe('sleep helpers', () => {
  it('lists only the stages the session reported, in a fixed order', () => {
    expect(sleepStages(mockSleepSession())).toEqual([
      ['awake', 30],
      ['light', 240],
      ['deep', 90],
      ['rem', 120],
    ]);
    expect(
      sleepStages(
        mockSleepSession({ awakeMinutes: null, lightMinutes: null, deepMinutes: null, remMinutes: null, unknownMinutes: 400 }),
      ),
    ).toEqual([['unknown', 400]]);
  });

  it('formats minutes as hours and minutes', () => {
    expect(formatSleepDuration(452)).toBe('7h 32m');
    expect(formatSleepDuration(480)).toBe('8h');
    expect(formatSleepDuration(45)).toBe('45m');
  });

  it('recognises a Health Connect session by origin and provider', () => {
    expect(isHealthConnectSleep(mockSleepSession())).toBe(true);
    expect(isHealthConnectSleep(mockSleepSession({ origin: 'manual', provider: null }))).toBe(false);
  });
});
