import type { AppMetricAttribute, AppMetricDef } from '@marinoscar/platform-api/otel-core';

// =============================================================================
// The app's own `app.*` metrics (marinoscar/EnterpriseAppBase#718)
// =============================================================================
//
// Pure data: the 26 health and coach metrics this app exports, declared in the
// otel-core app-metric registry by `domain-metrics.module.ts` and recorded by
// the typed methods of `EvoPathMetricsService`. The platform's metrics (jobs,
// backup, auth, AI, notifications, nodes) are declared in
// `common/otel/platform-app-metrics.ts`; nothing here edits them.
//
// A NAME IS PERMANENT. Each name, with its unit, is a GreptimeDB table name
// (`app.health.export.duration` + `s` -> `app_health_export_duration_seconds`,
// docs/specs/telemetry.md §11.3) and every saved query and dashboard reads it.
// These are exactly the names, units, descriptions and bucket boundaries the
// API exported before the registry: never rename one, never change a unit.
//
// The declared `attributes` are the label keys each typed method emits, each
// a closed enum or a bounded identifier. None carries a user id, an email, a
// URL, an error message or any free text.
// =============================================================================

/** Every domain metric name of this app, by code key (the docs quote this table). */
export const EVOPATH_METRIC_NAMES = {
  healthDocumentPurges: 'app.health.documents.purges',
  // AI health summary (H8, #192): the `ai.health.summary` job.
  healthSummaryGenerations: 'app.health.summary.generations',
  healthSummaryDuration: 'app.health.summary.duration',
  healthSummaryRegenerations: 'app.health.summary.regenerations',
  healthSummaryPostCheckRejections: 'app.health.summary.post_check_rejections',
  healthSummaryTokens: 'app.health.summary.tokens',
  healthExports: 'app.health.exports',
  healthExportDuration: 'app.health.export.duration',
  healthExportSize: 'app.health.export.size',
  healthDocumentDownloads: 'app.health.documents.downloads',
  healthDocumentDeletes: 'app.health.documents.deletes',
  // AI Coach (E7.2, #242): content-guard rejections and settings writes.
  coachGuardRejected: 'app.coach.guard.rejected',
  coachSettingsUpdated: 'app.coach.settings.updated',
  // Progress photos (E7.9, #249): counts only, never a key, URL or note.
  coachPhotoAdded: 'app.coach.photo.added',
  coachPhotoDeleted: 'app.coach.photo.deleted',
  // AI Coach nudges (E7.5, #245): generation, delivery and the funnel.
  coachNudgeSent: 'app.coach.nudge.sent',
  coachNudgeSuppressed: 'app.coach.nudge.suppressed',
  coachNudgeFallback: 'app.coach.nudge.fallback',
  coachNudgeOpened: 'app.coach.nudge.opened',
  coachNudgeConverted: 'app.coach.nudge.converted',
  coachFeedback: 'app.coach.feedback',
  // AI Coach learning loop (E7.11, #251).
  coachAnglePicked: 'app.coach.angle.picked',
  // AI Coach voice (E7.6, #246): spoken nudges and the retention purge.
  coachAudioGenerated: 'app.coach.audio.generated',
  coachAudioFailed: 'app.coach.audio.failed',
  coachAudioPurged: 'app.coach.audio.purged',
  // On-demand "Listen" (#259): every POST /api/coach/messages/:id/audio, by outcome.
  coachAudioRequested: 'app.coach.audio.requested',
} as const;

/** A domain metric's code key. */
export type EvoPathMetricKey = keyof typeof EVOPATH_METRIC_NAMES;

// Type the app's keys for the host's generic `add`/`record` and `createRegisteredGauge`.
declare module '@marinoscar/platform-api/otel-core' {
  interface AppMetricKeys {
    healthDocumentPurges: true;
    healthSummaryGenerations: true;
    healthSummaryDuration: true;
    healthSummaryRegenerations: true;
    healthSummaryPostCheckRejections: true;
    healthSummaryTokens: true;
    healthExports: true;
    healthExportDuration: true;
    healthExportSize: true;
    healthDocumentDownloads: true;
    healthDocumentDeletes: true;
    coachGuardRejected: true;
    coachSettingsUpdated: true;
    coachPhotoAdded: true;
    coachPhotoDeleted: true;
    coachNudgeSent: true;
    coachNudgeSuppressed: true;
    coachNudgeFallback: true;
    coachNudgeOpened: true;
    coachNudgeConverted: true;
    coachFeedback: true;
    coachAnglePicked: true;
    coachAudioGenerated: true;
    coachAudioFailed: true;
    coachAudioPurged: true;
    coachAudioRequested: true;
  }
}

// ---- Histogram buckets, in the instrument's unit -----------------------------

export const HEALTH_SUMMARY_DURATION_BUCKETS_S = [0.05, 0.25, 1, 2.5, 5, 10, 20, 30, 60, 120, 240] as const;
export const HEALTH_EXPORT_DURATION_BUCKETS_S = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600] as const;
export const HEALTH_EXPORT_SIZE_BUCKETS_BY = [1e3, 1e4, 1e5, 5e5, 1e6, 5e6, 1e7, 5e7, 1e8] as const;

// ---- Enumerated attribute values (the typed methods check against these) ----

/** How one `health.document.purge` attempt ends (H1, #185). */
export const HEALTH_DOCUMENT_PURGE_OUTCOME_VALUES = ['purged', 'failed'] as const;
/** How one `ai.health.summary` job ends (H8, #192). */
export const HEALTH_SUMMARY_OUTCOME_VALUES = ['ready', 'rejected', 'failed', 'skipped', 'deferred'] as const;
/** How one `health.export` attempt ends, and the formats it can write (H7, #191). */
export const HEALTH_EXPORT_OUTCOME_VALUES = ['completed', 'failed'] as const;
export const HEALTH_EXPORT_FORMAT_VALUES = ['json', 'csv', 'xlsx', 'pdf'] as const;
/** How a health document download link is asked for (H6, #190). */
export const HEALTH_DOCUMENT_DOWNLOAD_DISPOSITION_VALUES = ['inline', 'attachment'] as const;
/** What one `DELETE /api/health/documents/:id` does (H6, #190). */
export const HEALTH_DOCUMENT_DELETE_SCOPE_VALUES = ['file', 'record'] as const;
/** Whether a deleted health document's values went too. */
export const HEALTH_DOCUMENT_DELETE_VALUES_VALUES = ['deleted', 'kept'] as const;

/** The coach content guard's rule names (E7.2, #242), mirrored so this file does not import the coach. */
export const COACH_GUARD_REASON_VALUES = [
  'profanity',
  'banned_term',
  'insult_target',
  'lock_screen',
  'invented_number',
  'length',
  'supportive_register',
] as const;

/** Why `ai.coach.nudge` ended without a message (E7.5, #245). Closed set. */
export const COACH_NUDGE_SUPPRESSION_REASONS = [
  'model_declined',
  'coach_off',
  'paused',
  'no_model',
  'ai_error',
  'guard_rejected',
  'already_sent',
  'deferral_limit',
  // A goal moment whose goal is no longer active, or no longer at risk, by the time the job runs (F9).
  'goal_resolved',
] as const;

/** The coach moments (E7.2 registry), mirrored as a label set so this file does not import the coach. */
export const COACH_MOMENT_VALUES = [
  'missed_twice',
  'streak_at_risk',
  'comeback',
  'pr',
  'weekly_target_hit',
  'missed_session',
  'fresh_start',
  'photo_prompt',
  'win_back',
  'back_off',
  'kickoff',
  'weekly_review',
  'goal_at_risk',
  'goal_hit',
] as const;
export const COACH_FEEDBACK_VALUES = ['up', 'down', 'cleared'] as const;
/** The learning-loop angles (E7.11, spec §2.8), mirrored as a label set so this file does not import the coach. */
export const COACH_ANGLE_VALUES = [
  'loss_aversion',
  'identity',
  'humor',
  'challenge',
  'data',
  'future_self',
  'social_proof_self',
] as const;
/** What a converted coach message was followed by. */
export const COACH_CONVERSION_TARGET_VALUES = ['workout', 'check_in', 'photo'] as const;

/** Why a coach message's audio fell back to text (E7.6, #246). Closed set. */
export const COACH_AUDIO_FAILURE_REASONS = ['provider_error', 'refusal', 'timeout', 'no_voice_model'] as const;
/** How an on-demand coach audio request ended (#259). Closed set. */
export const COACH_AUDIO_REQUEST_OUTCOMES = [
  'started',
  'ready',
  'pending',
  'failed',
  'disabled',
  'rate_limited',
  'no_voice_model',
] as const;

/** The token kinds the health summary reports. */
const TOKEN_TYPE_VALUES = ['input', 'output'] as const;

const free: AppMetricAttribute = { kind: 'free' };
const oneOf = (...values: string[]): AppMetricAttribute => ({ kind: 'enum', values });

const N = EVOPATH_METRIC_NAMES;
const HEALTH_SUMMARY_ATTRIBUTES = { outcome: oneOf(...HEALTH_SUMMARY_OUTCOME_VALUES) };
const HEALTH_EXPORT_ATTRIBUTES = {
  format: oneOf(...HEALTH_EXPORT_FORMAT_VALUES),
  outcome: oneOf(...HEALTH_EXPORT_OUTCOME_VALUES),
};
const MOMENT_ATTRIBUTES = { moment: oneOf(...COACH_MOMENT_VALUES) };

/**
 * The 26 declarations, in the order the API created them before the registry.
 * Registered once, by `domain-metrics.module.ts`.
 */
export const EVOPATH_APP_METRICS = [
  // ---- Health documents, summary and export ----
  {
    key: 'healthDocumentPurges',
    name: N.healthDocumentPurges,
    kind: 'counter',
    unit: '{document}',
    description: 'Health document file purges (delete after processing), by outcome.',
    attributes: { outcome: oneOf(...HEALTH_DOCUMENT_PURGE_OUTCOME_VALUES) },
  },
  {
    key: 'healthSummaryGenerations',
    name: N.healthSummaryGenerations,
    kind: 'counter',
    unit: '{summary}',
    description: 'AI health summary jobs, by outcome.',
    attributes: HEALTH_SUMMARY_ATTRIBUTES,
  },
  {
    key: 'healthSummaryDuration',
    name: N.healthSummaryDuration,
    kind: 'histogram',
    unit: 's',
    description: 'Wall time of one AI health summary job, by outcome.',
    buckets: HEALTH_SUMMARY_DURATION_BUCKETS_S,
    attributes: HEALTH_SUMMARY_ATTRIBUTES,
  },
  {
    key: 'healthSummaryRegenerations',
    name: N.healthSummaryRegenerations,
    kind: 'counter',
    unit: '{regeneration}',
    description: 'AI health summary answers asked for again after a post-check rejection.',
  },
  {
    key: 'healthSummaryPostCheckRejections',
    name: N.healthSummaryPostCheckRejections,
    kind: 'counter',
    unit: '{answer}',
    description: 'AI health summary answers rejected by the post-check.',
  },
  {
    key: 'healthSummaryTokens',
    name: N.healthSummaryTokens,
    kind: 'counter',
    unit: '{token}',
    description: 'Tokens the AI health summary used, by token_type (input|output).',
    attributes: { token_type: oneOf(...TOKEN_TYPE_VALUES) },
  },
  {
    key: 'healthExports',
    name: N.healthExports,
    kind: 'counter',
    unit: '{export}',
    description: 'Health data export attempts settled, by format and outcome.',
    attributes: HEALTH_EXPORT_ATTRIBUTES,
  },
  {
    key: 'healthExportDuration',
    name: N.healthExportDuration,
    kind: 'histogram',
    unit: 's',
    description: 'Wall time of one health data export attempt, by format and outcome.',
    buckets: HEALTH_EXPORT_DURATION_BUCKETS_S,
    attributes: HEALTH_EXPORT_ATTRIBUTES,
  },
  {
    key: 'healthExportSize',
    name: N.healthExportSize,
    kind: 'histogram',
    unit: 'By',
    description: 'Size of a completed health data export file, by format.',
    buckets: HEALTH_EXPORT_SIZE_BUCKETS_BY,
    attributes: { format: oneOf(...HEALTH_EXPORT_FORMAT_VALUES) },
  },
  {
    key: 'healthDocumentDownloads',
    name: N.healthDocumentDownloads,
    kind: 'counter',
    unit: '{download}',
    description: 'Signed download links issued for health documents, by disposition.',
    attributes: { disposition: oneOf(...HEALTH_DOCUMENT_DOWNLOAD_DISPOSITION_VALUES) },
  },
  {
    key: 'healthDocumentDeletes',
    name: N.healthDocumentDeletes,
    kind: 'counter',
    unit: '{document}',
    description: 'Health documents deleted by their owner, by scope and whether the values went too.',
    attributes: {
      scope: oneOf(...HEALTH_DOCUMENT_DELETE_SCOPE_VALUES),
      values: oneOf(...HEALTH_DOCUMENT_DELETE_VALUES_VALUES),
    },
  },
  // ---- AI Coach ----
  {
    key: 'coachGuardRejected',
    name: N.coachGuardRejected,
    kind: 'counter',
    unit: '{rejection}',
    description: 'Coach-written text refused by the content guard, by rule. Never the text.',
    attributes: { reason: oneOf(...COACH_GUARD_REASON_VALUES) },
  },
  {
    key: 'coachSettingsUpdated',
    name: N.coachSettingsUpdated,
    kind: 'counter',
    unit: '{update}',
    description: 'Coach settings saved through PUT /api/coach/settings, by persona.',
    attributes: { persona: free },
  },
  {
    key: 'coachPhotoAdded',
    name: N.coachPhotoAdded,
    kind: 'counter',
    unit: '{photo}',
    description: 'Progress photos added by their owner.',
  },
  {
    key: 'coachPhotoDeleted',
    name: N.coachPhotoDeleted,
    kind: 'counter',
    unit: '{photo}',
    description: 'Progress photos deleted by their owner.',
  },
  {
    key: 'coachNudgeSent',
    name: N.coachNudgeSent,
    kind: 'counter',
    unit: '{message}',
    description: 'Coach messages delivered by coach.message.deliver, by moment.',
    attributes: MOMENT_ATTRIBUTES,
  },
  {
    key: 'coachNudgeSuppressed',
    name: N.coachNudgeSuppressed,
    kind: 'counter',
    unit: '{nudge}',
    description: 'ai.coach.nudge jobs that ended without a message, by reason.',
    attributes: { reason: oneOf(...COACH_NUDGE_SUPPRESSION_REASONS), ...MOMENT_ATTRIBUTES },
  },
  {
    key: 'coachNudgeFallback',
    name: N.coachNudgeFallback,
    kind: 'counter',
    unit: '{message}',
    description: 'Coach messages that fell back to a static persona line after two guard rejections, by moment.',
    attributes: MOMENT_ATTRIBUTES,
  },
  {
    key: 'coachNudgeOpened',
    name: N.coachNudgeOpened,
    kind: 'counter',
    unit: '{message}',
    description: 'Coach messages opened for the first time, by moment.',
    attributes: MOMENT_ATTRIBUTES,
  },
  {
    key: 'coachNudgeConverted',
    name: N.coachNudgeConverted,
    kind: 'counter',
    unit: '{message}',
    description: 'Delivered coach messages followed by their target action within the window, by moment and target.',
    attributes: {
      ...MOMENT_ATTRIBUTES,
      target: oneOf(...COACH_CONVERSION_TARGET_VALUES),
      // `none` when the message carried no bandit arm.
      angle: oneOf(...COACH_ANGLE_VALUES, 'none'),
    },
  },
  {
    key: 'coachFeedback',
    name: N.coachFeedback,
    kind: 'counter',
    unit: '{feedback}',
    description: 'Thumbs feedback on coach messages, by value (`cleared` when removed).',
    attributes: { value: oneOf(...COACH_FEEDBACK_VALUES) },
  },
  {
    key: 'coachAnglePicked',
    name: N.coachAnglePicked,
    kind: 'counter',
    unit: '{angle}',
    description: 'Angles chosen by the coach learning loop for a nudge, by angle.',
    attributes: { angle: oneOf(...COACH_ANGLE_VALUES) },
  },
  {
    key: 'coachAudioGenerated',
    name: N.coachAudioGenerated,
    kind: 'counter',
    unit: '{message}',
    description: 'Coach messages whose spoken version became ready.',
  },
  {
    key: 'coachAudioFailed',
    name: N.coachAudioFailed,
    kind: 'counter',
    unit: '{message}',
    description: 'Coach messages delivered as text only after their audio failed, by reason.',
    attributes: { reason: oneOf(...COACH_AUDIO_FAILURE_REASONS) },
  },
  {
    key: 'coachAudioPurged',
    name: N.coachAudioPurged,
    kind: 'counter',
    unit: '{object}',
    description: 'Coach voice notes deleted by coach.audio.purge after the retention window.',
  },
  {
    key: 'coachAudioRequested',
    name: N.coachAudioRequested,
    kind: 'counter',
    unit: '{request}',
    description:
      'On-demand coach audio requests (Listen), by outcome: started, ready, pending, failed, disabled, rate_limited, no_voice_model.',
    attributes: { outcome: oneOf(...COACH_AUDIO_REQUEST_OUTCOMES) },
  },
] as const satisfies readonly (AppMetricDef & { key: EvoPathMetricKey })[];
