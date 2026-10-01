/**
 * Sleep fixtures (#283 scope update, epic #276), shaped exactly as
 * `GET /api/sleep` answers inside the `{ data }` envelope.
 */
import type { SleepSession } from '../../../services/sleep';

export function mockSleepSession(overrides: Partial<SleepSession> = {}): SleepSession {
  return {
    id: 'slp11111-0000-4000-8000-000000000001',
    startAt: '2026-09-29T04:30:00.000Z',
    endAt: '2026-09-29T12:30:00.000Z',
    localDate: '2026-09-29',
    durationMinutes: 450,
    awakeMinutes: 30,
    lightMinutes: 240,
    deepMinutes: 90,
    remMinutes: 120,
    unknownMinutes: null,
    origin: 'device',
    provider: 'health_connect:dev11111-0000-4000-8000-000000000001',
    externalId: 'hc-sleep-1',
    note: null,
    createdAt: '2026-09-29T13:00:00.000Z',
    updatedAt: '2026-09-29T13:00:00.000Z',
    ...overrides,
  };
}
