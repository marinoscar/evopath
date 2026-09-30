import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { USER_DATA_RESET_CONFIRMATION } from '../user-data.constants';

// =============================================================================
// /api/user-data — request and response shapes (issue #202)
// =============================================================================

const count = z.number().int().nonnegative();

/** `GET /api/user-data/summary`: what the caller owns, i.e. what a reset deletes. */
export const userDataSummarySchema = z.object({
  workouts: count,
  gyms: count,
  /** Active measurement readings, check-in scores included. */
  measurements: count,
  programs: count,
  trainingRuns: count,
  customExercises: count,
  /** Storage objects (photos, avatar, other uploads) the caller uploaded. */
  photos: count,
  aiKeys: count,
  /** Personal access tokens that are not revoked. */
  accessTokens: count,
  notifications: count,
  customEquipment: count,
  photoIntakes: count,
  workoutAdaptations: count,
  userCredentials: count,
});

/** `POST /api/user-data/reset` body. Anything but the exact phrase is a 400. */
export const userDataResetRequestSchema = z.object({
  confirmation: z.literal(USER_DATA_RESET_CONFIRMATION, {
    error: `Type exactly "${USER_DATA_RESET_CONFIRMATION}" to confirm`,
  }),
});

export const USER_DATA_RESET_STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const;

/** `POST /api/user-data/reset` 202 response. */
export const userDataResetStartedSchema = z.object({
  /** The reset job: a new one, or the one already pending/running for the caller. */
  jobId: z.string(),
  status: z.enum(USER_DATA_RESET_STATUSES),
});

/** What a finished reset deleted, per category. Written by the job on `payload.result`. */
export const userDataResetResultSchema = z.object({
  workouts: count,
  gyms: count,
  measurements: count,
  healthProfiles: count,
  photoIntakes: count,
  programs: count,
  programChangeLogs: count,
  trainingRuns: count,
  workoutAdaptations: count,
  trainingCheckpoints: count,
  customExercises: count,
  customEquipment: count,
  aiRuns: count,
  aiUsageEvents: count,
  aiKeys: count,
  userCredentials: count,
  accessTokens: count,
  deviceCodes: count,
  pushSubscriptions: count,
  notifications: count,
  notificationDeliveries: count,
  userSettings: count,
  /** The caller's other PENDING jobs whose subject was deleted. */
  cancelledJobs: count,
  storageObjectsDeleted: count,
  /** Objects the storage provider refused to delete; their rows are kept. */
  storageObjectsFailed: count,
});

/** `GET /api/user-data/reset/:jobId`. */
export const userDataResetStatusSchema = z.object({
  jobId: z.string(),
  status: z.enum(USER_DATA_RESET_STATUSES),
  /** Present once the job has succeeded. */
  result: userDataResetResultSchema.optional(),
  /** Present when the job has failed: its last error. */
  error: z.string().optional(),
});

export class UserDataSummaryDto extends createZodDto(userDataSummarySchema) {}
export class UserDataResetRequestDto extends createZodDto(userDataResetRequestSchema) {}
export class UserDataResetStartedDto extends createZodDto(userDataResetStartedSchema) {}
export class UserDataResetStatusDto extends createZodDto(userDataResetStatusSchema) {}

export type UserDataSummary = z.infer<typeof userDataSummarySchema>;
export type UserDataResetStarted = z.infer<typeof userDataResetStartedSchema>;
export type UserDataResetResult = z.infer<typeof userDataResetResultSchema>;
export type UserDataResetStatus = z.infer<typeof userDataResetStatusSchema>;
