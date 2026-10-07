// =============================================================================
// EvoPath's domain metrics (marinoscar/EnterpriseAppBase#718)
// =============================================================================
//
// THE TYPED RECORDERS FOR EVOPATH'S OWN METRICS: health documents, the AI
// health summary, health exports, progress photos and the AI Coach. Moved out
// of the platform's `common/otel/app-metrics.service.ts` unchanged: the same
// method names and signatures, the same units, attribute keys and closed label
// sets, so every call site records exactly what it did before.
//
// THE INSTRUMENTS ARE THE PLATFORM'S. The names, units, descriptions and
// buckets are declared in the otel-core app-metric registry
// (`evopath-metric-names.ts`, registered by `evopath-metrics.module.ts`), and
// the instruments are created by the platform's metrics host
// (`MetricsHostService`, `@marinoscar/platform-api/otel-core`) from those
// declarations: this file never creates an instrument.
//
// OFF MEANS NO-OP. With `OTEL_ENABLED` unset no SDK is installed, the host's
// meter is the API's no-op meter and every recorder below costs a function
// call. With the SDK installed but the `telemetry.enabled` setting off, the
// gated exporter drops each batch.
//
// LOW CARDINALITY. Every label is a closed enum (`enumLabel`, else `other`) or
// a bounded identifier (`boundLabel`, the host's per-key budget). Never a user
// id, an email, a URL, an error message or any text.
//
// NEVER THROWS. Every recorder is wrapped: a metrics fault must never reach a
// job handler, a request or a delivery.
// =============================================================================

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Attributes, Counter, Histogram } from '@opentelemetry/api';
import {
  enumLabel,
  METRICS_HOST_OPTIONS,
  MetricsHostService,
  nonNegative,
  type MetricsHostOptions,
} from '@marinoscar/platform-api/otel-core';

import {
  COACH_ANGLE_VALUES,
  COACH_AUDIO_FAILURE_REASONS,
  COACH_AUDIO_REQUEST_OUTCOMES,
  COACH_CONVERSION_TARGET_VALUES,
  COACH_FEEDBACK_VALUES,
  COACH_GUARD_REASON_VALUES,
  COACH_MOMENT_VALUES,
  COACH_NUDGE_SUPPRESSION_REASONS,
  HEALTH_DOCUMENT_DELETE_SCOPE_VALUES,
  HEALTH_DOCUMENT_DOWNLOAD_DISPOSITION_VALUES,
  HEALTH_DOCUMENT_PURGE_OUTCOME_VALUES,
  HEALTH_EXPORT_FORMAT_VALUES,
  HEALTH_EXPORT_OUTCOME_VALUES,
  HEALTH_SUMMARY_OUTCOME_VALUES,
  type EvoPathMetricKey,
} from './evopath-metric-names';

export { COACH_AUDIO_FAILURE_REASONS, COACH_AUDIO_REQUEST_OUTCOMES, COACH_NUDGE_SUPPRESSION_REASONS };

/** How one `health.document.purge` attempt ended (H1, #185). */
export type HealthDocumentPurgeOutcome = (typeof HEALTH_DOCUMENT_PURGE_OUTCOME_VALUES)[number];

/**
 * How one `ai.health.summary` job ended (H8, #192): a summary stored
 * (`ready`), rejected twice by the post-check (`rejected`), failed
 * (`failed`), nothing to do (`skipped`: consent off, no data, unchanged) or
 * deferred by a provider throttle (`deferred`).
 */
export type HealthSummaryOutcome = (typeof HEALTH_SUMMARY_OUTCOME_VALUES)[number];

/** The counts one summary job reports besides its outcome. */
export interface HealthSummaryCounts {
  regenerations: number;
  rejections: number;
  inputTokens: number;
  outputTokens: number;
}

/** How one `health.export` attempt ended (H7, #191). */
export type HealthExportOutcome = (typeof HEALTH_EXPORT_OUTCOME_VALUES)[number];

/** How a health document download link was asked for (H6, #190). */
export type HealthDocumentDownloadDisposition = (typeof HEALTH_DOCUMENT_DOWNLOAD_DISPOSITION_VALUES)[number];

/**
 * What one `DELETE /api/health/documents/:id` did (H6, #190): `file` queued
 * the file's purge, `record` removed the metadata of a file already gone.
 */
export type HealthDocumentDeleteScope = (typeof HEALTH_DOCUMENT_DELETE_SCOPE_VALUES)[number];

/** What happened to a progress photo (E7.9, #249). */
export type ProgressPhotoChange = 'added' | 'deleted';

/** Why `ai.coach.nudge` ended without a message (E7.5, #245). Closed set. */
export type CoachNudgeSuppressionReason = (typeof COACH_NUDGE_SUPPRESSION_REASONS)[number];

/** Why a coach message's audio fell back to text (E7.6, #246). Closed set. */
export type CoachAudioFailureReason = (typeof COACH_AUDIO_FAILURE_REASONS)[number];

/** How an on-demand coach audio request ended (#259). Closed set. */
export type CoachAudioRequestOutcome = (typeof COACH_AUDIO_REQUEST_OUTCOMES)[number];

const HEALTH_DOCUMENT_PURGE_OUTCOMES = new Set<string>(HEALTH_DOCUMENT_PURGE_OUTCOME_VALUES);
const HEALTH_SUMMARY_OUTCOMES = new Set<string>(HEALTH_SUMMARY_OUTCOME_VALUES);
const HEALTH_EXPORT_OUTCOMES = new Set<string>(HEALTH_EXPORT_OUTCOME_VALUES);
const HEALTH_EXPORT_FORMATS = new Set<string>(HEALTH_EXPORT_FORMAT_VALUES);
const HEALTH_DOCUMENT_DOWNLOAD_DISPOSITIONS = new Set<string>(HEALTH_DOCUMENT_DOWNLOAD_DISPOSITION_VALUES);
const HEALTH_DOCUMENT_DELETE_SCOPES = new Set<string>(HEALTH_DOCUMENT_DELETE_SCOPE_VALUES);
const COACH_GUARD_REASONS = new Set<string>(COACH_GUARD_REASON_VALUES);
const COACH_NUDGE_SUPPRESSION_SET = new Set<string>(COACH_NUDGE_SUPPRESSION_REASONS);
const COACH_MOMENT_LABELS = new Set<string>(COACH_MOMENT_VALUES);
const COACH_FEEDBACK_SET = new Set<string>(COACH_FEEDBACK_VALUES);
const COACH_ANGLE_LABELS = new Set<string>(COACH_ANGLE_VALUES);
const COACH_AUDIO_FAILURE_SET = new Set<string>(COACH_AUDIO_FAILURE_REASONS);
const COACH_AUDIO_REQUEST_SET = new Set<string>(COACH_AUDIO_REQUEST_OUTCOMES);
const COACH_CONVERSION_TARGETS = new Set<string>(COACH_CONVERSION_TARGET_VALUES);

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@Injectable()
export class EvoPathMetricsService {
  private readonly logger = new Logger(EvoPathMetricsService.name);

  /** The platform's metrics host: the meter, the instruments and label bounding. */
  private readonly host: MetricsHostService;

  /**
   * @param host - The global host (`OtelMetricsModule`, imported by `AppMetricsModule`).
   * @param options - Only used without a host (a hand-built instance, the specs): an explicit meter, clock or gate.
   */
  constructor(
    @Optional() host?: MetricsHostService,
    @Optional() @Inject(METRICS_HOST_OPTIONS) options?: MetricsHostOptions,
  ) {
    this.host = host ?? new MetricsHostService(options);
  }

  // ===========================================================================
  // Health documents
  // ===========================================================================

  /** One `health.document.purge` attempt ended: the file was erased, or the attempt failed (and is retried). */
  healthDocumentPurge(outcome: HealthDocumentPurgeOutcome): void {
    this.safely(() =>
      this.counter('healthDocumentPurges').add(1, { outcome: enumLabel(outcome, HEALTH_DOCUMENT_PURGE_OUTCOMES) }),
    );
  }

  /** One `health.export` attempt settled. Size only for a completed file. */
  healthExportSettled(format: string, outcome: HealthExportOutcome, durationMs: number | null, sizeBytes?: number | null): void {
    this.safely(() => {
      const attrs: Attributes = {
        format: enumLabel(format, HEALTH_EXPORT_FORMATS),
        outcome: enumLabel(outcome, HEALTH_EXPORT_OUTCOMES),
      };
      this.counter('healthExports').add(1, attrs);
      const ms = nonNegative(durationMs);
      if (ms !== null) this.histogram('healthExportDuration').record(ms / 1000, attrs);
      if (outcome === 'completed') {
        const size = nonNegative(sizeBytes);
        if (size !== null) this.histogram('healthExportSize').record(size, { format: attrs.format });
      }
    });
  }

  /** A signed download link for a health document was issued (H6, #190). */
  healthDocumentDownload(disposition: HealthDocumentDownloadDisposition): void {
    this.safely(() =>
      this.counter('healthDocumentDownloads').add(1, {
        disposition: enumLabel(disposition, HEALTH_DOCUMENT_DOWNLOAD_DISPOSITIONS),
      }),
    );
  }

  /** The owner deleted a health document (H6, #190); `withValues` when its values were soft-deleted too. */
  healthDocumentDelete(scope: HealthDocumentDeleteScope, withValues: boolean): void {
    this.safely(() =>
      this.counter('healthDocumentDeletes').add(1, {
        scope: enumLabel(scope, HEALTH_DOCUMENT_DELETE_SCOPES),
        values: withValues ? 'deleted' : 'kept',
      }),
    );
  }

  /** A progress photo was added or deleted by its owner (E7.9, #249). No attributes: nothing about the photo. */
  progressPhotoChanged(change: ProgressPhotoChange): void {
    this.safely(() => this.counter(change === 'added' ? 'coachPhotoAdded' : 'coachPhotoDeleted').add(1));
  }

  // ===========================================================================
  // AI Coach (E7.2, #242)
  // ===========================================================================

  /** The content guard refused a coach-written message for `reason` (one count per distinct rule). */
  coachGuardRejection(reason: string): void {
    this.safely(() => this.counter('coachGuardRejected').add(1, { reason: enumLabel(reason, COACH_GUARD_REASONS) }));
  }

  /** A user saved their coach settings; `persona` is the registry id now selected. */
  coachSettingsUpdate(persona: string): void {
    this.safely(() => this.counter('coachSettingsUpdated').add(1, { persona: this.host.boundLabel('persona', persona) }));
  }

  /** `coach.message.deliver` delivered a coach message for `moment`. */
  coachNudgeDelivered(moment: string | null): void {
    this.safely(() => this.counter('coachNudgeSent').add(1, { moment: enumLabel(moment, COACH_MOMENT_LABELS) }));
  }

  /** `ai.coach.nudge` ended without a message for `reason`. */
  coachNudgeSuppression(reason: CoachNudgeSuppressionReason, moment: string | null): void {
    this.safely(() =>
      this.counter('coachNudgeSuppressed').add(1, {
        reason: enumLabel(reason, COACH_NUDGE_SUPPRESSION_SET),
        moment: enumLabel(moment, COACH_MOMENT_LABELS),
      }),
    );
  }

  /** A static persona line was persisted after two guard rejections. */
  coachNudgeFallbackUsed(moment: string | null): void {
    this.safely(() => this.counter('coachNudgeFallback').add(1, { moment: enumLabel(moment, COACH_MOMENT_LABELS) }));
  }

  /** A coach message was opened for the first time. */
  coachNudgeOpen(moment: string | null): void {
    this.safely(() => this.counter('coachNudgeOpened').add(1, { moment: enumLabel(moment, COACH_MOMENT_LABELS) }));
  }

  /** A delivered coach message was converted by `target` within its window; `angle` is its bandit arm (E7.11). */
  coachNudgeConversion(moment: string | null, target: string, angle: string | null = null): void {
    this.safely(() =>
      this.counter('coachNudgeConverted').add(1, {
        moment: enumLabel(moment, COACH_MOMENT_LABELS),
        target: enumLabel(target, COACH_CONVERSION_TARGETS),
        angle: angle === null ? 'none' : enumLabel(angle, COACH_ANGLE_LABELS),
      }),
    );
  }

  /** The learning loop picked `angle` for a nudge (E7.11). */
  coachAnglePicked(angle: string): void {
    this.safely(() => this.counter('coachAnglePicked').add(1, { angle: enumLabel(angle, COACH_ANGLE_LABELS) }));
  }

  /** Feedback on a coach message: `up`, `down`, or `cleared` (null). */
  coachFeedbackGiven(value: 'up' | 'down' | null): void {
    this.safely(() => this.counter('coachFeedback').add(1, { value: enumLabel(value ?? 'cleared', COACH_FEEDBACK_SET) }));
  }

  /** A coach message's spoken version is ready (E7.6). */
  coachAudioReady(): void {
    this.safely(() => this.counter('coachAudioGenerated').add(1));
  }

  /** A coach message's audio fell back to text for `reason` (E7.6). */
  coachAudioFailure(reason: CoachAudioFailureReason): void {
    this.safely(() => this.counter('coachAudioFailed').add(1, { reason: enumLabel(reason, COACH_AUDIO_FAILURE_SET) }));
  }

  /** One on-demand coach audio request ended with `outcome` (#259). */
  coachAudioRequest(outcome: CoachAudioRequestOutcome): void {
    this.safely(() => this.counter('coachAudioRequested').add(1, { outcome: enumLabel(outcome, COACH_AUDIO_REQUEST_SET) }));
  }

  /** `coach.audio.purge` deleted `count` voice notes (E7.6). */
  coachAudioPurge(count: number): void {
    if (count <= 0) return;
    this.safely(() => this.counter('coachAudioPurged').add(count));
  }

  // ===========================================================================
  // AI health summary
  // ===========================================================================

  /** One `ai.health.summary` job ended; `counts` when a model was called. */
  healthSummaryGenerated(outcome: HealthSummaryOutcome, durationMs: number | null, counts?: HealthSummaryCounts): void {
    this.safely(() => {
      const attrs: Attributes = { outcome: enumLabel(outcome, HEALTH_SUMMARY_OUTCOMES) };
      this.counter('healthSummaryGenerations').add(1, attrs);
      const ms = nonNegative(durationMs);
      if (ms !== null) this.histogram('healthSummaryDuration').record(ms / 1000, attrs);
      if (!counts) return;
      const regenerations = nonNegative(counts.regenerations);
      if (regenerations) this.counter('healthSummaryRegenerations').add(Math.round(regenerations));
      const rejections = nonNegative(counts.rejections);
      if (rejections) this.counter('healthSummaryPostCheckRejections').add(Math.round(rejections));
      const input = nonNegative(counts.inputTokens);
      if (input) this.counter('healthSummaryTokens').add(Math.round(input), { token_type: 'input' });
      const output = nonNegative(counts.outputTokens);
      if (output) this.counter('healthSummaryTokens').add(Math.round(output), { token_type: 'output' });
    });
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  /** An EvoPath counter, created by the host from its registry declaration. */
  private counter(key: EvoPathMetricKey): Counter {
    return this.host.counter(key);
  }

  /** An EvoPath histogram, created by the host from its registry declaration. */
  private histogram(key: EvoPathMetricKey): Histogram {
    return this.host.histogram(key);
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.logger.debug(`Metric recording skipped: ${describe(error)}`);
    }
  }
}

// -----------------------------------------------------------------------------
// The fallback instance
// -----------------------------------------------------------------------------
//
// Services that record EvoPath metrics inject `EvoPathMetricsService` as
// `@Optional()` and fall back to this shared instance: a host of its own on the
// global meter (the API's no-op meter unless an SDK is installed). That keeps
// the hand-built service instances in the test suites valid without a stub
// each, while production, where `EvoPathMetricsModule` is global, always
// injects the real one.
let fallback: EvoPathMetricsService | null = null;

export function fallbackEvoPathMetrics(): EvoPathMetricsService {
  if (!fallback) fallback = new EvoPathMetricsService();
  return fallback;
}
