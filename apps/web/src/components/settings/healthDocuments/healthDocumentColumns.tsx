/**
 * Settings → Health Documents: the DataTable column contract (issue #190, H6).
 *
 * ## What `GET /api/health/documents` honours
 *
 * | Column         | Param                                   |
 * |----------------|-----------------------------------------|
 * | `kind`         | `kind` (`is` only)                      |
 * | `createdAt`    | `sort=createdAt` (the default, newest first) |
 * | `documentDate` | `sort=documentDate` (undated last)       |
 *
 * Nothing else sorts or filters, so no other column declares either flag. The
 * column `id`s of the two sortable columns ARE the API's sort keys.
 *
 * ## Names are not unique
 *
 * Two uploads may both be called `scan.jpg`. The first `primary` column's
 * scalar names every row control ("Row actions for …"), so `value` carries a
 * short id suffix, applied unconditionally (a pure function of one row), the
 * same decision `patColumns.tsx` documents. `render` keeps the plain name.
 */

import { Chip, Typography } from '@mui/material';
import type { DataTableColumn } from '../../datatable';
import {
  HEALTH_DOCUMENT_KIND_LABELS,
  HEALTH_DOCUMENT_KINDS,
  type HealthDocument,
  type HealthDocumentKind,
  type HealthDocumentSortField,
} from '../../../services/healthDocuments';

/** Persistence key for `user_settings.dataTables`. */
export const TABLE_ID = 'settings-health-documents';

/** Only these two columns sort; anything else maps to the API default. */
export function asHealthDocumentSortField(field: string | undefined): HealthDocumentSortField | undefined {
  return field === 'createdAt' || field === 'documentDate' ? field : undefined;
}

export function kindLabel(kind: string): string {
  return (HEALTH_DOCUMENT_KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

export function isHealthDocumentKind(value: unknown): value is HealthDocumentKind {
  return typeof value === 'string' && (HEALTH_DOCUMENT_KINDS as readonly string[]).includes(value);
}

const MIME_LABELS: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/png': 'PNG image',
  'image/jpeg': 'JPEG image',
  'image/gif': 'GIF image',
  'image/webp': 'WebP image',
};

/** "PDF", "JPEG image"; an unknown type shows itself. */
export function fileTypeLabel(mimeType: string): string {
  return MIME_LABELS[mimeType] ?? mimeType;
}

/** Whether the browser can draw the file inline (the API signs `inline` only for these). */
export function viewerKind(mimeType: string): 'pdf' | 'image' | null {
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType in MIME_LABELS && mimeType.startsWith('image/')) return 'image';
  return null;
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'];

/** `sizeBytes` (a decimal string) as "820 B", "1.4 MB", "12 MB". */
export function formatFileSize(sizeBytes: string): string {
  const bytes = Number(sizeBytes);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return `${bytes} B`;
  let scaled = bytes;
  let unit = 0;
  while (scaled >= 1000 && unit < SIZE_UNITS.length - 1) {
    scaled /= 1000;
    unit += 1;
  }
  return `${scaled < 10 ? scaled.toFixed(1) : Math.round(scaled)} ${SIZE_UNITS[unit]}`;
}

/** A `YYYY-MM-DD` date as a calendar date, in UTC so no time zone moves it. */
export function formatDocumentDate(value: string | null): string {
  if (!value) return 'Not set';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toLocaleDateString(undefined, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** An ISO instant as a date in the browser's zone ("Sep 29, 2026"). */
export function formatInstantDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** The file's state as one phrase: available, being deleted, or deleted on a date. */
export function fileStatusText(doc: HealthDocument): string {
  if (doc.fileDeletedAt) return `File deleted on ${formatInstantDate(doc.fileDeletedAt)}`;
  if (doc.fileDeletionPending) return 'Deleting…';
  if (!doc.fileAvailable) return 'File unavailable';
  return 'Available';
}

export function retentionLabel(retention: string): string {
  return retention === 'delete_after_processing' ? 'Delete after processing' : 'Keep';
}

/** The name controls are announced with: the name plus a short id suffix. */
export function documentAccessibleName(doc: HealthDocument): string {
  return `${doc.originalName} (${doc.id.slice(0, 8)})`;
}

export function buildHealthDocumentColumns(): DataTableColumn<HealthDocument>[] {
  return [
    {
      id: 'originalName',
      label: 'Name',
      priority: 'primary',
      hideable: false,
      truncate: true,
      minWidth: 200,
      flex: 1.6,
      value: documentAccessibleName,
      render: (doc) => doc.originalName,
    },
    {
      id: 'kind',
      label: 'Kind',
      priority: 'secondary',
      filterable: ['is'],
      filterType: 'enum',
      enumValues: HEALTH_DOCUMENT_KINDS.map((kind) => ({ value: kind, label: kindLabel(kind) })),
      width: 130,
      value: (doc) => kindLabel(doc.kind),
    },
    {
      id: 'mimeType',
      label: 'Type',
      priority: 'secondary',
      width: 120,
      value: (doc) => fileTypeLabel(doc.mimeType),
    },
    {
      id: 'sizeBytes',
      label: 'Size',
      priority: 'secondary',
      align: 'right',
      width: 90,
      value: (doc) => formatFileSize(doc.sizeBytes),
    },
    {
      id: 'documentDate',
      label: 'Document date',
      priority: 'secondary',
      sortable: true,
      width: 140,
      value: (doc) => formatDocumentDate(doc.documentDate),
    },
    {
      id: 'createdAt',
      label: 'Uploaded',
      priority: 'secondary',
      sortable: true,
      width: 130,
      value: (doc) => formatInstantDate(doc.createdAt),
    },
    {
      id: 'file',
      label: 'File',
      priority: 'secondary',
      minWidth: 170,
      flex: 1,
      value: fileStatusText,
      render: (doc) =>
        doc.fileDeletedAt || doc.fileDeletionPending || !doc.fileAvailable ? (
          <Chip
            size="small"
            variant="outlined"
            color={doc.fileDeletionPending ? 'warning' : 'default'}
            label={fileStatusText(doc)}
          />
        ) : (
          <Typography variant="body2" component="span">
            Available
          </Typography>
        ),
    },
    {
      id: 'valueCount',
      label: 'Values',
      priority: 'detail',
      align: 'right',
      width: 90,
      value: (doc) => doc.valueCount,
    },
    {
      id: 'retention',
      label: 'Retention',
      priority: 'detail',
      width: 180,
      value: (doc) => retentionLabel(doc.retention),
    },
  ];
}
