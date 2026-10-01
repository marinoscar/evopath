import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// GET /api/storage/status — response (#204)
// =============================================================================
//
// One boolean and nothing else. The provider, bucket, region and credentials
// are an administrator's business (`storage_config:read`); this answer goes to
// every `storage:read` holder so the web app can show "not enabled yet"
// instead of an upload control that would fail.
// =============================================================================

export const storageStatusResponseSchema = z.object({
  /** The object-storage configuration is complete (the Doctor's `storage.config` would pass). */
  configured: z.boolean(),
});

export class StorageStatusResponseDto extends createZodDto(storageStatusResponseSchema) {}

export type StorageStatusResponse = z.infer<typeof storageStatusResponseSchema>;
