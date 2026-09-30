/**
 * Admin factory reset (issue #211): what the whole deployment holds, and the
 * job that erases it.
 *
 *   GET  /api/admin/factory-reset/summary   deployment-wide counts a reset would delete
 *   POST /api/admin/factory-reset           enqueue the reset (202 `{ jobId, status }`)
 *   GET  /api/admin/factory-reset/:jobId    the reset job's status
 *
 * All three enforce `system:factory_reset`, which only the Admin role holds.
 * The API decides what is deleted and re-checks the confirmation phrase; the
 * browser only collects it.
 */
import { api } from './api';

/**
 * The phrase the API requires in the reset body. Case-sensitive, exact. The
 * page shows it verbatim and compares against this same constant, so the text
 * the admin is asked to type and the text sent can never drift apart.
 */
export const FACTORY_RESET_CONFIRMATION_PHRASE = 'FACTORY RESET';

export type FactoryResetStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface FactoryResetAccepted {
  jobId: string;
  status: FactoryResetStatus;
}

/** Known summary counts. Every key is optional: a newer API may add or drop one. */
export interface FactoryResetSummary {
  otherUsers?: number;
  workouts?: number;
  gyms?: number;
  measurements?: number;
  programs?: number;
  trainingRuns?: number;
  storageObjects?: number;
  jobs?: number;
  notifications?: number;
  allowlistEntries?: number;
  broadcasts?: number;
  aiRuns?: number;
  customExercises?: number;
  customEquipment?: number;
  [key: string]: number | undefined;
}

/** What a finished reset reports. Counts beyond the two storage fields are open-ended. */
export interface FactoryResetResult {
  /** User accounts deleted (everyone but the caller). */
  usersDeleted?: number;
  storageObjectsDeleted?: number;
  storageObjectsFailed?: number;
  [key: string]: number | undefined;
}

export interface FactoryResetJob {
  jobId: string;
  status: FactoryResetStatus;
  result?: FactoryResetResult | null;
  error?: string | null;
}

export function getFactoryResetSummary(): Promise<FactoryResetSummary> {
  return api.get<FactoryResetSummary>('/admin/factory-reset/summary');
}

export function startFactoryReset(confirmation: string): Promise<FactoryResetAccepted> {
  return api.post<FactoryResetAccepted>('/admin/factory-reset', { confirmation });
}

export function getFactoryResetJob(jobId: string): Promise<FactoryResetJob> {
  return api.get<FactoryResetJob>(`/admin/factory-reset/${encodeURIComponent(jobId)}`);
}
