/**
 * Labels and colours for the Connected devices page (#283). Display only:
 * every status is the API's.
 */
import type {
  DiagnosticCheckStatus,
  HealthSyncRunStatus,
  HealthSyncTrigger,
} from '../../../services/healthSync';

export type ChipColor = 'success' | 'warning' | 'error' | 'default' | 'info';

export const RUN_STATUS_LABELS: Record<HealthSyncRunStatus, string> = {
  ok: 'OK',
  partial: 'Partial',
  failed: 'Failed',
  skipped: 'Skipped',
};

export const RUN_STATUS_COLORS: Record<HealthSyncRunStatus, ChipColor> = {
  ok: 'success',
  partial: 'warning',
  failed: 'error',
  skipped: 'default',
};

export const TRIGGER_LABELS: Record<HealthSyncTrigger, string> = {
  periodic: 'Scheduled',
  manual: 'Manual',
  initial: 'First sync',
  app_open: 'App opened',
};

export const CHECK_STATUS_LABELS: Record<DiagnosticCheckStatus, string> = {
  pass: 'Pass',
  warn: 'Warning',
  fail: 'Fail',
  skip: 'Skipped',
};

/** Local date and time, or an em dash without one. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
