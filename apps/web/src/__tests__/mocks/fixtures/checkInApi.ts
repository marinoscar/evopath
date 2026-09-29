/**
 * A tiny in-memory `/api/check-ins` (issue #56, E2.4) for component tests:
 * `PUT` replaces the day, `DELETE` removes it, and both `GET`s read the state
 * back, so a test sees the refetch the UI performs after a save.
 */
import { http, HttpResponse } from 'msw';
import { server } from '../server';
import type { CheckIn } from '../../../services/health';
import { MOCK_CHECK_IN_TODAY } from './checkIns';

export interface CheckInApiState {
  today: string;
  days: Map<string, CheckIn>;
  puts: Array<{ date: string; body: Record<string, unknown> }>;
  deletes: string[];
  /** When set, the next PUT answers this status instead of saving. */
  failNextPut: number | null;
}

export function statefulCheckInApi(initial: CheckIn[] = [], today = MOCK_CHECK_IN_TODAY): CheckInApiState {
  const state: CheckInApiState = {
    today,
    days: new Map(initial.map((c) => [c.date, c])),
    puts: [],
    deletes: [],
    failNextPut: null,
  };
  let clock = 0;
  server.use(
    http.get('*/api/check-ins/today', () =>
      HttpResponse.json({ data: { date: state.today, checkIn: state.days.get(state.today) ?? null } }),
    ),
    http.get('*/api/check-ins', () => {
      const items = [...state.days.values()].sort((a, b) => b.date.localeCompare(a.date));
      return HttpResponse.json({ data: { items } });
    }),
    http.put('*/api/check-ins/:date', async ({ request, params }) => {
      const date = String(params.date);
      const body = (await request.json()) as Record<string, unknown>;
      state.puts.push({ date, body });
      if (state.failNextPut !== null) {
        const status = state.failNextPut;
        state.failNextPut = null;
        return HttpResponse.json({ message: 'This check-in was updated elsewhere' }, { status });
      }
      clock += 1;
      const saved: CheckIn = {
        date,
        energy: (body.energy as number | null) ?? null,
        sleepQuality: (body.sleepQuality as number | null) ?? null,
        soreness: (body.soreness as number | null) ?? null,
        stress: (body.stress as number | null) ?? null,
        note: (body.note as string | null) ?? null,
        updatedAt: new Date(Date.UTC(2026, 8, 29, 8, clock)).toISOString(),
      };
      state.days.set(date, saved);
      return HttpResponse.json({ data: saved });
    }),
    http.delete('*/api/check-ins/:date', ({ params }) => {
      const date = String(params.date);
      state.deletes.push(date);
      if (!state.days.delete(date)) return HttpResponse.json({ message: 'Not found' }, { status: 404 });
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return state;
}
