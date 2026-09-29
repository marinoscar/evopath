/**
 * The history and trend wire contract (issue #60, E2.5), against MSW: list
 * query and flat pagination, series query, the PATCH body (strict schema:
 * nothing extra) and the DELETE, plus the 404/409 recognisers.
 */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { ApiError } from '../../services/api';
import {
  deleteMeasurementEntry,
  getMeasurementSeries,
  isEntryConflict,
  isEntryGone,
  listMeasurements,
  updateMeasurementEntry,
} from '../../services/health';
import { mockListPage, mockMeasurement, mockSeries, mockSeriesPoint } from '../mocks/fixtures/measurements';

describe('services/health history and trends', () => {
  it('listMeasurements sends the filter and pagination and returns the flat page', async () => {
    let search = '';
    const page = mockListPage([mockMeasurement('weight', 80)], { page: 2, total: 101, totalPages: 2 });
    server.use(
      http.get('*/api/measurements', ({ request }) => {
        search = new URL(request.url).search;
        return HttpResponse.json({ data: page });
      }),
    );
    await expect(listMeasurements({ metricKey: 'weight', page: 2, pageSize: 100 })).resolves.toEqual(page);
    expect(search).toBe('?metricKey=weight&page=2&pageSize=100');
  });

  it('listMeasurements without params sends no query string', async () => {
    let url = '';
    server.use(
      http.get('*/api/measurements', ({ request }) => {
        url = request.url;
        return HttpResponse.json({ data: mockListPage([]) });
      }),
    );
    await listMeasurements();
    expect(new URL(url).search).toBe('');
  });

  it('getMeasurementSeries sends metricKey and from', async () => {
    let params: URLSearchParams | null = null;
    const series = mockSeries('weight', [mockSeriesPoint('2026-09-01T00:00:00.000Z', 80)]);
    server.use(
      http.get('*/api/measurements/series', ({ request }) => {
        params = new URL(request.url).searchParams;
        return HttpResponse.json({ data: series });
      }),
    );
    await expect(
      getMeasurementSeries({ metricKey: 'weight', from: '2026-07-01T00:00:00.000Z' }),
    ).resolves.toEqual(series);
    expect(params!.get('metricKey')).toBe('weight');
    expect(params!.get('from')).toBe('2026-07-01T00:00:00.000Z');
    expect(params!.has('to')).toBe(false);
  });

  it('updateMeasurementEntry PATCHes only the allowed keys', async () => {
    let body: unknown;
    let path = '';
    server.use(
      http.patch('*/api/measurements/entries/:entryId', async ({ request }) => {
        path = new URL(request.url).pathname;
        body = await request.json();
        return HttpResponse.json({ data: { entryId: 'e1', items: [] } });
      }),
    );
    const input = {
      notes: null,
      readings: [{ metricKey: 'weight', value: 81, unit: 'kg', origin: 'ai' }],
      origin: 'ai',
    } as unknown as Parameters<typeof updateMeasurementEntry>[1];
    await updateMeasurementEntry('e1', input);
    expect(path).toBe('/api/measurements/entries/e1');
    expect(body).toEqual({ notes: null, readings: [{ metricKey: 'weight', value: 81, unit: 'kg' }] });
  });

  it('deleteMeasurementEntry DELETEs and resolves on 204', async () => {
    let path = '';
    server.use(
      http.delete('*/api/measurements/entries/:entryId', ({ request }) => {
        path = new URL(request.url).pathname;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await expect(deleteMeasurementEntry('e9')).resolves.toBeUndefined();
    expect(path).toBe('/api/measurements/entries/e9');
  });

  it('recognises 404 and 409', () => {
    expect(isEntryGone(new ApiError('Not found', 404))).toBe(true);
    expect(isEntryGone(new ApiError('Conflict', 409))).toBe(false);
    expect(isEntryConflict(new ApiError('Conflict', 409))).toBe(true);
    expect(isEntryConflict(new Error('x'))).toBe(false);
  });
});
