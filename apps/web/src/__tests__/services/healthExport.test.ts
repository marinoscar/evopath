/**
 * The health export service (issue #191, H7): the range presets, the custom
 * range checks, the request body and the error messages.
 */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { ApiError } from '../../services/api';
import {
  HEALTH_EXPORT_MAX_RANGE_DAYS,
  HEALTH_EXPORT_TOO_MANY_MESSAGE,
  createHealthExport,
  daysBetween,
  customRangeProblem,
  describeHealthExportError,
  formatExportSize,
  getHealthExport,
  isRealDate,
  listHealthExports,
  localToday,
  rangeForPreset,
} from '../../services/healthExport';
import { mockHealthExport } from '../mocks/fixtures/healthExports';

describe('healthExport service', () => {
  describe('rangeForPreset', () => {
    it('goes back whole months, ending today', () => {
      expect(rangeForPreset('3m', '2026-10-01')).toEqual({ from: '2026-07-01', to: '2026-10-01' });
      expect(rangeForPreset('6m', '2026-10-01')).toEqual({ from: '2026-04-01', to: '2026-10-01' });
      expect(rangeForPreset('12m', '2026-10-01')).toEqual({ from: '2025-10-01', to: '2026-10-01' });
    });

    it('clamps to the end of a shorter month and crosses years', () => {
      expect(rangeForPreset('3m', '2026-05-31').from).toBe('2026-02-28');
      expect(rangeForPreset('6m', '2026-03-31').from).toBe('2025-09-30');
    });

    it('"all" is the longest range the API accepts', () => {
      const range = rangeForPreset('all', '2026-10-01');
      expect(range.to).toBe('2026-10-01');
      expect(daysBetween(range.from, range.to)).toBe(HEALTH_EXPORT_MAX_RANGE_DAYS);
      expect(customRangeProblem(range.from, range.to, range.to)).toBeNull();
    });
  });

  describe('customRangeProblem', () => {
    const today = '2026-10-01';
    it('accepts a range inside the rules', () => {
      expect(customRangeProblem('2026-01-01', today, today)).toBeNull();
      expect(customRangeProblem(today, today, today)).toBeNull();
    });

    it('names each broken rule', () => {
      expect(customRangeProblem('', today, today)).toBe('Enter both dates');
      expect(customRangeProblem('2026-02-30', today, today)).toBe('Enter both dates');
      expect(customRangeProblem('2026-09-02', '2026-09-01', today)).toBe('The start date must not be after the end date');
      expect(customRangeProblem('2026-09-01', '2026-10-02', today)).toBe('The end date cannot be in the future');
      expect(customRangeProblem('2016-01-01', today, today)).toBe('The range may be at most 10 years');
    });
  });

  it('reads real dates and the local day', () => {
    expect(isRealDate('2024-02-29')).toBe(true);
    expect(isRealDate('2025-02-29')).toBe(false);
    expect(isRealDate('2025-1-01')).toBe(false);
    expect(localToday(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });

  it('formats sizes', () => {
    expect(formatExportSize(null)).toBeNull();
    expect(formatExportSize(512)).toBe('512 B');
    expect(formatExportSize(48_213)).toBe('47 KB');
    expect(formatExportSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  it('posts exactly the five keys, datasets in canonical order', async () => {
    let body: unknown;
    server.use(
      http.post('*/api/health/exports', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ data: mockHealthExport() }, { status: 202 });
      }),
    );
    const extra = { format: 'csv', from: '2026-01-01', to: '2026-02-01', datasets: ['wellness', 'body'], includeHistory: false, junk: 1 };
    const created = await createHealthExport(extra as never);
    expect(body).toEqual({ format: 'csv', from: '2026-01-01', to: '2026-02-01', datasets: ['body', 'wellness'], includeHistory: false });
    expect(created.status).toBe('pending');
  });

  it('lists and reads exports through the envelope', async () => {
    server.use(
      http.get('*/api/health/exports', () => HttpResponse.json({ data: { items: [mockHealthExport()] } })),
      http.get('*/api/health/exports/:id', ({ params }) =>
        HttpResponse.json({ data: mockHealthExport({ id: String(params.id), status: 'running' }) }),
      ),
    );
    expect(await listHealthExports()).toHaveLength(1);
    expect((await getHealthExport('abc')).id).toBe('abc');
  });

  describe('describeHealthExportError', () => {
    it('maps the statuses a person can act on', () => {
      expect(describeHealthExportError(new ApiError('x', 429), 'f')).toBe(HEALTH_EXPORT_TOO_MANY_MESSAGE);
      expect(describeHealthExportError(new ApiError('x', 403), 'f')).toBe('Health data is not available for your account.');
      expect(describeHealthExportError(new ApiError('x', 404), 'f')).toBe('This export no longer exists.');
      expect(describeHealthExportError(new ApiError('x', 400), 'f')).toBe('Check the export settings and try again.');
      expect(
        describeHealthExportError(
          new ApiError('x', 400, 'VALIDATION_ERROR', {
            issues: [
              { path: 'datasets', message: 'Choose at least one dataset' },
              { path: 'to', message: 'The range may not exceed 3660 days' },
            ],
          }),
          'f',
        ),
      ).toBe('Check the export settings: Choose at least one dataset; The range may not exceed 3660 days.');
    });

    it('falls back for anything else', () => {
      expect(describeHealthExportError(new ApiError('x', 500), 'fallback')).toBe('fallback');
      expect(describeHealthExportError(new TypeError('network'), 'fallback')).toBe('fallback');
    });
  });
});
