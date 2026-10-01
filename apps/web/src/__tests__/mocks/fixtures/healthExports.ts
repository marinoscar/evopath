/**
 * Health export fixtures (issue #191, H7), shaped exactly as
 * `/api/health/exports` answers inside the `{ data }` envelope.
 */
import type { HealthExport } from '../../../services/healthExport';

export const MOCK_HEALTH_EXPORT_ID = '0b8f3c1e-5d2a-4e7b-9a10-6c2d8e4f1a01';

/** A queued PDF export of the last three months; override any field. */
export function mockHealthExport(overrides: Partial<HealthExport> = {}): HealthExport {
  return {
    id: MOCK_HEALTH_EXPORT_ID,
    status: 'pending',
    format: 'pdf',
    from: '2026-07-01',
    to: '2026-10-01',
    datasets: ['profile', 'body', 'vitals', 'labs', 'wellness', 'documents', 'progress_photos'],
    includeHistory: false,
    labUnits: 'conventional',
    createdAt: '2026-10-01T09:00:00.000Z',
    completedAt: null,
    expiresAt: null,
    fileName: null,
    sizeBytes: null,
    rowCounts: null,
    error: null,
    download: null,
    ...overrides,
  };
}

/** The same export once the file is committed (no URL: the list never carries one). */
export function mockReadyHealthExport(overrides: Partial<HealthExport> = {}): HealthExport {
  return mockHealthExport({
    status: 'ready',
    completedAt: '2026-10-01T09:00:05.000Z',
    expiresAt: '2026-10-08T09:00:05.000Z',
    fileName: 'app-health-2026-07-01-2026-10-01.pdf',
    sizeBytes: 48_213,
    rowCounts: { profile: 1, body: 12, vitals: 4, labs: 0, wellness: 30, documents: 2, progress_photos: 3 },
    ...overrides,
  });
}

/** A signed URL, as `GET /api/health/exports/:id` mints one while ready. */
export function mockHealthExportDownloadUrl(id: string): string {
  return `https://storage.test/exports/${id}?signature=fresh`;
}
