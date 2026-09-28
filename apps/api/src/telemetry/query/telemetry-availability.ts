import type { SystemTelemetryValue } from '../../common/schemas/settings.schema';
import type { GreptimeClient } from '../greptime/greptime.client';
import {
  TelemetryMultiStatementError,
  TelemetryNotConfiguredError,
  TelemetryQueryFailedError,
  TelemetryQueryTimeoutError,
} from '../greptime/greptime.errors';
import type { TelemetrySettingsService } from '../telemetry-settings.service';
import { TelemetrySqlRejectedError } from './sql-guard';
import { TELEMETRY_ERROR_REASONS, TelemetryHttpError } from './telemetry-query.errors';

// =============================================================================
// The two preconditions every explorer read shares (issue #535)
// =============================================================================
//
// Order matters: "not configured" first (no amount of settings changes will
// help), then "disabled" (an administrator can switch it on).
// =============================================================================

/** The current policy, or a `TelemetryHttpError` saying why nothing may be queried. */
export async function requireQueryablePolicy(
  greptime: GreptimeClient,
  settings: TelemetrySettingsService,
): Promise<SystemTelemetryValue> {
  if (!greptime.isConfigured()) {
    throw new TelemetryHttpError(
      TELEMETRY_ERROR_REASONS.NOT_CONFIGURED,
      'No telemetry store is configured for this deployment.',
    );
  }

  const policy = await settings.getPolicy();

  if (!policy.enabled) {
    throw new TelemetryHttpError(
      TELEMETRY_ERROR_REASONS.DISABLED,
      'Telemetry is disabled. An administrator can enable it in the telemetry settings.',
    );
  }

  return policy;
}

/**
 * Maps anything the guard or `GreptimeClient` threw to its HTTP failure.
 * Anything unrecognised is returned unchanged (and becomes a 500).
 */
export function toTelemetryHttpError(error: unknown): unknown {
  if (error instanceof TelemetryHttpError) return error;

  if (error instanceof TelemetrySqlRejectedError || error instanceof TelemetryMultiStatementError) {
    return new TelemetryHttpError(TELEMETRY_ERROR_REASONS.QUERY_REJECTED, error.message);
  }

  if (error instanceof TelemetryQueryTimeoutError) {
    return new TelemetryHttpError(TELEMETRY_ERROR_REASONS.QUERY_TIMEOUT, error.message, {
      timeoutMs: error.timeoutMs,
    });
  }

  if (error instanceof TelemetryNotConfiguredError) {
    return new TelemetryHttpError(TELEMETRY_ERROR_REASONS.NOT_CONFIGURED, error.message);
  }

  if (error instanceof TelemetryQueryFailedError) {
    return error.origin === 'server'
      ? new TelemetryHttpError(TELEMETRY_ERROR_REASONS.QUERY_FAILED, error.message, {
          ...(error.code ? { sqlState: error.code } : {}),
        })
      : new TelemetryHttpError(TELEMETRY_ERROR_REASONS.UNREACHABLE, 'The telemetry store did not answer.', {
          cause: error.message,
        });
  }

  return error;
}
