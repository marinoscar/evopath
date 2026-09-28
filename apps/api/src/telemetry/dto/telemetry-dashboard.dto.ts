import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { EVENT_SEVERITIES, SEARCH_MAX_LENGTH } from '../dashboard/telemetry-dashboard.sql';
import { VERDICT_LEVELS } from '../dashboard/telemetry-dashboard.verdict';

// =============================================================================
// Telemetry dashboard — request and response shapes (issue #577, epic #576)
// =============================================================================
//
//   GET /api/admin/telemetry/dashboard/summary     → TelemetryDashboardSummaryDto
//   GET /api/admin/telemetry/dashboard/timeseries  → TelemetryDashboardTimeseriesDto
//   GET /api/admin/telemetry/dashboard/top         → TelemetryDashboardTopDto
//   GET /api/admin/telemetry/dashboard/events      → TelemetryDashboardEventsDto
//   GET /api/admin/telemetry/dashboard/filters     → TelemetryDashboardFiltersDto
//
// Common query: `range` (15m|1h|6h|24h|7d, default 1h) OR `from`+`to` (ISO,
// from < to, to <= now + 1 min, span <= 30 days); `service`, `instance`
// (checked by the service against the values seen in the range);
// `buckets` (30|60, default 60). Every query value arrives as a string.
// =============================================================================

export const DASHBOARD_RANGES = ['15m', '1h', '6h', '24h', '7d'] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

export const DASHBOARD_RANGE_MS: Record<DashboardRange, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

export const DEFAULT_DASHBOARD_RANGE: DashboardRange = '1h';
export const DASHBOARD_MAX_SPAN_MS = 30 * 24 * 60 * 60_000;
/** How far past now `to` may be (clock skew between browser and server). */
export const DASHBOARD_FUTURE_SKEW_MS = 60_000;
export const DASHBOARD_BUCKET_COUNTS = ['30', '60'] as const;
export const DASHBOARD_FILTER_VALUE_MAX = 200;
export const DASHBOARD_CURSOR_MAX = 512;

const commonShape = {
  range: z.enum(DASHBOARD_RANGES).optional().describe('Relative window ending now. Default `1h`. Not with `from`/`to`.'),
  from: z.iso.datetime({ offset: true }).optional().describe('Absolute window start (ISO 8601). Requires `to`.'),
  to: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('Absolute window end (ISO 8601), at most 1 minute in the future. Requires `from`; span <= 30 days.'),
  service: z
    .string()
    .min(1)
    .max(DASHBOARD_FILTER_VALUE_MAX)
    .optional()
    .describe('Only this service. Must be one of `/filters` `services` for the range.'),
  instance: z
    .string()
    .min(1)
    .max(DASHBOARD_FILTER_VALUE_MAX)
    .optional()
    .describe('Only this instance (`app.instance.id`). Must be one of `/filters` `instances` for the range.'),
  buckets: z.enum(DASHBOARD_BUCKET_COUNTS).optional().describe('Target number of buckets: `30` or `60` (default).'),
};

type CommonInput = {
  range?: string;
  from?: string;
  to?: string;
};

/** Cross-field rules of the window. Exported for the unit tests. */
export function refineWindow(value: CommonInput, ctx: z.RefinementCtx): void {
  const hasFrom = value.from !== undefined;
  const hasTo = value.to !== undefined;

  if (value.range !== undefined && (hasFrom || hasTo)) {
    ctx.addIssue({ code: 'custom', path: ['range'], message: 'Use either `range` or `from`/`to`, not both.' });
    return;
  }
  if (hasFrom !== hasTo) {
    ctx.addIssue({ code: 'custom', path: [hasFrom ? 'to' : 'from'], message: '`from` and `to` go together.' });
    return;
  }
  if (!hasFrom) return;

  const from = Date.parse(value.from as string);
  const to = Date.parse(value.to as string);
  if (!(from < to)) {
    ctx.addIssue({ code: 'custom', path: ['from'], message: '`from` must be before `to`.' });
    return;
  }
  if (to > Date.now() + DASHBOARD_FUTURE_SKEW_MS) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: '`to` may be at most 1 minute in the future.' });
  }
  if (to - from > DASHBOARD_MAX_SPAN_MS) {
    ctx.addIssue({ code: 'custom', path: ['from'], message: 'The window may span at most 30 days.' });
  }
}

export const telemetryDashboardQuerySchema = z.object(commonShape).superRefine(refineWindow);
export class TelemetryDashboardQueryDto extends createZodDto(telemetryDashboardQuerySchema) {}
export type TelemetryDashboardQuery = z.infer<typeof telemetryDashboardQuerySchema>;

export const DASHBOARD_PANELS = ['api', 'logs'] as const;
export const telemetryDashboardTimeseriesQuerySchema = z
  .object({ ...commonShape, panel: z.enum(DASHBOARD_PANELS).describe('`api` (status classes, p95) or `logs` (severity bands).') })
  .superRefine(refineWindow);
export class TelemetryDashboardTimeseriesQueryDto extends createZodDto(telemetryDashboardTimeseriesQuerySchema) {}
export type TelemetryDashboardTimeseriesQuery = z.infer<typeof telemetryDashboardTimeseriesQuerySchema>;

export const DASHBOARD_TOP_KINDS = ['routes', 'errors'] as const;
export const telemetryDashboardTopQuerySchema = z
  .object({ ...commonShape, kind: z.enum(DASHBOARD_TOP_KINDS).describe('`routes` (by 5xx, then p95) or `errors` (log messages).') })
  .superRefine(refineWindow);
export class TelemetryDashboardTopQueryDto extends createZodDto(telemetryDashboardTopQuerySchema) {}
export type TelemetryDashboardTopQuery = z.infer<typeof telemetryDashboardTopQuerySchema>;

const SEVERITY_LIST = new RegExp(`^(${EVENT_SEVERITIES.join('|')})(,(${EVENT_SEVERITIES.join('|')}))*$`);

export const telemetryDashboardEventsQuerySchema = z
  .object({
    ...commonShape,
    severity: z
      .string()
      .regex(SEVERITY_LIST, 'A comma-separated list of error, warn, info.')
      .optional()
      .describe('Comma-separated severities: `error`, `warn`, `info`. Default `error,warn`.'),
    q: z
      .string()
      .max(SEARCH_MAX_LENGTH)
      .optional()
      .describe('Case-insensitive substring of the log body (at most 200 characters; `%` and `_` are literal).'),
    cursor: z
      .string()
      .max(DASHBOARD_CURSOR_MAX)
      .optional()
      .describe('`nextCursor` of the previous page.'),
  })
  .superRefine(refineWindow);
export class TelemetryDashboardEventsQueryDto extends createZodDto(telemetryDashboardEventsQuerySchema) {}
export type TelemetryDashboardEventsQuery = z.infer<typeof telemetryDashboardEventsQuerySchema>;

// ---- responses ---------------------------------------------------------------

const envelope = {
  range: z.object({
    from: z.string().describe('Window start, ISO 8601.'),
    to: z.string().describe('Window end (exclusive), ISO 8601.'),
    bucketSeconds: z.number().int().describe('Bucket size used for series and sparklines.'),
  }),
  generatedAt: z.string().describe('When the telemetry store was read (results are cached for 15 s).'),
  truncated: z.boolean().describe('A row cap cut a list short.'),
  sql: z
    .union([z.string(), z.array(z.string())])
    .describe('The exact statement(s) run, primary first.'),
};

const tileValue = z.union([z.number(), z.string()]).nullable();

export const telemetryDashboardTileSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: tileValue.describe('Current window value; null when there is nothing to measure.'),
  previous: tileValue.describe('Same measure over the previous window of equal length.'),
  unit: z.string().describe('`req/min`, `%`, `ms`, `count`, `bytes` or `timestamp`.'),
  sparkline: z.array(z.number().nullable()).describe('One value per bucket of the window; null where unmeasurable.'),
});
export type TelemetryDashboardTile = z.infer<typeof telemetryDashboardTileSchema>;

export const telemetryDashboardSummarySchema = z.object({
  ...envelope,
  verdict: z.object({
    level: z.enum(VERDICT_LEVELS),
    reasons: z.array(z.string()),
  }),
  tiles: z.array(telemetryDashboardTileSchema),
  runtime: z
    .array(telemetryDashboardTileSchema)
    .optional()
    .describe('Heap used and event-loop delay p99, when the runtime metric tables exist. Not filtered by instance.'),
});
export class TelemetryDashboardSummaryDto extends createZodDto(telemetryDashboardSummarySchema) {}
export type TelemetryDashboardSummary = z.infer<typeof telemetryDashboardSummarySchema>;

export const apiBucketSchema = z.object({
  t: z.string(),
  s2xx: z.number(),
  s3xx: z.number(),
  s4xx: z.number(),
  s5xx: z.number(),
  p95Ms: z.number().nullable(),
});
export const logsBucketSchema = z.object({
  t: z.string(),
  error: z.number(),
  warn: z.number(),
  info: z.number(),
  other: z.number(),
});

export const telemetryDashboardTimeseriesSchema = z.object({
  ...envelope,
  panel: z.enum(DASHBOARD_PANELS),
  buckets: z.union([z.array(apiBucketSchema), z.array(logsBucketSchema)]),
});
export class TelemetryDashboardTimeseriesDto extends createZodDto(telemetryDashboardTimeseriesSchema) {}
export type TelemetryDashboardTimeseries = z.infer<typeof telemetryDashboardTimeseriesSchema>;

export const topRouteSchema = z.object({
  method: z.string().nullable(),
  route: z.string().nullable().describe('The request path with numeric/UUID/hex segments normalized to `:id`.'),
  count: z.number(),
  errors: z.number().describe('5xx responses.'),
  errorRatePct: z.number(),
  p95Ms: z.number().nullable(),
});
export const topErrorSchema = z.object({
  message: z.string().nullable(),
  count: z.number(),
  firstSeen: z.string().nullable(),
  lastSeen: z.string().nullable(),
  sampleTraceId: z.string().nullable(),
  service: z.string().nullable(),
});

export const telemetryDashboardTopSchema = z.object({
  ...envelope,
  kind: z.enum(DASHBOARD_TOP_KINDS),
  items: z.union([z.array(topRouteSchema), z.array(topErrorSchema)]),
});
export class TelemetryDashboardTopDto extends createZodDto(telemetryDashboardTopSchema) {}
export type TelemetryDashboardTop = z.infer<typeof telemetryDashboardTopSchema>;

export const dashboardEventSchema = z.object({
  timestamp: z.string().describe('Full precision (up to nanoseconds), UTC.'),
  severity: z.string(),
  service: z.string().nullable(),
  body: z.string().nullable(),
  traceId: z.string().nullable(),
  spanId: z.string().nullable(),
});

export const telemetryDashboardEventsSchema = z.object({
  ...envelope,
  items: z.array(dashboardEventSchema),
  nextCursor: z.string().nullable(),
});
export class TelemetryDashboardEventsDto extends createZodDto(telemetryDashboardEventsSchema) {}
export type TelemetryDashboardEvents = z.infer<typeof telemetryDashboardEventsSchema>;

export const telemetryDashboardFiltersSchema = z.object({
  ...envelope,
  services: z.array(z.string()),
  instances: z.array(z.string()),
});
export class TelemetryDashboardFiltersDto extends createZodDto(telemetryDashboardFiltersSchema) {}
export type TelemetryDashboardFilters = z.infer<typeof telemetryDashboardFiltersSchema>;
