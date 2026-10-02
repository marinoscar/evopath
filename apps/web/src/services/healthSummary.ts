/**
 * The opt-in AI health summary (H8, #192): "Use my health summary in training
 * plans and coach chat" (#327), as the web app sees it (`/api/ai/training/health-summary`).
 *
 * Every route sits behind the AI kill switch and `ai:use`; reading also needs
 * `health_data:read`, changing the consent or refreshing `health_data:write`.
 * The API decides everything (what is shared, which model writes the summary,
 * whether it is stale); the browser only renders the view and sends the
 * user's choice. No response carries key material or raw health values.
 */
import { api } from './api';
import type { RoleResolutionState } from './trainingAgents';

/** `details.reason` of a refused refresh (409). */
export const HEALTH_SUMMARY_CONSENT_OFF = 'HEALTH_SUMMARY_CONSENT_OFF';
export const HEALTH_SUMMARY_NO_DATA = 'HEALTH_SUMMARY_NO_DATA';

export type HealthSummarySeverity = 'info' | 'caution';

export interface HealthSummaryConsideration {
  text: string;
  severity: HealthSummarySeverity;
  /** A flagged consideration that switches the planner to conservative mode. */
  conservative: boolean;
}

export interface HealthSummaryText {
  version: number;
  narrative: string;
  trainingConsiderations: HealthSummaryConsideration[];
  /** `YYYY-MM-DD`: the newest health input the summary covers. */
  dataAsOf: string | null;
  createdAt: string;
  provider: string | null;
  model: string | null;
}

export interface HealthSummaryAttempt {
  version: number;
  status: 'ready' | 'failed';
  errorCode: string | null;
  createdAt: string;
}

export interface HealthSummaryProcessor {
  provider: string;
  modelId: string;
  displayName: string;
}

/** `GET /api/ai/training/health-summary` (and the PUT/POST answers). */
export interface HealthSummaryView {
  enabled: boolean;
  consentedAt: string | null;
  sharing: {
    shared: string[];
    neverShared: string[];
    modelState: RoleResolutionState;
    processor: HealthSummaryProcessor | null;
  };
  summary: HealthSummaryText | null;
  lastAttempt: HealthSummaryAttempt | null;
  hasData: boolean;
  stale: boolean;
  pending: boolean;
}

/** Model states in which a summary can be written. */
export const RUNNABLE_HEALTH_SUMMARY_STATES: readonly RoleResolutionState[] = ['ready', 'auto'];

export async function getHealthSummary(): Promise<HealthSummaryView> {
  return api.get<HealthSummaryView>('/ai/training/health-summary');
}

export async function setHealthSummaryConsent(enabled: boolean): Promise<HealthSummaryView> {
  return api.put<HealthSummaryView>('/ai/training/health-summary/consent', { enabled });
}

export async function refreshHealthSummary(): Promise<HealthSummaryView> {
  return api.post<HealthSummaryView>('/ai/training/health-summary/refresh');
}
