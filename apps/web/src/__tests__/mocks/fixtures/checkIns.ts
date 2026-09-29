/**
 * Daily check-in fixtures (issue #56, E2.4), shaped exactly as
 * `/api/check-ins` answers inside the `{ data }` envelope.
 */
import type { CheckIn, TodayCheckIn } from '../../../services/health';

/** The server's "today" in every default handler. */
export const MOCK_CHECK_IN_TODAY = '2026-09-29';

export function mockCheckIn(overrides: Partial<CheckIn> = {}): CheckIn {
  return {
    date: MOCK_CHECK_IN_TODAY,
    energy: 4,
    sleepQuality: 3,
    soreness: 2,
    stress: 3,
    note: 'Big presentation',
    updatedAt: '2026-09-29T07:30:00.000Z',
    ...overrides,
  };
}

/** No check-in yet today. */
export const mockTodayCheckInEmpty: TodayCheckIn = { date: MOCK_CHECK_IN_TODAY, checkIn: null };
