import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { userDataResetResultSchema } from '../../user-data/dto/user-data.dto';
import { ADMIN_FACTORY_RESET_CONFIRMATION } from '../admin-factory-reset.constants';

// =============================================================================
// /api/admin/factory-reset — request and response shapes (issue #211)
// =============================================================================

const count = z.number().int().nonnegative();

/** `GET /api/admin/factory-reset/summary`: what a factory reset deletes, deployment-wide. */
export const adminFactoryResetSummarySchema = z.object({
  /** Users other than the caller; their accounts are deleted. */
  otherUsers: count,
  workouts: count,
  gyms: count,
  /** Active measurement readings, check-in scores included. */
  measurements: count,
  /** Health documents (lab reports, body-metric photos), kept files or not. */
  healthDocuments: count,
  programs: count,
  trainingRuns: count,
  /** Storage objects, excluding database backup archives (which are kept). */
  storageObjects: count,
  /** Job rows that are not running and not linked to a backup run. */
  jobs: count,
  notifications: count,
  /** Allowlist entries other than the caller's own. */
  allowlistEntries: count,
  broadcasts: count,
  aiRuns: count,
  customExercises: count,
  customEquipment: count,
});

/** `POST /api/admin/factory-reset` body. Anything but the exact phrase is a 400. */
export const adminFactoryResetRequestSchema = z.object({
  confirmation: z.literal(ADMIN_FACTORY_RESET_CONFIRMATION, {
    error: `Type exactly "${ADMIN_FACTORY_RESET_CONFIRMATION}" to confirm`,
  }),
});

export const ADMIN_FACTORY_RESET_STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const;

/** `POST /api/admin/factory-reset` 202 response. */
export const adminFactoryResetStartedSchema = z.object({
  /** The factory reset job: a new one, or the one already pending/running. */
  jobId: z.string(),
  status: z.enum(ADMIN_FACTORY_RESET_STATUSES),
});

/**
 * What a finished factory reset deleted. The per-user categories are the
 * user data reset's (summed over every user, the caller included, plus
 * orphaned rows swept deployment-wide); the rest are deployment-level.
 */
export const adminFactoryResetResultSchema = userDataResetResultSchema.extend({
  /** User accounts deleted (everyone but the caller). */
  usersDeleted: count,
  /** Finished and pending job rows deleted (running jobs and backup-linked jobs are kept). */
  jobs: count,
  jobStatsRollups: count,
  allowlistEntries: count,
  broadcasts: count,
  /** Worker nodes and node credentials of deleted users, handed to the caller. */
  workerNodesReassigned: count,
  nodeCredentialsReassigned: count,
  /** Nodes of deleted users whose name the caller already used; removed with their owner. */
  workerNodesRemoved: count,
});

/** `GET /api/admin/factory-reset/:jobId`. */
export const adminFactoryResetStatusSchema = z.object({
  jobId: z.string(),
  status: z.enum(ADMIN_FACTORY_RESET_STATUSES),
  /** Present once the job has succeeded. */
  result: adminFactoryResetResultSchema.optional(),
  /** Present when the job has failed: its last error. */
  error: z.string().optional(),
});

export class AdminFactoryResetSummaryDto extends createZodDto(adminFactoryResetSummarySchema) {}
export class AdminFactoryResetRequestDto extends createZodDto(adminFactoryResetRequestSchema) {}
export class AdminFactoryResetStartedDto extends createZodDto(adminFactoryResetStartedSchema) {}
export class AdminFactoryResetStatusDto extends createZodDto(adminFactoryResetStatusSchema) {}

export type AdminFactoryResetSummary = z.infer<typeof adminFactoryResetSummarySchema>;
export type AdminFactoryResetStarted = z.infer<typeof adminFactoryResetStartedSchema>;
export type AdminFactoryResetResult = z.infer<typeof adminFactoryResetResultSchema>;
export type AdminFactoryResetStatus = z.infer<typeof adminFactoryResetStatusSchema>;
