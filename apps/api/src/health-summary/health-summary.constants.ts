// =============================================================================
// AI health summary (H8, #192): the constants every part shares
// =============================================================================

/** The job type. PERMANENT once jobs of it exist. Server-only (`ai.*`). */
export const HEALTH_SUMMARY_JOB_TYPE = 'ai.health.summary';

/**
 * The job's subject: the USER the summary is for (`subjectId` = user id), so
 * the queue's active dedup key (`jobs_active_dedup_uniq_idx`) allows at most
 * one pending or running summary job per user.
 */
export const HEALTH_SUMMARY_SUBJECT_TYPE = 'health_summary';

/** The AI feature an administrator assigns a model to. */
export const HEALTH_SUMMARY_FEATURE_ID = 'health_summary';

/**
 * How long an automatic regeneration waits after a health write. Every
 * further write while it waits collapses onto the same pending job (the
 * dedup key), so a burst of writes (a lab report of 30 results, a week of
 * check-ins) costs one summary.
 */
export const HEALTH_SUMMARY_DEBOUNCE_MS = 2 * 60_000;

export const HEALTH_SUMMARY_STATUSES = ['ready', 'failed'] as const;
export type HealthSummaryStatus = (typeof HEALTH_SUMMARY_STATUSES)[number];

/** Audit action of a consent change (`meta: { enabled }`, never health data). */
export const HEALTH_SUMMARY_CONSENT_AUDIT_ACTION = 'health_summary:consent';
export const HEALTH_SUMMARY_CONSENT_AUDIT_TARGET = 'health_summary_setting';

/** Refusal codes (`details.reason`). */
export const HEALTH_SUMMARY_REASONS = {
  CONSENT_OFF: 'HEALTH_SUMMARY_CONSENT_OFF',
  NO_DATA: 'HEALTH_SUMMARY_NO_DATA',
} as const;

/** Failure codes a `failed` summary row records besides an `AiError` code. */
export const HEALTH_SUMMARY_FAILURES = {
  POST_CHECK_REJECTED: 'HEALTH_SUMMARY_POST_CHECK_REJECTED',
  GENERATION_FAILED: 'HEALTH_SUMMARY_GENERATION_FAILED',
} as const;

/** Span attributes of the job (counts and codes only, never text). */
export const HEALTH_SUMMARY_SPAN_ATTRIBUTES = {
  outcome: 'health_summary.outcome',
  regenerations: 'health_summary.regenerations',
  postCheckRejections: 'health_summary.post_check_rejections',
  inputTokens: 'health_summary.input_tokens',
  outputTokens: 'health_summary.output_tokens',
} as const;

/**
 * What the opt-in shares, for the consent panel ("what will be shared").
 * Scope (#327): the summary goes to the training agents and the coach chat;
 * individual biomarker values go to the coach chat only, when it looks them
 * up (`list_biomarkers`, `get_biomarker_values`). The last item lists what
 * the summary-writing model reads.
 */
export const HEALTH_SUMMARY_SHARED = [
  'Your AI health summary (a short narrative and training considerations), with training plans and the coach chat',
  'Biomarker values (your individual lab results, with dates, units, flags and reference ranges), with the coach chat only, when it looks them up for you',
  'To write the summary, the AI model reads: lab results (the latest and previous value of each analyte, with its flag and reference range), blood pressure and resting heart rate (latest readings and 30- and 90-day averages), body measurements (weight trend, body fat and waist), check-in scores (28-day averages and runs of low days), and your age in whole years and sex at birth',
] as const;

/** What it never shares. */
export const HEALTH_SUMMARY_NEVER_SHARED = [
  'Raw lab values and readings with the training agents (they receive only the summary text)',
  'Documents, photos and file names',
  'Medications',
  'Notes and any other free text',
  'Lab and test names as printed, and the lab that issued them',
  'Your e-mail and date of birth',
] as const;
