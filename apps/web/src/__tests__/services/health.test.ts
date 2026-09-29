/**
 * The health profile wire contract (issue #47, E2.1), against MSW. The
 * request is asserted, not just the result: a body with an extra key is a 400
 * from the API's strict schema, and a missing `If-Match: 0` makes the first
 * save the one unguarded write.
 */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  getHealthProfile,
  isHealthProfileConflict,
  saveHealthProfile,
  type HealthProfile,
  type HealthProfileInput,
} from '../../services/health';
import { ApiError } from '../../services/api';
import { mockHealthProfileEmpty, mockHealthProfileSaved } from '../mocks/fixtures/health';

const INPUT: HealthProfileInput = {
  dateOfBirth: '1990-02-28',
  sexAtBirth: 'female',
  heightMm: 1778,
  unitSystem: 'imperial',
  timeZone: 'America/New_York',
  bio: null,
};

describe('services/health', () => {
  it('getHealthProfile unwraps the envelope, including the no-row default', async () => {
    await expect(getHealthProfile()).resolves.toEqual(mockHealthProfileEmpty);
  });

  it('getHealthProfile rejects with the ApiError on a 403', async () => {
    server.use(
      http.get('*/api/health-profile', () =>
        HttpResponse.json({ message: 'Forbidden' }, { status: 403 }),
      ),
    );
    await expect(getHealthProfile()).rejects.toMatchObject({ status: 403, message: 'Forbidden' });
  });

  it('saveHealthProfile PUTs exactly the six input fields with If-Match', async () => {
    let method = '';
    let body: unknown;
    let ifMatch: string | null = null;
    server.use(
      http.put('*/api/health-profile', async ({ request }) => {
        method = request.method;
        body = await request.json();
        ifMatch = request.headers.get('If-Match');
        return HttpResponse.json({ data: { ...mockHealthProfileSaved, version: 4 } });
      }),
    );

    const withExtras = { ...INPUT, version: 3, updatedAt: 'x' } as unknown as HealthProfileInput;
    const saved: HealthProfile = await saveHealthProfile(withExtras, 3);

    expect(method).toBe('PUT');
    expect(body).toEqual(INPUT);
    expect(ifMatch).toBe('3');
    expect(saved.version).toBe(4);
  });

  it('sends If-Match: 0 for a user with no row yet', async () => {
    let ifMatch: string | null = null;
    server.use(
      http.put('*/api/health-profile', ({ request }) => {
        ifMatch = request.headers.get('If-Match');
        return HttpResponse.json({ data: { ...mockHealthProfileSaved, version: 1 } });
      }),
    );
    await saveHealthProfile(INPUT, 0);
    expect(ifMatch).toBe('0');
  });

  it('sends no If-Match when no version is given', async () => {
    let ifMatch: string | null = 'unset';
    server.use(
      http.put('*/api/health-profile', ({ request }) => {
        ifMatch = request.headers.get('If-Match');
        return HttpResponse.json({ data: mockHealthProfileSaved });
      }),
    );
    await saveHealthProfile(INPUT);
    expect(ifMatch).toBeNull();
  });

  it('keeps explicit nulls in the body (a full replace clears them)', async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.put('*/api/health-profile', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ data: mockHealthProfileEmpty });
      }),
    );
    await saveHealthProfile(
      { ...INPUT, dateOfBirth: null, sexAtBirth: null, heightMm: null, timeZone: null },
      1,
    );
    expect(body).toEqual({
      dateOfBirth: null,
      sexAtBirth: null,
      heightMm: null,
      unitSystem: 'imperial',
      timeZone: null,
      bio: null,
    });
  });

  it('a 409 rejects with an error isHealthProfileConflict recognises', async () => {
    server.use(
      http.put('*/api/health-profile', () =>
        HttpResponse.json({ message: 'Version mismatch' }, { status: 409 }),
      ),
    );
    const err = await saveHealthProfile(INPUT, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(isHealthProfileConflict(err)).toBe(true);
    expect(isHealthProfileConflict(new ApiError('Bad', 400))).toBe(false);
    expect(isHealthProfileConflict(new Error('x'))).toBe(false);
  });
});
