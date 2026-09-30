// =============================================================================
// The admin doctor check contract (issue #634)
// =============================================================================
//
// `GET /api/admin/doctor` answers one question for an administrator: "is every
// capability of this deployment configured, reachable and healthy?" It does so
// by running a set of small, independent checks — one per fact worth knowing —
// that each capability's own module contributes.
//
// The contract deliberately mirrors the CLI's pre-install doctor
// (`apps/cli/src/deploy/checks/types.ts`): the same four statuses, the same
// one-line `detail`, the same `remedy`. An operator who has read one report
// can read the other. The API doctor answers "is the RUNNING deployment
// healthy?", where the CLI doctor answers "is this SERVER ready to install?".
//
// FIVE RULES THAT MAKE THIS WORTH HAVING:
//
//   1. A CHECK NEVER THROWS. A crashed probe is a `fail` carrying the error's
//      message. `DoctorService` guards every call as well (a throw becomes a
//      `fail`, a hang becomes a `fail` after `timeoutMs`), but a check that
//      relies on that guard reports a worse `detail` than one that catches
//      its own failure and says what it was doing.
//
//   2. `remedy` IS EXPECTED ON `warn` AND `fail`, and should name a settings
//      page, a command or an environment variable — "fix storage" is not a
//      remedy. The service fills a generic one ("Open <settingsPath> to
//      review.") when a check omits it, so the report never shows a problem
//      with no next step; each check's own spec asserts it supplies a real one.
//
//   3. ⚠ CHECKS ARE READ-ONLY. A doctor run must be safe against a production
//      deployment at any time, by anyone holding `system_settings:read`, as
//      often as they like. Concretely, a check:
//        - NEVER calls the side-effecting "test" services:
//          `StorageConnectionTestService`, `AiProviderTestService`,
//          `EmailTestSendService`, `PushTestService`,
//          `TelemetryConnectionTestService`. Those write probe objects, spend
//          model tokens, send mail and pushes, or audit the attempt;
//        - never writes an object, a row or an audit event;
//        - never enqueues a job or calls a model.
//      Reading (a `SELECT`, a `HEAD`, a settings read) is the whole budget.
//
//   4. RESULTS NEVER CONTAIN SECRET MATERIAL. Not in `detail`, not in
//      `error`, not in `data`. A check that reads a secret to validate it
//      (the VAPID private key, say) reports only the verdict. Lengths and
//      counts are fine; values, hints and fingerprints are not.
//
//   5. `skip` MEANS "NOT EVALUATED", for one of two reasons:
//        - a check it `dependsOn` did not pass (the service decides this; the
//          check does not run at all), or
//        - the capability is INTENTIONALLY OFF — AI switched off, telemetry
//          collection off. That is an operator's choice, not a problem, so it
//          is neither `warn` (nothing to fix) nor `pass` (nothing was proven).
//          A `skip` needs no remedy.
//
// Registration: see `doctor-check.registry.ts`. Each check is an
// `@Injectable()` in its OWNING feature module, under `<module>/doctor/`, that
// calls `registry.register(this)` from its own `onModuleInit`.
// =============================================================================

/** The four outcomes, identical to the CLI doctor's `CheckStatus`. */
export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';

export const DOCTOR_STATUSES: readonly DoctorStatus[] = ['pass', 'skip', 'warn', 'fail'];

/**
 * How bad a status is, for the report's overall verdict: the worst wins.
 *
 * `skip` ranks just above `pass` — a report whose only non-pass entries are
 * intentional skips (AI off, telemetry off) is healthy, but it proved less than
 * an all-pass one, and a report where NOTHING ran must not read as "pass".
 */
export const DOCTOR_STATUS_RANK: Readonly<Record<DoctorStatus, number>> = {
  pass: 0,
  skip: 1,
  warn: 2,
  fail: 3,
};

/** The categories this template ships, in display order. */
export const DOCTOR_CATEGORIES = [
  'core',
  'auth',
  'maintenance',
  'storage',
  'email',
  'push',
  'ai',
  'jobs',
  'nodes',
  'backup',
  'telemetry',
] as const;

export type CoreDoctorCategory = (typeof DOCTOR_CATEGORIES)[number];

/**
 * A check's category. The shipped ones autocomplete; a fork adds its own simply
 * by using a new string (it sorts after the shipped ones, in registration
 * order) — no edit to this file needed.
 */
export type DoctorCategory = CoreDoctorCategory | (string & {});

/** A scalar fact a check wants to show beside its detail. Never secret material. */
export type DoctorDataValue = string | number | boolean | null;

export interface DoctorCheckOutcome {
  status: DoctorStatus;
  /** One line: what was found. "Connected in 12 ms", "No provider is enabled". */
  detail: string;
  /** Expected on warn/fail: a settings page, a command or a variable to set. */
  remedy?: string;
  /** The underlying error message, when a probe failed. Never secret material. */
  error?: string;
  /** Small scalar facts (counts, versions, latencies). Never secret material. */
  data?: Record<string, DoctorDataValue>;
}

export interface DoctorCheck {
  /** Stable, dotted, unique across the application: `storage.bucket`. */
  readonly id: string;
  readonly category: DoctorCategory;
  /** Short human label: "Object storage bucket". */
  readonly label: string;
  /** The web route that fixes this, e.g. `/admin/settings/storage`. */
  readonly settingsPath?: string;
  /** Per-check ceiling; the service's default is 5000 ms. */
  readonly timeoutMs?: number;
  /**
   * Ids of checks that must not `fail` or `skip` for this one to run. When one
   * does, this check is reported as `skip` and `run()` is never called.
   */
  readonly dependsOn?: readonly string[];
  /** Read-only. See rules 1, 3 and 4 in this file's header. */
  run(): Promise<DoctorCheckOutcome>;
}
