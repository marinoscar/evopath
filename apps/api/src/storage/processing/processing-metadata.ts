import { Prisma } from '@prisma/client';

/**
 * The metadata a processed object carries: whatever was there before, plus the
 * processing record under `_processing` and the moment it was written under
 * `_processedAt`, plus `_processingFailed: true` when it ended badly.
 *
 * ONE builder for every writer of a processed row (#520): `ObjectsService`
 * marking an object with no applicable processor `ready` at upload time,
 * `ObjectProcessingService` after the processors ran, and the processing job's
 * give-up path. Three hand-rolled copies of this shape would be three places
 * for a row's metadata to disagree depending on which path settled it.
 */
export function buildProcessedMetadata(
  existing: Prisma.JsonValue | null | undefined,
  processing: Record<string, unknown>,
  options: { failed?: boolean; error?: string; processedAt?: Date } = {},
): Prisma.InputJsonValue {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};

  // A previous run's failure markers are dropped before this run's outcome is
  // written. Before #520 an object was processed exactly once, so they could
  // never be present; now a job can be re-run from the admin Jobs page, and a
  // row that succeeds on the re-run must not keep saying it failed.
  const {
    _processingFailed: _previousFailed,
    _processingError: _previousError,
    ...rest
  } = base;

  return {
    ...rest,
    _processing: processing,
    ...(options.failed ? { _processingFailed: true } : {}),
    ...(options.failed && options.error ? { _processingError: options.error } : {}),
    _processedAt: (options.processedAt ?? new Date()).toISOString(),
  } as Prisma.InputJsonValue;
}
