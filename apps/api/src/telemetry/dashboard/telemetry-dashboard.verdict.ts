// =============================================================================
// The dashboard's health verdict (issue #577, epic #576)
// =============================================================================
//
// One pure function over numbers the summary already computed. Four rules,
// each with a VOLUME GUARD so a quiet deployment does not flap red on one
// failed request:
//
//   5xx rate      > 2 % degraded, > 5 % critical        (>= 20 requests)
//   p95 latency   > 1000 ms degraded, > 3000 ms critical (>= 20 requests)
//   error logs    >= 3x the previous window degraded,
//                 >= 10x critical                       (>= 10 errors now;
//                                                        previous 0 counts as 1)
//   no data       now - latest trace/log > 5 min        → no_data, overriding
//                                                        every other rule
//   unknown API   any request WITH a bearer to an unknown route (#258)
//   routes        degraded; >= 20 such requests or >= 3 distinct
//                 METHOD /path critical. No volume guard: one request from
//                 our own client to a route this build lacks is already a
//                 defect (a deploy skew). Anonymous unknown-route requests
//                 (scanners) never fire; the summary tile still counts them.
//                 A 404 from a MATCHED route never counts here.
//
// The level is the worst rule that fired; `reasons` has one line per fired
// rule with its value, the threshold it crossed and the worst offender.
//
// INFRASTRUCTURE RULES (#126), each evaluated only when its input is present
// (the summary leaves an input undefined when the metric tables behind it do
// not exist, or hold no fresh rows). No volume guard: each input is already a
// level, not a rate over a sample.
//
//   disk utilization   >= 85 % degraded, >= 95 % critical  (worst mountpoint)
//   memory utilization >= 90 % degraded, >= 97 % critical  (worst host)
//   DB connections     >= 80 % degraded, >= 95 % critical  of max_connections
//   oldest pending job >= 10 min degraded, >= 30 min critical (worst job type)
//   worker nodes       any stale node degraded; a node-offered job type with
//                      pending work and no eligible node critical
//   TLS certificate    < 14 days degraded, < 7 days critical (soonest URL)
//   uptime check       latest check failed degraded; every check in the
//                      lookback failed (>= 2 checks) critical
//   collector exports  any failed point degraded; >= 10 % of attempted
//                      points failed critical
//   last backup        > 26 h degraded, > 50 h critical
// =============================================================================

export const DASHBOARD_VERDICT_THRESHOLDS = {
  /** Requests needed before the 5xx and p95 rules may fire. */
  minRequests: 20,
  errorRatePct: { degraded: 2, critical: 5 },
  p95Ms: { degraded: 1000, critical: 3000 },
  errorLogs: {
    /** Error logs needed in the current window before the ratio rule may fire. */
    minCurrent: 10,
    degradedRatio: 3,
    criticalRatio: 10,
  },
  /** Minutes without any trace or log after which the verdict is `no_data`. */
  noDataMinutes: 5,
  /**
   * Unknown API routes (#258), bearer requests only. Any is degraded; either
   * bound below (`>=`) is critical.
   */
  unknownRoutes: { criticalBearerRequests: 20, criticalDistinctRoutes: 3 },
  // ---- infrastructure rules (#126) ----
  /** Worst mountpoint, `>=`. */
  diskUtilizationPct: { degraded: 85, critical: 95 },
  /** Worst host, `>=`. */
  memoryUtilizationPct: { degraded: 90, critical: 97 },
  /** Backends against `max_connections`, worst server, `>=`. */
  dbConnectionsPct: { degraded: 80, critical: 95 },
  /** Oldest due pending job, worst job type, `>=`. */
  oldestPendingJobMinutes: { degraded: 10, critical: 30 },
  /** Certificate lifetime left, soonest URL, `<`. */
  tlsDaysLeft: { degraded: 14, critical: 7 },
  /** Checks an uptime target must have in the lookback before "every check failed" may be critical. */
  uptimeMinChecksForCritical: 2,
  /** Share of attempted exporter points that failed, `>=`, for critical (any failure is degraded). */
  collectorFailedPct: { critical: 10 },
  /** Age of the last successful backup, `>`. */
  backupAgeHours: { degraded: 26, critical: 50 },
} as const;

export const VERDICT_LEVELS = ['healthy', 'degraded', 'critical', 'no_data'] as const;
export type VerdictLevel = (typeof VERDICT_LEVELS)[number];

export interface DashboardVerdict {
  level: VerdictLevel;
  reasons: string[];
}

export interface VerdictInput {
  now: Date;
  /** Latest trace or log timestamp seen (null when none in the lookback). */
  lastDataAt: Date | null;
  requests: number;
  errors5xx: number;
  /** Window p95, null without requests. */
  p95Ms: number | null;
  errorLogs: number;
  previousErrorLogs: number;
  /** `METHOD /path` with the most 5xx, if any. */
  topErrorRoute?: string | null;
  /** `METHOD /path` with the highest p95, if any. */
  slowestRoute?: string | null;
  /** The most frequent error message, if any. */
  topErrorMessage?: string | null;
  /**
   * Requests WITH a bearer to an unknown route (#258): how many, over how
   * many distinct `METHOD /path` (counted from the bounded top list, which is
   * enough for the threshold), and the top one. Undefined/null when the store
   * cannot tell (no `app.route.matched` column yet): the rule is skipped.
   */
  unknownRoutes?: { bearerRequests: number; bearerRoutes: number; topRoute: string | null } | null;

  // ---- infrastructure inputs (#126): undefined/null = the rule is skipped ----

  /** Highest filesystem utilization (%) and its mountpoint. */
  disk?: { utilizationPct: number; mountpoint: string | null } | null;
  /** Highest memory utilization (%) and its host. */
  memory?: { utilizationPct: number; host: string | null } | null;
  /** Highest backends / max_connections (%) and its server (`instance`). */
  dbConnections?: { utilizationPct: number; instance: string | null } | null;
  /** Oldest due pending job age (seconds) and its job type. */
  oldestPendingJob?: { ageSeconds: number; jobType: string | null } | null;
  /** Worker nodes: how many are stale, and node-offered job types with pending work but no eligible node. */
  nodes?: { stale: number; noEligibleNodeTypes: readonly string[] } | null;
  /** Soonest certificate expiry (days) and its URL. */
  tls?: { daysLeft: number; url: string | null } | null;
  /** Uptime targets whose latest check failed; `allFailed` when every check in the lookback failed. */
  uptimeFailures?: ReadonlyArray<{ url: string; allFailed: boolean; checks: number }> | null;
  /** Collector exporter points over the window: failed and sent, and the exporter with the most failures. */
  collector?: { failed: number; sent: number; exporter: string | null } | null;
  /** Hours since the last successful backup. */
  backupAgeHours?: number | null;
}

const RANK: Record<VerdictLevel, number> = { healthy: 0, degraded: 1, critical: 2, no_data: 3 };

/** Characters of an offender (route or message) a reason line keeps. */
export const VERDICT_OFFENDER_CHARS = 80;

export function computeVerdict(input: VerdictInput): DashboardVerdict {
  const t = DASHBOARD_VERDICT_THRESHOLDS;

  // No data overrides everything: the other rules would be judging silence.
  const staleMs = input.lastDataAt ? input.now.getTime() - input.lastDataAt.getTime() : Number.POSITIVE_INFINITY;
  if (staleMs > t.noDataMinutes * 60_000) {
    return {
      level: 'no_data',
      reasons: [
        input.lastDataAt
          ? `No telemetry received for ${Math.floor(staleMs / 60_000)} min`
          : 'No telemetry received recently',
      ],
    };
  }

  let level: VerdictLevel = 'healthy';
  const reasons: string[] = [];
  const fire = (fired: VerdictLevel, reason: string) => {
    if (RANK[fired] > RANK[level]) level = fired;
    reasons.push(reason);
  };

  if (input.requests >= t.minRequests) {
    const ratePct = (input.errors5xx / input.requests) * 100;
    const at = ratePct > t.errorRatePct.critical ? 'critical' : ratePct > t.errorRatePct.degraded ? 'degraded' : null;
    if (at) {
      fire(
        at,
        `5xx rate ${formatNumber(ratePct)}% (> ${t.errorRatePct[at]}%)${offender('top', input.topErrorRoute)}`,
      );
    }

    if (input.p95Ms !== null) {
      const p95 = input.p95Ms;
      const at95 = p95 > t.p95Ms.critical ? 'critical' : p95 > t.p95Ms.degraded ? 'degraded' : null;
      if (at95) {
        fire(
          at95,
          `p95 latency ${formatNumber(p95)} ms (> ${t.p95Ms[at95]} ms)${offender('slowest', input.slowestRoute)}`,
        );
      }
    }
  }

  if (input.errorLogs >= t.errorLogs.minCurrent) {
    const ratio = input.errorLogs / Math.max(input.previousErrorLogs, 1);
    const at =
      ratio >= t.errorLogs.criticalRatio ? 'critical' : ratio >= t.errorLogs.degradedRatio ? 'degraded' : null;
    if (at) {
      const threshold = at === 'critical' ? t.errorLogs.criticalRatio : t.errorLogs.degradedRatio;
      fire(
        at,
        `Error logs ${input.errorLogs} vs ${input.previousErrorLogs} in the previous window ` +
          `(${formatNumber(ratio)}× ≥ ${threshold}×)${offender('top', input.topErrorMessage)}`,
      );
    }
  }

  if (input.unknownRoutes && input.unknownRoutes.bearerRequests > 0) {
    const { bearerRequests, bearerRoutes, topRoute } = input.unknownRoutes;
    const critical =
      bearerRequests >= t.unknownRoutes.criticalBearerRequests ||
      bearerRoutes >= t.unknownRoutes.criticalDistinctRoutes;
    fire(
      critical ? 'critical' : 'degraded',
      `${bearerRequests} ${bearerRequests === 1 ? 'request' : 'requests'} to unknown API routes` +
        (bearerRoutes > 1 ? ` across ${bearerRoutes} routes` : '') +
        (topRoute ? ` (${shorten(topRoute)})` : ''),
    );
  }

  infrastructureRules(input, fire);

  return { level, reasons };
}

type Fire = (fired: VerdictLevel, reason: string) => void;

/** `>=` thresholds: the level reached, or null. */
function atLeast(value: number, levels: { degraded: number; critical: number }): 'degraded' | 'critical' | null {
  return value >= levels.critical ? 'critical' : value >= levels.degraded ? 'degraded' : null;
}

/** The infrastructure rules (#126). Each runs only when its input is present. */
function infrastructureRules(input: VerdictInput, fire: Fire): void {
  const t = DASHBOARD_VERDICT_THRESHOLDS;

  if (input.disk) {
    const at = atLeast(input.disk.utilizationPct, t.diskUtilizationPct);
    if (at) {
      fire(
        at,
        `Disk ${formatNumber(input.disk.utilizationPct)}% full (≥ ${t.diskUtilizationPct[at]}%)` +
          offender('mountpoint', input.disk.mountpoint),
      );
    }
  }

  if (input.memory) {
    const at = atLeast(input.memory.utilizationPct, t.memoryUtilizationPct);
    if (at) {
      fire(
        at,
        `Memory ${formatNumber(input.memory.utilizationPct)}% used (≥ ${t.memoryUtilizationPct[at]}%)` +
          offender('host', input.memory.host),
      );
    }
  }

  if (input.dbConnections) {
    const at = atLeast(input.dbConnections.utilizationPct, t.dbConnectionsPct);
    if (at) {
      fire(
        at,
        `Database connections at ${formatNumber(input.dbConnections.utilizationPct)}% of max ` +
          `(≥ ${t.dbConnectionsPct[at]}%)${offender('server', input.dbConnections.instance)}`,
      );
    }
  }

  if (input.oldestPendingJob) {
    const minutes = input.oldestPendingJob.ageSeconds / 60;
    const at = atLeast(minutes, t.oldestPendingJobMinutes);
    if (at) {
      fire(
        at,
        `Oldest pending job waiting ${formatNumber(minutes)} min (≥ ${t.oldestPendingJobMinutes[at]} min)` +
          offender('type', input.oldestPendingJob.jobType),
      );
    }
  }

  if (input.nodes) {
    const stuck = input.nodes.noEligibleNodeTypes;
    if (stuck.length > 0) {
      fire(
        'critical',
        `${stuck.length} job type(s) have pending work and no eligible worker node` +
          offender('type', [...stuck].sort().join(', ')),
      );
    }
    if (input.nodes.stale > 0) {
      fire('degraded', `${input.nodes.stale} worker node(s) stale (missed heartbeats)`);
    }
  }

  if (input.tls) {
    const days = input.tls.daysLeft;
    const at = days < t.tlsDaysLeft.critical ? 'critical' : days < t.tlsDaysLeft.degraded ? 'degraded' : null;
    if (at) {
      fire(
        at,
        (days < 0
          ? `TLS certificate expired ${formatNumber(-days)} days ago`
          : `TLS certificate expires in ${formatNumber(days)} days`) +
          ` (< ${t.tlsDaysLeft[at]} days)${offender('url', input.tls.url)}`,
      );
    }
  }

  if (input.uptimeFailures && input.uptimeFailures.length > 0) {
    const failures = [...input.uptimeFailures].sort((a, b) => a.url.localeCompare(b.url));
    const down = failures.filter((f) => f.allFailed && f.checks >= t.uptimeMinChecksForCritical);
    const worst = down[0] ?? failures[0];
    fire(
      down.length > 0 ? 'critical' : 'degraded',
      down.length > 0
        ? `Uptime check failing for every check in the lookback (${down.length} URL(s))${offender('url', worst.url)}`
        : `Uptime check failed on its latest run (${failures.length} URL(s))${offender('url', worst.url)}`,
    );
  }

  if (input.collector && input.collector.failed > 0) {
    const attempted = input.collector.failed + input.collector.sent;
    const pct = attempted > 0 ? (input.collector.failed / attempted) * 100 : 100;
    const at = pct >= t.collectorFailedPct.critical ? 'critical' : 'degraded';
    fire(
      at,
      `Collector failed to export ${formatNumber(input.collector.failed)} points (${formatNumber(pct)}% of attempted` +
        `${at === 'critical' ? `, ≥ ${t.collectorFailedPct.critical}%` : ''})${offender('exporter', input.collector.exporter)}`,
    );
  }

  if (input.backupAgeHours !== undefined && input.backupAgeHours !== null) {
    const hours = input.backupAgeHours;
    const at = hours > t.backupAgeHours.critical ? 'critical' : hours > t.backupAgeHours.degraded ? 'degraded' : null;
    if (at) fire(at, `Last successful backup ${formatNumber(hours)} h ago (> ${t.backupAgeHours[at]} h)`);
  }
}

function offender(label: string, value: string | null | undefined): string {
  if (!value) return '';
  return ` — ${label}: ${shorten(value)}`;
}

/** One line, at most `VERDICT_OFFENDER_CHARS`. */
function shorten(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > VERDICT_OFFENDER_CHARS ? `${oneLine.slice(0, VERDICT_OFFENDER_CHARS - 1)}…` : oneLine;
}

/** One decimal, without a trailing `.0`. */
function formatNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
