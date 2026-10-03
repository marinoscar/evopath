import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import { fromDbDate } from '../../../check-ins/local-date';
import { ACTIVE } from '../../../measurements/measurement-active';
import { LAB_METRIC_KEYS, METRICS, getMetric } from '../../../measurements/metric-registry';
import type { CoachChatToolDeps } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';
import { safely } from './minimise';
import { dropNulls, resolveRange, round, userText } from './user-context';

/** Days `get_measurements` covers by default, and at most. */
export const COACH_MEASUREMENTS_DEFAULT_DAYS = 365;
export const COACH_MEASUREMENTS_MAX_DAYS = 3650;
/** Readings returned at most (newest first). */
export const COACH_MEASUREMENTS_MAX = 2000;

const CATEGORIES = ['body', 'vital', 'wellness', 'lab'] as const;

/**
 * `get_measurements` (#338): the caller's measurement history of every kind
 * (body: weight, body fat, waist; vitals: heart rate, HRV, blood pressure;
 * wellness: the check-in scores; labs) in a date range, filterable by metric
 * key or category: value, unit, local date, method, origin, the user's note,
 * and for labs the reference range, printed reference text and flag.
 *
 * LABS stay behind the user's own health-data switch ("Use my health data in
 * training plans and coach chat", `HealthSummaryReader.consentOn`): with it
 * off, lab rows are left out and the answer says so. Never the source
 * document reference, a provider's external id or the synced device id.
 */
export function createGetMeasurementsTool(deps: CoachChatToolDeps) {
  return defineTool({
    name: 'get_measurements',
    description:
      "The user's measurement history, newest first: body (weight, body fat %, waist), vitals (resting and average " +
      'heart rate, HRV, blood pressure), wellness (check-in scores) and labs (only while the user\'s health-data ' +
      'setting is on): metricKey, label, value, unit, date, method, origin (manual, device, ai, calculated), the ' +
      "user's note, and for labs the reference range, reference text and flag; plus a per-metric summary (count, " +
      'first, latest, min, max, change). metricKey (e.g. "weight") or category (body, vital, wellness, lab) narrow ' +
      `it, or null for all. from/to are local dates or null (default the last ${COACH_MEASUREMENTS_DEFAULT_DAYS} days).`,
    parameters: z.object({
      metricKey: z.string().nullable().describe('One metric key, e.g. "weight", or null.'),
      category: z.enum(CATEGORIES).nullable().describe('body, vital, wellness or lab, or null.'),
      from: z.string().nullable().describe('First local date, YYYY-MM-DD, or null.'),
      to: z.string().nullable().describe('Last local date, YYYY-MM-DD, or null for today.'),
    }),
    execute: (args, ctx) =>
      safely(async () => {
        const [today, consent] = await Promise.all([
          deps.checkIns.today(ctx.userId, deps.now()),
          deps.healthSummary ? deps.healthSummary.consentOn(ctx.userId).catch(() => false) : Promise.resolve(false),
        ]);
        const range = resolveRange(args, today, COACH_MEASUREMENTS_DEFAULT_DAYS, COACH_MEASUREMENTS_MAX_DAYS);
        if ('error' in range) return range;

        let keys: string[] | null = null;
        if (args.metricKey) {
          if (!getMetric(args.metricKey)) return { error: 'invalid_arguments', message: `Unknown metricKey "${args.metricKey}".` };
          keys = [args.metricKey];
        } else if (args.category) {
          keys = METRICS.filter((metric) => metric.category === args.category).map((metric) => metric.key);
        }
        const labs = new Set(LAB_METRIC_KEYS);
        const labsWithheld = !consent && (keys === null || keys.some((key) => labs.has(key)));
        if (!consent) keys = (keys ?? METRICS.map((metric) => metric.key)).filter((key) => !labs.has(key));

        const rows = await deps.prisma.measurement.findMany({
          where: {
            userId: ctx.userId,
            ...ACTIVE,
            ...(keys ? { metricKey: { in: keys } } : {}),
            measuredAt: { gte: new Date(`${range.from}T00:00:00.000Z`), lt: new Date(new Date(`${range.to}T00:00:00.000Z`).getTime() + 2 * 86_400_000) },
          },
          orderBy: [{ measuredAt: 'desc' }],
          take: COACH_MEASUREMENTS_MAX,
          select: {
            metricKey: true,
            value: true,
            unit: true,
            measuredAt: true,
            localDate: true,
            method: true,
            origin: true,
            notes: true,
            referenceLow: true,
            referenceHigh: true,
            referenceText: true,
            flag: true,
          },
        });

        const readings = rows
          .map((row) => ({ row, date: row.localDate ? fromDbDate(row.localDate) : row.measuredAt.toISOString().slice(0, 10) }))
          .filter(({ date }) => date >= range.from && date <= range.to)
          .map(({ row, date }) =>
            dropNulls({
              metricKey: row.metricKey,
              label: getMetric(row.metricKey)?.label ?? null,
              category: getMetric(row.metricKey)?.category ?? null,
              value: round(row.value, 3),
              unit: row.unit,
              date,
              method: row.method === 'unspecified' ? null : row.method,
              origin: row.origin,
              note: userText(row.notes),
              referenceLow: row.referenceLow,
              referenceHigh: row.referenceHigh,
              referenceText: userText(row.referenceText),
              flag: row.flag,
            }),
          );

        const summary: Record<string, { count: number; first: unknown; latest: unknown; min: number; max: number; change: number }> = {};
        for (const reading of [...readings].reverse()) {
          const key = reading.metricKey!;
          const value = reading.value!;
          const s = summary[key];
          if (!s) {
            summary[key] = { count: 1, first: { value, date: reading.date }, latest: { value, date: reading.date }, min: value, max: value, change: 0 };
            continue;
          }
          s.count += 1;
          s.latest = { value, date: reading.date };
          s.min = Math.min(s.min, value);
          s.max = Math.max(s.max, value);
          s.change = round(value - (s.first as { value: number }).value, 3);
        }

        return {
          from: range.from,
          to: range.to,
          ...(range.clamped ? { clampedTo: `${COACH_MEASUREMENTS_MAX_DAYS} days` } : {}),
          ...(labsWithheld
            ? { labs: 'Lab results are left out: the user\'s "Use my health data in training plans and coach chat" setting is off.' }
            : {}),
          ...(rows.length === COACH_MEASUREMENTS_MAX ? { truncated: 'More readings exist: narrow the range or the metric.' } : {}),
          summary,
          readings,
        };
      }, TOOL_UNAVAILABLE),
  });
}
