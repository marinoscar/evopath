import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { FILE_RETENTIONS, HEALTH_DOCUMENT_KINDS } from '../health-document.constants';
import { sanitizeDocumentName } from '../health-document-names';

// =============================================================================
// /api/health/documents — request and response schemas (H6, #190)
// =============================================================================
//
// Owner-scoped list, read, rename/date, download link and delete of the
// caller's health documents. `sizeBytes` is a BigInt column and is published
// as a decimal string, like every other byte count in this API.
// =============================================================================

export const HEALTH_DOCUMENT_PAGE_SIZE_DEFAULT = 20;
export const HEALTH_DOCUMENT_PAGE_SIZE_MAX = 100;

/** Longest name a rename keeps, after sanitising. */
export const HEALTH_DOCUMENT_NAME_MAX = 255;

/** Earliest `documentDate` accepted. */
export const HEALTH_DOCUMENT_DATE_MIN = '1900-01-01';

export const HEALTH_DOCUMENT_SORTS = ['createdAt', 'documentDate'] as const;
export const SORT_ORDERS = ['asc', 'desc'] as const;
export const DOWNLOAD_DISPOSITIONS = ['inline', 'attachment'] as const;
export type DownloadDisposition = (typeof DOWNLOAD_DISPOSITIONS)[number];

const queryBoolean = z.enum(['true', 'false']).transform((value) => value === 'true');

// -----------------------------------------------------------------------------
// Requests
// -----------------------------------------------------------------------------

export const listHealthDocumentsQuerySchema = z.object({
  kind: z.enum(HEALTH_DOCUMENT_KINDS).optional().meta({ description: 'Only documents of this kind.' }),
  sort: z
    .enum(HEALTH_DOCUMENT_SORTS)
    .default('createdAt')
    .meta({
      description:
        '`createdAt` (upload time, the default) or `documentDate` (date of service; documents without one sort last).',
    }),
  order: z.enum(SORT_ORDERS).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(HEALTH_DOCUMENT_PAGE_SIZE_MAX)
    .default(HEALTH_DOCUMENT_PAGE_SIZE_DEFAULT),
});
export class ListHealthDocumentsQueryDto extends createZodDto(listHealthDocumentsQuerySchema) {}
export type ListHealthDocumentsQuery = z.output<typeof listHealthDocumentsQuerySchema>;

export const downloadHealthDocumentQuerySchema = z.object({
  disposition: z
    .enum(DOWNLOAD_DISPOSITIONS)
    .default('inline')
    .meta({
      description:
        '`inline` (view in the browser, the default) or `attachment` (save). A type a browser should not ' +
        'render inline is always served as `attachment`.',
    }),
});
export class DownloadHealthDocumentQueryDto extends createZodDto(downloadHealthDocumentQuerySchema) {}

export const deleteHealthDocumentQuerySchema = z.object({
  deleteValues: queryBoolean
    .default(false)
    .meta({
      description:
        "`true` also soft-deletes the document's active measurements (those whose `sourceRef.healthDocumentId` " +
        'names it). Default `false`: the values stay.',
    }),
});
export class DeleteHealthDocumentQueryDto extends createZodDto(deleteHealthDocumentQuerySchema) {}

function isDocumentDate(value: string): boolean {
  const today = new Date();
  // One day of slack: the caller's "today" may be ahead of UTC.
  const latest = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1))
    .toISOString()
    .slice(0, 10);
  return value >= HEALTH_DOCUMENT_DATE_MIN && value <= latest;
}

const originalNameSchema = z
  .string()
  .max(HEALTH_DOCUMENT_NAME_MAX * 4, { message: `originalName must be at most ${HEALTH_DOCUMENT_NAME_MAX} characters` })
  .transform(sanitizeDocumentName)
  .pipe(
    z
      .string()
      .min(1, { message: 'originalName must not be empty' })
      .max(HEALTH_DOCUMENT_NAME_MAX, { message: `originalName must be at most ${HEALTH_DOCUMENT_NAME_MAX} characters` }),
  )
  .meta({
    description:
      `The display and download name. Control and direction-override characters are removed, \`/\` and \`\\\` ` +
      `become \`_\`, whitespace is collapsed; at most ${HEALTH_DOCUMENT_NAME_MAX} characters after that.`,
  });

export const updateHealthDocumentSchema = z
  .object({
    originalName: originalNameSchema.optional(),
    documentDate: z.iso
      .date({ message: 'documentDate must be a real calendar date in YYYY-MM-DD form' })
      .refine(isDocumentDate, { message: `documentDate must be between ${HEALTH_DOCUMENT_DATE_MIN} and today` })
      .nullable()
      .optional()
      .meta({ description: 'Date of service or collection, `YYYY-MM-DD`. Null clears it.' }),
  })
  .strict()
  .refine((body) => body.originalName !== undefined || body.documentDate !== undefined, {
    message: 'Send originalName, documentDate or both',
  });
export class UpdateHealthDocumentDto extends createZodDto(updateHealthDocumentSchema) {}
export type UpdateHealthDocument = z.output<typeof updateHealthDocumentSchema>;

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

export const healthDocumentSchema = z.object({
  id: z.uuid(),
  kind: z.string().meta({ description: '`body_metric` or `lab_report` (open to extension).' }),
  originalName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.string().meta({ description: 'File size in bytes, as a decimal string (a BigInt column).' }),
  documentDate: z.iso.date().nullable().meta({ description: 'Date of service or collection, `YYYY-MM-DD`; null when unknown.' }),
  createdAt: z.iso.datetime().meta({ description: 'Upload time.' }),
  updatedAt: z.iso.datetime(),
  retention: z.enum(FILE_RETENTIONS).meta({ description: 'The choice made at upload.' }),
  valueCount: z
    .number()
    .int()
    .meta({ description: 'Active measurements read from this document (`sourceRef.healthDocumentId`).' }),
  fileAvailable: z.boolean().meta({ description: 'The file still exists and can be downloaded.' }),
  fileDeletedAt: z.iso.datetime().nullable().meta({ description: 'When the file was erased; null while it exists.' }),
  fileDeletionPending: z
    .boolean()
    .meta({ description: 'A purge of the file is queued or running (the owner deleted it, or delete after processing).' }),
  intakeId: z.uuid().nullable().meta({ description: 'The intake the file came through; null once that intake is gone.' }),
  version: z.number().int().meta({ description: 'Send it back as `If-Match` on PATCH and DELETE. Also the `ETag`.' }),
});
export class HealthDocumentDto extends createZodDto(healthDocumentSchema) {}
export type HealthDocumentView = z.infer<typeof healthDocumentSchema>;

export interface HealthDocumentPage {
  items: HealthDocumentView[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export const healthDocumentDownloadSchema = z.object({
  url: z.string().meta({ description: 'Short-lived signed URL. Do not store or share it.' }),
  expiresIn: z.number().int().meta({ description: 'Seconds the URL stays valid (at most 300).' }),
  expiresAt: z.iso.datetime(),
  disposition: z.enum(DOWNLOAD_DISPOSITIONS).meta({ description: 'The disposition the URL was signed with.' }),
  fileName: z.string().meta({ description: 'The file name the URL serves, after sanitising.' }),
  mimeType: z.string(),
});
export class HealthDocumentDownloadDto extends createZodDto(healthDocumentDownloadSchema) {}
export type HealthDocumentDownload = z.infer<typeof healthDocumentDownloadSchema>;

export const HEALTH_DOCUMENT_DELETE_SCOPES = ['file', 'record'] as const;

export const healthDocumentDeleteResultSchema = z.object({
  id: z.uuid(),
  scope: z.enum(HEALTH_DOCUMENT_DELETE_SCOPES).meta({
    description:
      '`file`: the file purge is queued and the document stays, listed with `fileDeletionPending` until the file is ' +
      'gone, then as metadata only. `record`: the file was already gone and the document row is removed.',
  }),
  jobId: z.uuid().nullable().meta({ description: 'The queued `health.document.purge` job (scope `file`).' }),
  valuesDeleted: z.number().int().meta({ description: 'Measurements soft-deleted (0 unless `deleteValues=true`).' }),
});
export class HealthDocumentDeleteResultDto extends createZodDto(healthDocumentDeleteResultSchema) {}
export type HealthDocumentDeleteResult = z.infer<typeof healthDocumentDeleteResultSchema>;
