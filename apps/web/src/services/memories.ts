/**
 * User memory (#325; docs/specs/user-memory.md): what the AI Coach remembers
 * about the caller, and the caller's own memory preferences.
 *
 * Every route under `/api/memories` requires `ai:use` and AI being on; the API
 * decides everything (limits, health sensitivity, whether memory is on). This
 * module only moves data and turns a refusal into a sentence.
 *
 * The caller's memory PREFERENCES live in the user-settings document
 * (`user_settings.memory`) and are written with `PATCH /api/user-settings`;
 * `GET /api/memories` echoes them (`settings`) next to the deployment's policy
 * so the page can render from one read.
 */
import { api, ApiError } from './api';
import type { MemorySettingsPatch, UserSettings } from '../types';

// -----------------------------------------------------------------------------
// Categories
// -----------------------------------------------------------------------------

/** Mirrors the API's memory categories, in display order. */
export const MEMORY_CATEGORIES = [
  'goal',
  'preference',
  'constraint_injury',
  'schedule',
  'equipment',
  'training_history',
  'nutrition',
  'coaching_style',
  'other',
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
  goal: 'Goals',
  preference: 'Preferences',
  constraint_injury: 'Injuries & limits',
  schedule: 'Schedule',
  equipment: 'Equipment',
  training_history: 'Training history',
  nutrition: 'Nutrition',
  coaching_style: 'Coaching style',
  other: 'Other',
};

/** A label for any category string, including one this build does not know. */
export function memoryCategoryLabel(category: string): string {
  return (MEMORY_CATEGORY_LABELS as Record<string, string>)[category] ?? MEMORY_CATEGORY_LABELS.other;
}

export function isMemoryCategory(value: string): value is MemoryCategory {
  return (MEMORY_CATEGORIES as readonly string[]).includes(value);
}

// -----------------------------------------------------------------------------
// Shapes
// -----------------------------------------------------------------------------

export type MemorySource = 'explicit' | 'extracted' | 'user_edited';
export type MemorySensitivity = 'normal' | 'health';

export const MEMORY_SOURCE_LABELS: Record<MemorySource, string> = {
  explicit: 'You said',
  extracted: 'Coach learned',
  user_edited: 'Edited',
};

export interface UserMemory {
  id: string;
  content: string;
  category: MemoryCategory;
  source: MemorySource;
  sensitivity: MemorySensitivity;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

/** The caller's preferences with defaults applied (server-side). */
export interface MemoryUserSettingsView {
  enabled: boolean;
  autoExtract: boolean;
  allowHealth: boolean;
  disclosureSeenAt: string | null;
}

/** The deployment's memory policy, as far as a user needs it. */
export interface MemoryPolicyView {
  enabled: boolean;
  autoExtract: boolean;
  maxPerUser: number;
}

export interface MemoryListView {
  items: UserMemory[];
  settings: MemoryUserSettingsView;
  policy: MemoryPolicyView;
  counts: { active: number; byCategory: Partial<Record<string, number>> };
}

export interface MemoryCreateInput {
  content: string;
  category: MemoryCategory;
  sensitivity?: MemorySensitivity;
}

export interface MemoryUpdateInput {
  content?: string;
  category?: MemoryCategory;
  pinned?: boolean;
  sensitivity?: MemorySensitivity;
}

/** Mirrors the API's content bound for one memory. */
export const MEMORY_CONTENT_MAX = 500;

// -----------------------------------------------------------------------------
// Calls
// -----------------------------------------------------------------------------

export function listMemories(category?: MemoryCategory): Promise<MemoryListView> {
  const query = category ? `?category=${encodeURIComponent(category)}` : '';
  return api.get<MemoryListView>(`/memories${query}`);
}

export function createMemory(input: MemoryCreateInput): Promise<UserMemory> {
  return api.post<UserMemory>('/memories', input);
}

export function updateMemory(id: string, input: MemoryUpdateInput): Promise<UserMemory> {
  return api.patch<UserMemory>(`/memories/${encodeURIComponent(id)}`, input);
}

export async function deleteMemory(id: string): Promise<void> {
  await api.delete<void>(`/memories/${encodeURIComponent(id)}`);
}

export function restoreMemory(id: string): Promise<UserMemory> {
  return api.post<UserMemory>(`/memories/${encodeURIComponent(id)}/restore`);
}

export async function deleteAllMemories(): Promise<void> {
  await api.delete<void>('/memories');
}

/**
 * Write the caller's memory preferences. No `If-Match`: the server merges the
 * `memory` namespace field by field, so a concurrent edit to another namespace
 * cannot be overwritten by this write.
 */
export function updateMemorySettings(patch: MemorySettingsPatch): Promise<UserSettings> {
  return api.patch<UserSettings>('/user-settings', { memory: patch });
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export const MEMORY_ERRORS = {
  LIMIT_REACHED: 'MEMORY_LIMIT_REACHED',
  DISABLED: 'MEMORY_DISABLED',
} as const;

function errorCodeOf(err: ApiError): string | undefined {
  const details = (typeof err.details === 'object' && err.details !== null ? err.details : {}) as Record<
    string,
    unknown
  >;
  for (const candidate of [details.code, details.reason, err.code]) {
    if (typeof candidate === 'string' && candidate.startsWith('MEMORY_')) return candidate;
  }
  return undefined;
}

function firstIssueMessage(err: ApiError): string | null {
  const details = err.details as { issues?: Array<{ message?: unknown }> } | undefined;
  const issue = details?.issues?.find((entry) => typeof entry?.message === 'string');
  return issue ? String(issue.message) : null;
}

/**
 * A refusal as one sentence the page can show. `limit` is the deployment's cap
 * when known, so the limit message can name it.
 */
export function memoryErrorMessage(err: unknown, limit?: number): string {
  if (!(err instanceof ApiError)) {
    return 'Could not reach the server. Check your connection and try again.';
  }
  const code = errorCodeOf(err);
  if (code === MEMORY_ERRORS.LIMIT_REACHED || (err.status === 409 && !code)) {
    return limit
      ? `You have reached the limit of ${limit} memories. Delete one you no longer need, then try again.`
      : 'You have reached the memory limit. Delete one you no longer need, then try again.';
  }
  if (code === MEMORY_ERRORS.DISABLED || err.status === 403) {
    return 'Memory is switched off, so nothing was saved. Turn memory on, or ask your administrator.';
  }
  if (err.status === 400) {
    return firstIssueMessage(err) ?? err.message ?? 'That memory could not be saved. Check it and try again.';
  }
  if (err.status === 404) {
    return 'That memory no longer exists. It may have been deleted elsewhere.';
  }
  if (err.status >= 500) {
    return 'Something went wrong on the server. Try again in a moment.';
  }
  return err.message || 'Something went wrong. Try again.';
}
