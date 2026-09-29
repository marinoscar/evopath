/**
 * The daily check-in wire contract (issue #56, E2.4), against MSW. The request
 * is asserted: the API's `PUT` schema is strict, so exactly the five keys go
 * out, with an unrecorded score as `null`, and the day travels in the path.
 */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  deleteCheckIn,
  getTodayCheckIn,
  isCheckInConflict,
  listCheckIns,
  saveCheckIn,
} from '../../services/health';
import { ApiError } from '../../services/api';
import { mockCheckIn, mockTodayCheckInEmpty } from '../mocks/fixtures/checkIns';

describe('services/health check-ins', () => {
  it('getTodayCheckIn unwraps the envelope', async () => {
    await expect(getTodayCheckIn()).resolves.toEqual(mockTodayCheckInEmpty);
  });

  it('listCheckIns sends days and unwraps the items', async () => {
    let url = '';
    const items = [mockCheckIn(), mockCheckIn({ date: '2026-09-28' })];
    server.use(
      http.get('*/api/check-ins', ({ request }) => {
        url = request.url;
        return HttpResponse.json({ data: { items } });
      }),
    );
    await expect(listCheckIns(14)).resolves.toEqual(items);
    expect(new URL(url).searchParams.get('days')).toBe('14');
  });

  it('saveCheckIn PUTs exactly the five keys to the day', async () => {
    let path = '';
    let body: unknown;
    server.use(
      http.put('*/api/check-ins/:date', async ({ request }) => {
        path = new URL(request.url).pathname;
        body = await request.json();
        return HttpResponse.json({ data: mockCheckIn({ energy: 5, sleepQuality: null }) });
      }),
    );
    const extra = { energy: 5, sleepQuality: null, soreness: 2, stress: null, note: null, date: 'x' };
    const saved = await saveCheckIn('2026-09-29', extra);
    expect(path).toBe('/api/check-ins/2026-09-29');
    expect(body).toEqual({ energy: 5, sleepQuality: null, soreness: 2, stress: null, note: null });
    expect(saved.energy).toBe(5);
  });

  it('deleteCheckIn DELETEs the day and resolves on 204', async () => {
    let path = '';
    server.use(
      http.delete('*/api/check-ins/:date', ({ request }) => {
        path = new URL(request.url).pathname;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await expect(deleteCheckIn('2026-09-28')).resolves.toBeUndefined();
    expect(path).toBe('/api/check-ins/2026-09-28');
  });

  it('isCheckInConflict is true only for a 409', () => {
    expect(isCheckInConflict(new ApiError('x', 409))).toBe(true);
    expect(isCheckInConflict(new ApiError('x', 400))).toBe(false);
    expect(isCheckInConflict(new Error('x'))).toBe(false);
  });
});
