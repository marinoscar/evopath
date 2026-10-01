/**
 * Lab unit preference, issue #234: show blood work in US conventional units
 * (mg/dL, the catalog's canonical unit) or in SI units (mmol/L, µmol/L).
 *
 * DISPLAY ONLY. Every value the API returns is canonical and stays so; these
 * pure helpers turn a canonical value into the preferred unit, using the
 * catalog's own conversion (`canonical = value × factor + offset`, published
 * per unit by `GET /api/measurements/metrics`). This file holds no factor of
 * its own, and nothing here decides a flag, a range or a delta.
 */
import type { HealthProfile, LabUnits, MetricDef, MetricUnitDef } from '../services/health';
import type { BiomarkerSummaryItem, LabRangeContext } from '../services/biomarkers';
import { roundTo } from './measurementUnits';

export type { LabUnits } from '../services/health';

/** The preference when it is unknown (no profile yet, a load failure): today's output. */
export const DEFAULT_LAB_UNITS: LabUnits = 'conventional';

/** The choices as the settings and export pickers name them. */
export const LAB_UNITS_LABELS: Record<LabUnits, string> = {
  conventional: 'US conventional (mg/dL)',
  si: 'SI (mmol/L)',
};

/** Short names, for the recent exports list. */
export const LAB_UNITS_SHORT_LABELS: Record<LabUnits, string> = {
  conventional: 'US conventional',
  si: 'SI',
};

/** What every lab view says about the numbers it shows. */
export function labUnitsNote(labUnits: LabUnits): string {
  return labUnits === 'si' ? 'Values in SI units' : 'Values in US conventional units';
}

/** The profile's preference, `conventional` when unknown or unrecognised. */
export function labUnitsOf(profile: Partial<Pick<HealthProfile, 'labUnits'>> | null | undefined): LabUnits {
  return profile?.labUnits === 'si' ? 'si' : DEFAULT_LAB_UNITS;
}

/** The canonical unit's entry (factor 1); synthesised when the catalog does not list it. */
function canonicalEntry(metric: MetricDef): MetricUnitDef {
  return (
    metric.units.find((unit) => unit.unit === metric.canonicalUnit) ?? {
      unit: metric.canonicalUnit,
      factor: 1,
      label: metric.canonicalUnit,
    }
  );
}

/**
 * The unit entry `metric` is shown in: its `siUnit` under `si` (when the
 * catalog declares one it accepts), its canonical unit otherwise.
 */
export function labDisplayUnit(metric: MetricDef, labUnits: LabUnits): MetricUnitDef {
  if (labUnits === 'si' && metric.siUnit) {
    const si = metric.units.find((unit) => unit.unit === metric.siUnit);
    if (si) return si;
  }
  return canonicalEntry(metric);
}

/** A canonical value in `unit`, unrounded: `(value − offset) / factor`. */
export function convertFromCanonical(value: number, unit: Pick<MetricUnitDef, 'factor' | 'offset'>): number {
  return (value - (unit.offset ?? 0)) / unit.factor;
}

/**
 * A canonical value in `unit`, rounded to the unit's `decimals` (else
 * `fallbackDecimals`; unrounded without either). Glucose 100 mg/dL → 5.55 mmol/L.
 */
export function toDisplay(
  value: number,
  unit: Pick<MetricUnitDef, 'factor' | 'offset' | 'decimals'>,
  fallbackDecimals?: number,
): number {
  const converted = convertFromCanonical(value, unit);
  const decimals = unit.decimals ?? fallbackDecimals;
  return decimals === undefined ? converted : roundTo(converted, decimals);
}

/** A canonical DIFFERENCE in `unit`: the factor only, never the offset. Unrounded. */
export function deltaFromCanonical(delta: number, unit: Pick<MetricUnitDef, 'factor'>): number {
  return delta / unit.factor;
}

/** A canonical difference in `unit`, rounded like `toDisplay`. */
export function deltaToDisplay(
  delta: number,
  unit: Pick<MetricUnitDef, 'factor' | 'decimals'>,
  fallbackDecimals?: number,
): number {
  const converted = deltaFromCanonical(delta, unit);
  const decimals = unit.decimals ?? fallbackDecimals;
  return decimals === undefined ? converted : roundTo(converted, decimals);
}

// -----------------------------------------------------------------------------
// One analyte's display: a converter the views apply to the API's rows
// -----------------------------------------------------------------------------

/**
 * How one analyte is shown under one preference. `converted` is false when
 * the display unit IS the canonical one (conventional, or an analyte whose SI
 * unit is canonical): the rows then pass through untouched, so the default
 * output is exactly what it was before the preference existed.
 */
export interface LabDisplay {
  /** The unit values are shown in. */
  unit: string;
  /** The precision values are shown with. */
  decimals: number | undefined;
  converted: boolean;
  /** A canonical value, converted (unrounded; format with `decimals`). */
  value: (canonical: number) => number;
  /** A canonical difference, converted with the factor only (unrounded). */
  delta: (canonical: number) => number;
  /** A printed limit, converted and rounded to `decimals` (a limit is read, not computed with). */
  limit: (canonical: number | null) => number | null;
}

const identity = (value: number) => value;

/** The display of `metric` under `labUnits`; without a metric (catalog not loaded), nothing converts. */
export function labDisplay(
  metric: MetricDef | null | undefined,
  labUnits: LabUnits,
  fallbackUnit = '',
): LabDisplay {
  if (!metric) {
    return { unit: fallbackUnit, decimals: undefined, converted: false, value: identity, delta: identity, limit: (v) => v };
  }
  const entry = labDisplayUnit(metric, labUnits);
  const converted = entry.unit !== metric.canonicalUnit && (entry.factor !== 1 || (entry.offset ?? 0) !== 0);
  if (!converted) {
    return {
      unit: metric.canonicalUnit,
      decimals: metric.decimals,
      converted: false,
      value: identity,
      delta: identity,
      limit: (v) => v,
    };
  }
  const decimals = entry.decimals ?? metric.decimals;
  return {
    unit: entry.unit,
    decimals,
    converted: true,
    value: (v) => convertFromCanonical(v, entry),
    delta: (d) => deltaFromCanonical(d, entry),
    limit: (v) => (v === null ? null : toDisplay(v, entry, decimals)),
  };
}

/** A row's printed range in the display unit (the printed TEXT is left as the lab wrote it). */
export function convertLabRange<T extends Pick<LabRangeContext, 'referenceLow' | 'referenceHigh'>>(
  row: T,
  display: LabDisplay,
): T {
  if (!display.converted) return row;
  return { ...row, referenceLow: display.limit(row.referenceLow), referenceHigh: display.limit(row.referenceHigh) };
}

/**
 * A canonical row (value, unit and printed range) in the display unit. A row
 * whose `unit` is not the canonical one is left alone: it cannot be converted
 * with the catalog's canonical factors.
 */
export function convertLabRow<T extends { value: number; unit: string } & Pick<LabRangeContext, 'referenceLow' | 'referenceHigh'>>(
  row: T,
  display: LabDisplay,
  canonicalUnit: string,
): T {
  if (!display.converted || row.unit !== canonicalUnit) return row;
  return { ...convertLabRange(row, display), value: display.value(row.value), unit: display.unit };
}

/** A series point (no unit of its own; the series is canonical) in the display unit. */
export function convertLabPoint<T extends { value: number } & Pick<LabRangeContext, 'referenceLow' | 'referenceHigh'>>(
  point: T,
  display: LabDisplay,
): T {
  if (!display.converted) return point;
  return { ...convertLabRange(point, display), value: display.value(point.value) };
}

/** A biomarker summary item (latest, previous, delta, ranges) in the display unit. */
export function convertSummaryItem(item: BiomarkerSummaryItem, display: LabDisplay, canonicalUnit: string): BiomarkerSummaryItem {
  if (!display.converted || item.unit !== canonicalUnit) return item;
  return {
    ...item,
    unit: display.unit,
    latest: convertLabPoint(item.latest, display),
    previous: item.previous ? convertLabPoint(item.previous, display) : null,
    delta: item.delta === null ? null : display.delta(item.delta),
  };
}
