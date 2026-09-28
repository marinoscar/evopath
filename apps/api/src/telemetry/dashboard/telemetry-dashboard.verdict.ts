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
//
// The level is the worst rule that fired; `reasons` has one line per fired
// rule with its value, the threshold it crossed and the worst offender.
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

  return { level, reasons };
}

function offender(label: string, value: string | null | undefined): string {
  if (!value) return '';
  const oneLine = value.replace(/\s+/g, ' ').trim();
  const cut = oneLine.length > VERDICT_OFFENDER_CHARS ? `${oneLine.slice(0, VERDICT_OFFENDER_CHARS - 1)}…` : oneLine;
  return ` — ${label}: ${cut}`;
}

/** One decimal, without a trailing `.0`. */
function formatNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
