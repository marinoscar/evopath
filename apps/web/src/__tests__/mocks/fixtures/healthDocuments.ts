/**
 * Health documents fixtures (issue #190, H6), shaped exactly as
 * `GET /api/health/documents` answers inside the `{ data }` envelope.
 */
import type { HealthDocument, HealthDocumentList } from '../../../services/healthDocuments';

/** A kept lab report PDF with four extracted values. */
export const mockLabReportPdf: HealthDocument = {
  id: 'doc11111-0000-4000-8000-000000000001',
  kind: 'lab_report',
  originalName: 'lipid-panel.pdf',
  mimeType: 'application/pdf',
  sizeBytes: '1400000',
  documentDate: '2026-09-15',
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
  retention: 'keep',
  valueCount: 4,
  fileAvailable: true,
  fileDeletedAt: null,
  fileDeletionPending: false,
  intakeId: 'intake-1',
  version: 3,
};

/** A scale photo with no extracted values and no document date. */
export const mockScalePhoto: HealthDocument = {
  id: 'doc22222-0000-4000-8000-000000000002',
  kind: 'body_metric',
  originalName: 'scale.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: '820',
  documentDate: null,
  createdAt: '2026-09-18T08:00:00.000Z',
  updatedAt: '2026-09-18T08:00:00.000Z',
  retention: 'keep',
  valueCount: 0,
  fileAvailable: true,
  fileDeletedAt: null,
  fileDeletionPending: false,
  intakeId: 'intake-2',
  version: 1,
};

/** Metadata only: the file was erased after processing; two values remain. */
export const mockDeletedFile: HealthDocument = {
  id: 'doc33333-0000-4000-8000-000000000003',
  kind: 'body_metric',
  originalName: 'old-scale.png',
  mimeType: 'image/png',
  sizeBytes: '52000',
  documentDate: null,
  createdAt: '2026-08-01T08:00:00.000Z',
  updatedAt: '2026-08-02T08:00:00.000Z',
  retention: 'delete_after_processing',
  valueCount: 2,
  fileAvailable: false,
  fileDeletedAt: '2026-08-02T08:00:00.000Z',
  fileDeletionPending: false,
  intakeId: 'intake-3',
  version: 2,
};

/** A file whose purge job is queued. */
export const mockDeletionPending: HealthDocument = {
  ...mockScalePhoto,
  id: 'doc44444-0000-4000-8000-000000000004',
  originalName: 'pending.jpg',
  fileDeletionPending: true,
  version: 5,
};

export function mockHealthDocumentList(
  items: HealthDocument[],
  total = items.length
): HealthDocumentList {
  return { items, total, page: 1, pageSize: 25, totalPages: Math.max(1, Math.ceil(total / 25)) };
}
