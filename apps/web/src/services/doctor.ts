/**
 * The admin Doctor API (`GET /api/admin/doctor`), as the web app sees it.
 *
 * Issue #634. `services/api.ts` stays the transport (the `ApiService`
 * instance, the refresh dance, the maintenance recogniser); this module holds
 * the one call and the types it produces, mirroring the API's DTOs. New code
 * does not go in the legacy tail of `services/api.ts`.
 *
 * ⚠ A FAILING CHECK IS A SUCCESSFUL RESPONSE. The endpoint answers 200 with a
 * `fail` verdict when storage is unreachable or SMTP refuses a login — those
 * are the results the page exists to show. `getDoctorReport` rejects only when
 * the CALL fails (403, 500, the connection dropped).
 */

import { api } from './api';

/** Severity order, lowest first: pass < skip < warn < fail. */
export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';

export const DOCTOR_STATUS_ORDER: readonly DoctorStatus[] = ['pass', 'skip', 'warn', 'fail'];

export interface DoctorCheckReport {
  id: string;
  category: string;
  label: string;
  /** Where the admin fixes this check, or `null` when no settings page owns it. */
  settingsPath: string | null;
  status: DoctorStatus;
  detail: string;
  remedy: string | null;
  /** Verbatim underlying error (provider message, errno), or `null`. */
  error: string | null;
  data: Record<string, string | number | boolean | null> | null;
  durationMs: number;
}

export interface DoctorReport {
  /** The worst status across `checks`. */
  verdict: DoctorStatus;
  generatedAt: string;
  durationMs: number;
  checks: DoctorCheckReport[];
}

export interface DoctorReportQuery {
  /** Restrict the run to one category. */
  category?: string;
  /** Bypass any server-side cache and run every probe again. */
  refresh?: boolean;
}

/** `GET /admin/doctor` — `system_settings:read`. */
export async function getDoctorReport(query: DoctorReportQuery = {}): Promise<DoctorReport> {
  const params = new URLSearchParams();
  if (query.category) params.set('category', query.category);
  if (query.refresh) params.set('refresh', 'true');
  const qs = params.toString();
  return api.get<DoctorReport>(qs ? `/admin/doctor?${qs}` : '/admin/doctor');
}
