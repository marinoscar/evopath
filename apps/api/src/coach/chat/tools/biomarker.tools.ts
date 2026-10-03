import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import { OUT_OF_RANGE_FLAGS } from '../../../measurements/biomarkers/dto/biomarker-summary.dto';
import { ACTIVE } from '../../../measurements/measurement-active';
import {
  DEFAULT_LAB_UNITS,
  LAB_PANELS,
  getMetric,
  isLabMetric,
  labDisplayUnit,
  toDisplayUnit,
  type LabUnits,
} from '../../../measurements/metric-registry';
import type { CoachChatToolDeps } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';
import { safely } from './minimise';
import { HEALTH_SUMMARY_CONSENT_PATH } from './get-health-summary.tool';

// =============================================================================
// The coach chat's biomarker tools (#327; docs/specs/ai-coach.md §2.9)
// =============================================================================
//
//   list_biomarkers()                               every analyte with a value
//   get_biomarker_values({ keys, sinceDays })       readings of up to 10
//
// CONSENT. Both answer `{ available: false, reason: 'consent_off' }` unless
// the user's health consent is on (`HealthSummaryReader.consentOn`, the
// "Use my health data in training plans and coach chat" toggle at
// `/settings/ai/agents`). This is the coach chat's documented `labs`
// exception (`coach/context/coach-never-send.ts`): raw biomarker values reach
// the COACH CHAT only, through these two tools, while the consent is on. The
// training agents, nudges and the weekly review never receive them.
//
// MINIMISED. Bound to `ctx.userId`; active rows only. Each reading is a date,
// a value, the unit, the numeric reference range and the flag: never an id,
// a note, the printed reference text, the source document or its file name.
// Values are shown in the user's lab unit preference (`labUnits`).
//
// ⚠ No value is logged, counted or put on a span.
// =============================================================================

export const COACH_BIOMARKER_LIST_MAX = 1000;
export const COACH_BIOMARKER_KEYS_MAX = 50;
export const COACH_BIOMARKER_READINGS_MAX = 200;
export const COACH_BIOMARKER_SINCE_DAYS_MAX = 3650;

const CONSENT_OFF = { available: false as const, reason: 'consent_off' as const };
const OUT_OF_RANGE: ReadonlySet<string> = new Set(OUT_OF_RANGE_FLAGS);
const DAY_MS = 24 * 60 * 60 * 1000;

/** What the biomarker tools need: the analyte summary (`BiomarkersService.summary`). */
export interface CoachLabsDeps {
  summary(
    userId: string,
    query: { outOfRange: boolean },
  ): Promise<{
    items: Array<{
      analyteKey: string;
      label: string;
      panel: string;
      unit: string;
      latest: { value: number; measuredAt: string; flag: string | null; referenceLow: number | null; referenceHigh: number | null };
      count: number;
    }>;
  }>;
}

/**
 * Whether a reading is outside its range: the lab's flag when it gave one
 * (`low`, `high`, `critical` -> true; `normal` -> false), else the numeric
 * range when there is one, else null (unknown).
 */
export function outOfRangeOf(
  value: number,
  flag: string | null,
  low: number | null,
  high: number | null,
): boolean | null {
  if (flag && OUT_OF_RANGE.has(flag)) return true;
  if (flag === 'normal') return false;
  if (low === null && high === null) return null;
  return (low !== null && value < low) || (high !== null && value > high);
}

/** A canonical value (or limit) in the display unit; unchanged when that is the canonical unit. */
function shown(key: string, value: number | null, unit: string, canonicalUnit: string): number | null {
  if (value === null || value === undefined) return null;
  return unit === canonicalUnit ? Number(value) : toDisplayUnit(key, Number(value), unit);
}

async function labUnitsOf(deps: CoachChatToolDeps, userId: string): Promise<LabUnits> {
  if (!deps.profile) return DEFAULT_LAB_UNITS;
  try {
    const profile = await deps.profile.healthProfile.get(userId);
    return profile.labUnits === 'si' ? 'si' : DEFAULT_LAB_UNITS;
  } catch {
    return DEFAULT_LAB_UNITS;
  }
}

const panelRank = (panel: string) => {
  const i = (LAB_PANELS as readonly string[]).indexOf(panel);
  return i === -1 ? LAB_PANELS.length : i;
};

export function createListBiomarkersTool(deps: CoachChatToolDeps) {
  return defineTool({
    name: 'list_biomarkers',
    description:
      "Every lab biomarker the user has at least one result for (only if they turned on health data for the coach): " +
      'key, label, panel, unit, the latest value and date, the number of readings, the lab flag and outOfRange ' +
      '(true, false, or null when no range is known). Sorted by panel, then label. Use get_biomarker_values for the ' +
      'history of one or more keys. When it answers available false with reason consent_off, you may tell the user ' +
      `to turn on "Use my health data in training plans and coach chat" (${HEALTH_SUMMARY_CONSENT_PATH}).`,
    parameters: z.object({}),
    execute: (_args, ctx) =>
      safely(async () => {
        if (!deps.healthSummary || !deps.labs) return TOOL_UNAVAILABLE;
        if (!(await deps.healthSummary.consentOn(ctx.userId))) return CONSENT_OFF;
        const [summary, labUnits] = await Promise.all([
          deps.labs.summary(ctx.userId, { outOfRange: false }),
          labUnitsOf(deps, ctx.userId),
        ]);
        const items = [...summary.items].sort(
          (a, b) => panelRank(a.panel) - panelRank(b.panel) || a.label.localeCompare(b.label) || a.analyteKey.localeCompare(b.analyteKey),
        );
        const biomarkers = items.slice(0, COACH_BIOMARKER_LIST_MAX).map((item) => {
          const metric = getMetric(item.analyteKey);
          const unit = metric ? labDisplayUnit(metric, labUnits) : item.unit;
          const canonical = metric?.canonicalUnit ?? item.unit;
          const { latest } = item;
          return {
            key: item.analyteKey,
            label: item.label,
            panel: item.panel,
            unit,
            latest: {
              date: latest.measuredAt.slice(0, 10),
              value: shown(item.analyteKey, latest.value, unit, canonical),
              referenceLow: shown(item.analyteKey, latest.referenceLow, unit, canonical),
              referenceHigh: shown(item.analyteKey, latest.referenceHigh, unit, canonical),
              flag: latest.flag,
              outOfRange: outOfRangeOf(Number(latest.value), latest.flag, latest.referenceLow, latest.referenceHigh),
            },
            readings: item.count,
          };
        });
        return {
          available: true,
          labUnits,
          biomarkers,
          ...(items.length > COACH_BIOMARKER_LIST_MAX ? { truncated: true, total: items.length } : {}),
        };
      }, TOOL_UNAVAILABLE),
  });
}

export function createGetBiomarkerValuesTool(deps: CoachChatToolDeps) {
  return defineTool({
    name: 'get_biomarker_values',
    description:
      `The readings of up to ${COACH_BIOMARKER_KEYS_MAX} lab biomarkers (keys from list_biomarkers), newest first, at ` +
      `most ${COACH_BIOMARKER_READINGS_MAX} per key: date, value, unit, referenceLow, referenceHigh, flag and ` +
      'outOfRange. sinceDays limits how far back (null = all). Keys that are not lab biomarkers come back in ' +
      '`unknown`. Only if the user turned on health data for the coach (else available false, reason consent_off).',
    parameters: z.object({
      keys: z.array(z.string()).describe(`1 to ${COACH_BIOMARKER_KEYS_MAX} biomarker keys, e.g. ["ldl_cholesterol"].`),
      sinceDays: z
        .number()
        .nullable()
        .describe(`Only readings from the last N days (1 to ${COACH_BIOMARKER_SINCE_DAYS_MAX}), or null for all.`),
    }),
    execute: (args, ctx) =>
      safely(async () => {
        const keys = [...new Set(args.keys.map((k) => k.trim()).filter((k) => k.length > 0))];
        if (keys.length < 1 || keys.length > COACH_BIOMARKER_KEYS_MAX) {
          return { ok: false, error: 'INVALID_KEYS', message: `Pass 1 to ${COACH_BIOMARKER_KEYS_MAX} biomarker keys.` };
        }
        const sinceDays = args.sinceDays;
        if (sinceDays !== null && (!Number.isInteger(sinceDays) || sinceDays < 1 || sinceDays > COACH_BIOMARKER_SINCE_DAYS_MAX)) {
          return {
            ok: false,
            error: 'INVALID_SINCE_DAYS',
            message: `sinceDays must be a whole number from 1 to ${COACH_BIOMARKER_SINCE_DAYS_MAX}, or null.`,
          };
        }
        if (!deps.healthSummary) return TOOL_UNAVAILABLE;
        if (!(await deps.healthSummary.consentOn(ctx.userId))) return CONSENT_OFF;

        const known = keys.filter((key) => isLabMetric(key));
        const unknown = keys.filter((key) => !isLabMetric(key));
        const labUnits = await labUnitsOf(deps, ctx.userId);
        const since = sinceDays === null ? null : new Date(deps.now().getTime() - sinceDays * DAY_MS);

        const biomarkers = await Promise.all(
          known.map(async (key) => {
            const metric = getMetric(key)!;
            const unit = labDisplayUnit(metric, labUnits);
            const rows = await deps.prisma.measurement.findMany({
              where: { userId: ctx.userId, ...ACTIVE, metricKey: key, ...(since ? { measuredAt: { gte: since } } : {}) },
              orderBy: [{ measuredAt: 'desc' }, { createdAt: 'desc' }],
              take: COACH_BIOMARKER_READINGS_MAX,
              select: { value: true, measuredAt: true, flag: true, referenceLow: true, referenceHigh: true },
            });
            return {
              key,
              label: metric.label,
              panel: metric.panel ?? null,
              unit,
              readings: rows.map((row) => ({
                date: row.measuredAt.toISOString().slice(0, 10),
                value: shown(key, row.value, unit, metric.canonicalUnit),
                referenceLow: shown(key, row.referenceLow ?? null, unit, metric.canonicalUnit),
                referenceHigh: shown(key, row.referenceHigh ?? null, unit, metric.canonicalUnit),
                flag: row.flag ?? null,
                outOfRange: outOfRangeOf(row.value, row.flag ?? null, row.referenceLow ?? null, row.referenceHigh ?? null),
              })),
            };
          }),
        );
        return { available: true, labUnits, biomarkers, unknown };
      }, TOOL_UNAVAILABLE),
  });
}
