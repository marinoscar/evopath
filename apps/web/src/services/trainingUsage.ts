/**
 * Usage and cost by agent role (E6.3): what one agent run used, by step and
 * role, and what the agents used in one UTC month.
 *
 *   GET /api/ai/training/runs/:runId/usage   one of my runs
 *   GET /api/ai/training/usage?month=YYYY-MM my agent runs in one UTC month
 *
 * Both sit behind `ai:use` and the AI kill switch (`403 AI_DISABLED`), and are
 * caller-scoped on the server: another user's run is `404`. Mirrors
 * `apps/api/src/training-usage/dto/training-usage.dto.ts`.
 *
 * TOKENS, NOT CURRENCY. The platform has no price catalog, so nothing here (or
 * in any view of it) turns tokens into money.
 */
import { api } from './api';
import type { AiKeySource } from './ai';
import type { TrainingAgentRole } from '../types';

/**
 * One bucket. `requests` counts every recorded round trip, failed ones
 * included; `reasoningTokens` is a breakdown INSIDE `outputTokens`, never
 * added on top; `latencyMs` is the summed provider latency; `orgKey*` is the
 * part the organisation's key paid for.
 */
export interface TrainingUsageBucket {
  requests: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  latencyMs: number;
  orgKeyRequests: number;
  orgKeyInputTokens: number;
  orgKeyOutputTokens: number;
}

export interface TrainingRunUsageNode extends TrainingUsageBucket {
  /** The graph node; `null` on the final "not attributed to one step" row. */
  node: string | null;
  role: TrainingAgentRole | null;
  provider: string | null;
  modelId: string | null;
  keySource: AiKeySource | string | null;
}

/** The run's per-run token cap as a meter. `usedTokens` is the count the cap enforces. */
export interface TrainingRunCap {
  limitTokens: number;
  usedTokens: number;
  reached: boolean;
  reason?: 'token_cap';
}

/** `GET /api/ai/training/runs/:runId/usage`. */
export interface TrainingRunUsage {
  runId: string;
  jobId: string | null;
  kind: string;
  status: string;
  totals: TrainingUsageBucket;
  byNode: TrainingRunUsageNode[];
  cap: TrainingRunCap;
  /** `purged`: the run's usage rows were removed after `retentionDays`; numbers come from the run's own tally. */
  retention: { purged: boolean; retentionDays: number };
}

export const UNATTRIBUTED_ROLE = 'unattributed';

export type TrainingUsageKind = 'create' | 'revise' | 'evaluate' | 'adapt';

export interface TrainingTypicalUsage {
  /** Completed runs the median was taken over (at most 10). */
  runs: number;
  medianTokens: number;
}

/** `GET /api/ai/training/usage?month=YYYY-MM`. */
export interface TrainingMonthlyUsage {
  month: string;
  /** UTC days, both inclusive. */
  range: { from: string; to: string };
  totals: TrainingUsageBucket;
  byRole: Array<TrainingUsageBucket & { role: TrainingAgentRole | typeof UNATTRIBUTED_ROLE }>;
  byModel: Array<TrainingUsageBucket & { provider: string; modelId: string }>;
  byKeySource: Array<TrainingUsageBucket & { keySource: AiKeySource | string }>;
  byKind: Array<TrainingUsageBucket & { kind: TrainingUsageKind | string; runs: number }>;
  /** From the user's own history (not this month): `null` with fewer than 3 completed runs. */
  typical: Record<TrainingUsageKind, TrainingTypicalUsage | null>;
  /** `partial`: some of this month is older than `retentionDays`, so usage rows may be gone. */
  retention: { partial: boolean; retentionDays: number };
}

/** How many whole months back the monthly report may reach (the current month is 0). */
export const TRAINING_USAGE_MAX_MONTHS_BACK = 12;

/** Stable reason for an unusable `month` (400). */
export const TRAINING_USAGE_MONTH_INVALID = 'TRAINING_USAGE_MONTH_INVALID';

export function getTrainingRunUsage(runId: string): Promise<TrainingRunUsage> {
  return api.get<TrainingRunUsage>(`/ai/training/runs/${encodeURIComponent(runId)}/usage`);
}

export function getMonthlyTrainingUsage(month?: string): Promise<TrainingMonthlyUsage> {
  const query = month ? `?month=${encodeURIComponent(month)}` : '';
  return api.get<TrainingMonthlyUsage>(`/ai/training/usage${query}`);
}

/** `YYYY-MM` of `date` in UTC. */
export function utcMonthOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The months the report may be asked for, newest first: the current UTC month and the 12 before it. */
export function selectableUsageMonths(now: Date = new Date()): string[] {
  const months: string[] = [];
  for (let back = 0; back <= TRAINING_USAGE_MAX_MONTHS_BACK; back += 1) {
    months.push(utcMonthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))));
  }
  return months;
}

/** `2026-09` → `September 2026`. */
export function formatUsageMonth(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
