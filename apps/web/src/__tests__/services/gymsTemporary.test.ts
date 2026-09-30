/**
 * Temporary gyms (E6.2) in `services/gyms.ts`: "Expires in N days" (last
 * change plus 30 days), the refusals in words, the hotel default name, and
 * Save gym as `PATCH /gyms/:id { isTemporary: false }`.
 */
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { ApiError } from '../../services/api';
import {
  GYM_LIMIT_MESSAGE,
  TEMPORARY_GYM_NOT_DEFAULT_MESSAGE,
  gymRefusalMessage,
  hotelGymDefaultName,
  saveTemporaryGym,
  temporaryGymDaysLeft,
  temporaryGymExpiryText,
} from '../../services/gyms';

const DAY = 24 * 60 * 60 * 1000;
const CHANGED = '2026-09-01T12:00:00.000Z';
const at = (days: number) => Date.parse(CHANGED) + days * DAY;

describe('temporary gym expiry', () => {
  it('counts whole days until updatedAt + 30 days, rounding up', () => {
    expect(temporaryGymDaysLeft(CHANGED, at(0))).toBe(30);
    expect(temporaryGymDaysLeft(CHANGED, at(18.5))).toBe(12);
    expect(temporaryGymExpiryText(CHANGED, at(18))).toBe('Expires in 12 days');
    expect(temporaryGymExpiryText(CHANGED, at(29))).toBe('Expires in 1 day');
    expect(temporaryGymExpiryText(CHANGED, at(30))).toBe('Expires today');
    expect(temporaryGymExpiryText(CHANGED, at(45))).toBe('Expires today');
  });

  it('falls back to words for an unreadable date', () => {
    expect(temporaryGymDaysLeft('not a date')).toBeNull();
    expect(temporaryGymExpiryText('not a date')).toBe('Expires 30 days after its last change');
  });
});

describe('gymRefusalMessage', () => {
  const refusal = (reason: string) => new ApiError('server words', 409, 'CONFLICT', { reason });
  it('spells out the refusals the hotel flow meets', () => {
    expect(gymRefusalMessage(refusal('GYM_LIMIT'), 'x')).toBe(GYM_LIMIT_MESSAGE);
    expect(GYM_LIMIT_MESSAGE).toBe('You have 50 gyms; delete a saved one or wait for temporary gyms to expire.');
    expect(gymRefusalMessage(refusal('TEMPORARY_GYM_NOT_DEFAULT'), 'x')).toBe(TEMPORARY_GYM_NOT_DEFAULT_MESSAGE);
    expect(gymRefusalMessage(refusal('DEFAULT_CONFLICT'), 'x')).toBe('Your gyms changed at the same moment. Try again.');
  });
  it('falls back to the server message, then the fallback', () => {
    expect(gymRefusalMessage(refusal('OTHER'), 'x')).toBe('server words');
    expect(gymRefusalMessage('boom', 'fallback')).toBe('fallback');
  });
});

describe('hotelGymDefaultName', () => {
  it('is "Hotel gym" plus a short date', () => {
    expect(hotelGymDefaultName(new Date(2026, 8, 30))).toBe('Hotel gym Sep 30');
  });
});

describe('saveTemporaryGym', () => {
  it('patches isTemporary false with the new name and type, same id', async () => {
    let body: unknown;
    server.use(
      http.patch('*/api/gyms/:id', async ({ request, params }) => {
        body = await request.json();
        return HttpResponse.json({ data: { id: params.id, isTemporary: false } });
      }),
    );
    const saved = await saveTemporaryGym('gym-1', { name: 'Marriott', type: 'hotel' });
    expect(body).toEqual({ name: 'Marriott', type: 'hotel', isTemporary: false });
    expect(saved).toMatchObject({ id: 'gym-1', isTemporary: false });
  });
});
