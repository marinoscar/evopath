/**
 * Per-user factory reset (issue #202): what the caller owns, and the job that
 * deletes it.
 *
 *   GET  /api/user-data/summary        counts of what a reset would delete
 *   POST /api/user-data/reset          enqueue the reset (202 `{ jobId, status }`)
 *   GET  /api/user-data/reset/:jobId   the reset job's status
 *
 * All three are caller-scoped on the server and enforce `user_settings:write`,
 * which every role holds. The API decides what is deleted and re-checks the
 * confirmation phrase; the browser only collects it.
 */
import { api } from './api';

/**
 * The phrase the API requires in the reset body. Case-sensitive, exact. The
 * page shows it verbatim and compares against this same constant, so the text
 * the user is asked to type and the text sent can never drift apart.
 */
export const RESET_CONFIRMATION_PHRASE = 'DELETE MY DATA';

/** Known summary counts. Every key is optional: a newer API may add or drop one. */
export interface UserDataSummary {
  workouts?: number;
  gyms?: number;
  measurements?: number;
  programs?: number;
  trainingRuns?: number;
  customExercises?: number;
  photos?: number;
  aiKeys?: number;
  accessTokens?: number;
  notifications?: number;
  [key: string]: number | undefined;
}

export type UserDataResetStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface UserDataResetAccepted {
  jobId: string;
  status: UserDataResetStatus;
}

/** What a finished reset reports. Counts beyond the two storage fields are open-ended. */
export interface UserDataResetResult {
  storageObjectsDeleted?: number;
  storageObjectsFailed?: number;
  [key: string]: number | undefined;
}

export interface UserDataResetJob {
  jobId: string;
  status: UserDataResetStatus;
  result?: UserDataResetResult | null;
  error?: string | null;
}

export function getUserDataSummary(): Promise<UserDataSummary> {
  return api.get<UserDataSummary>('/user-data/summary');
}

export function startUserDataReset(confirmation: string): Promise<UserDataResetAccepted> {
  return api.post<UserDataResetAccepted>('/user-data/reset', { confirmation });
}

export function getUserDataResetJob(jobId: string): Promise<UserDataResetJob> {
  return api.get<UserDataResetJob>(`/user-data/reset/${encodeURIComponent(jobId)}`);
}
