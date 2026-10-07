// =============================================================================
// The `coach` Telemetry Dashboard metric group (marinoscar/EnterpriseAppBase#719)
// =============================================================================
//
// The first app extension of the platform dashboard: the AI Coach funnel, read
// from the `app.coach.*` counters `EvoPathMetricsService` already emits
// (`app-metrics/domain-metrics.service.ts`; names in
// `app-metrics/domain-metric-names.ts`). The platform OWNS the rendering
// (`@marinoscar/platform-web/telemetry` draws any registered group from
// `/api/admin/telemetry/dashboard/metric-groups`); this app owns only what the
// numbers mean. There is no coach-specific dashboard component.
//
// PURE DATA. No Nest, no service import: `platform/telemetry/telemetry.config.ts`
// passes it to `TelemetryModule.forRoot({ metricGroups })`, which validates it
// at registration (unique keys across every group, known units and filters)
// and fails boot on a bad entry.
//
// TABLES. The collector exports OTLP to GreptimeDB, which stores a counter
// under its name with dots as underscores plus the Prometheus `_total`
// suffix (`app.jobs.settled` -> `app_jobs_settled_total`, the platform
// `queue` group's convention). A family whose table does not exist yet (a
// fresh deployment, a counter that never fired) is reported under `skipped`,
// never as an error: the group then shows "no data yet".
//
// LABELS. Every `groupBy` column is a closed set: the recorders bound each
// one with `enumLabel` before it is emitted, so no user id or free text can
// reach a series name.
//
// VERDICTS (this app's choice, documented in docs/specs/telemetry.md,
// "App extensions"): none for the nudge families, which are
// informational. Content-guard rejections and voice fallbacks carry
// `degraded` at 5 per minute and `critical` at 20 per minute, `above`. As
// for every platform family, the thresholds are metadata the dashboard
// publishes; the summary verdict's own rules are unchanged.
// =============================================================================

import type { CounterFamily, MetricFilterKey, MetricGroup, MetricGroupDef } from '@marinoscar/platform-api/telemetry';

declare module '@marinoscar/platform-api/telemetry' {
  interface MetricGroupIds {
    /** The AI Coach funnel: nudges sent, suppressed, opened and converted; guard rejections; voice fallbacks; feedback. */
    coach: true;
  }
}

/** The group id: a `/metrics?group=` value and a dashboard anchor. Permanent. */
export const COACH_METRIC_GROUP_ID: MetricGroup = 'coach';

/**
 * The request filters every coach family honours: the platform's app-metric
 * filters (`service.name`, `app.instance.id`), the same pair the platform's
 * own `app.*` families use.
 */
export const COACH_METRIC_FILTERS: readonly MetricFilterKey[] = Object.freeze(['service', 'instance']);

/** The verdict bounds of the two failure families, per minute. This app's choice. */
export const COACH_FAILURE_VERDICT = Object.freeze({ degraded: 5, critical: 20, direction: 'above' as const });

/** An informational counter: the increase over the window, split by one label. */
function countFamily(key: string, label: string, table: string, groupBy: string): CounterFamily {
  return {
    key,
    group: COACH_METRIC_GROUP_ID,
    label,
    table,
    kind: 'counter',
    unit: 'count',
    rate: 'count',
    groupBy,
    requiredColumns: [groupBy],
    filters: COACH_METRIC_FILTERS,
  };
}

/** A failure counter: a per-minute rate with the coach failure verdict. */
function failureFamily(key: string, label: string, table: string, groupBy: string): CounterFamily {
  return {
    key,
    group: COACH_METRIC_GROUP_ID,
    label,
    table,
    kind: 'counter',
    unit: 'per_min',
    rate: 'per_min',
    groupBy,
    requiredColumns: [groupBy],
    filters: COACH_METRIC_FILTERS,
    verdict: { ...COACH_FAILURE_VERDICT },
  };
}

/** The AI Coach metric group, after the six platform groups (`order` 10 to 60). */
export const COACH_METRIC_GROUP: MetricGroupDef = Object.freeze({
  id: COACH_METRIC_GROUP_ID,
  label: 'Coach',
  title: 'AI Coach',
  order: 70,
  description:
    'AI Coach nudges sent, suppressed, opened and converted, static fallbacks, content-guard rejections, voice fallbacks and feedback',
  families: Object.freeze([
    countFamily('coachNudgesSent', 'Nudges sent', 'app_coach_nudge_sent_total', 'moment'),
    countFamily('coachNudgesSuppressed', 'Nudges suppressed', 'app_coach_nudge_suppressed_total', 'reason'),
    countFamily('coachNudgesOpened', 'Nudges opened', 'app_coach_nudge_opened_total', 'moment'),
    countFamily('coachNudgesConverted', 'Nudges converted', 'app_coach_nudge_converted_total', 'target'),
    countFamily('coachNudgeFallbacks', 'Static fallbacks', 'app_coach_nudge_fallback_total', 'moment'),
    failureFamily('coachGuardRejections', 'Content-guard rejections', 'app_coach_guard_rejected_total', 'reason'),
    failureFamily('coachAudioFailures', 'Voice fallbacks to text', 'app_coach_audio_failed_total', 'reason'),
    countFamily('coachFeedback', 'Feedback', 'app_coach_feedback_total', 'value'),
  ]),
});
