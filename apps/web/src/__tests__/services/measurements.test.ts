/**
 * The measurements wire contract (issue #53, E2.3), against MSW: paths,
 * bodies (the API schema is strict) and error mapping.
 */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { ApiError } from '../../services/api';
import {
  createMeasurementEntry,
  getLatestMeasurements,
  getMeasurementCatalog,
  isHealthDataForbidden,
  validationIssues,
} from '../../services/health';
import { mockLatest, mockMeasurement, mockMetricCatalog } from '../mocks/fixtures/measurements';

describe('services/health measurements', () => {
  it('getMeasurementCatalog GETs /measurements/metrics and unwraps the envelope', async () => {
    let path = '';
    server.use(
      http.get('*/api/measurements/metrics', ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({ data: mockMetricCatalog });
      }),
    );
    await expect(getMeasurementCatalog()).resolves.toEqual(mockMetricCatalog);
    expect(path).toBe('/api/measurements/metrics');
  });

  it('getLatestMeasurements returns the items array', async () => {
    const items = mockLatest({ weight: { latest: mockMeasurement('weight', 80) } });
    server.use(http.get('*/api/measurements/latest', () => HttpResponse.json({ data: { items } })));
    await expect(getLatestMeasurements()).resolves.toEqual(items);
  });

  it('createMeasurementEntry POSTs exactly the allowed keys', async () => {
    let body: unknown;
    let method = '';
    server.use(
      http.post('*/api/measurements', async ({ request }) => {
        method = request.method;
        body = await request.json();
        return HttpResponse.json({ data: { entryId: 'e', items: [] } }, { status: 201 });
      }),
    );
    const extra = {
      readings: [{ metricKey: 'weight', value: 208.4, unit: 'lb', origin: 'ai' }],
      origin: 'ai',
    } as unknown as Parameters<typeof createMeasurementEntry>[0];

    await expect(createMeasurementEntry(extra)).resolves.toEqual({ entryId: 'e', items: [] });
    expect(method).toBe('POST');
    expect(body).toEqual({ readings: [{ metricKey: 'weight', value: 208.4, unit: 'lb' }] });
  });

  it('createMeasurementEntry keeps method, measuredAt and notes when given', async () => {
    let body: unknown;
    server.use(
      http.post('*/api/measurements', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ data: { entryId: 'e', items: [] } }, { status: 201 });
      }),
    );
    await createMeasurementEntry({
      measuredAt: '2026-09-29T08:00:00.000Z',
      notes: 'after run',
      readings: [{ metricKey: 'body_fat_pct', value: 27.8, unit: '%', method: 'smart_scale' }],
    });
    expect(body).toEqual({
      measuredAt: '2026-09-29T08:00:00.000Z',
      notes: 'after run',
      readings: [{ metricKey: 'body_fat_pct', value: 27.8, unit: '%', method: 'smart_scale' }],
    });
  });

  it('a validation 400 exposes details.issues', async () => {
    server.use(
      http.post('*/api/measurements', () =>
        HttpResponse.json(
          {
            message: 'Validation failed',
            code: 'BAD_REQUEST',
            details: { issues: [{ path: 'readings.0.value', message: 'value is outside the allowed range' }] },
          },
          { status: 400 },
        ),
      ),
    );
    const err = await createMeasurementEntry({
      readings: [{ metricKey: 'weight', value: 5, unit: 'kg' }],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(validationIssues(err)).toEqual([
      { path: 'readings.0.value', message: 'value is outside the allowed range' },
    ]);
  });

  it('validationIssues is empty for anything but a 400 with issues', () => {
    expect(validationIssues(new ApiError('x', 400))).toEqual([]);
    expect(validationIssues(new ApiError('x', 500, undefined, { issues: [{ path: 'a', message: 'b' }] }))).toEqual([]);
    expect(validationIssues(new Error('x'))).toEqual([]);
    expect(
      validationIssues(new ApiError('x', 400, undefined, { issues: [{ path: 'a' }, { path: 'b', message: 'ok' }] })),
    ).toEqual([{ path: 'b', message: 'ok' }]);
  });

  it('a 403 is recognised as "no health data grant"', async () => {
    server.use(
      http.get('*/api/measurements/latest', () => HttpResponse.json({ message: 'Forbidden' }, { status: 403 })),
    );
    const err = await getLatestMeasurements().catch((e: unknown) => e);
    expect(isHealthDataForbidden(err)).toBe(true);
    expect(isHealthDataForbidden(new ApiError('x', 401))).toBe(false);
  });
});
