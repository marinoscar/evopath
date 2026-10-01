/**
 * How a planned exercise's prescription reads (#262/#263), in one place for
 * the plan viewer, the plan history diff, Today's planned session and the
 * adjusted-workout review.
 *
 * Two shapes (the API's contract; it decides which is valid per
 * `trackingMode`):
 * - reps: `3 × 8–12` (`@ RPE 8` when set). This output is unchanged from
 *   before cardio prescriptions existed.
 * - cardio: a distance and/or a duration, `5 km · 30 min`, `30 min`, `5 km`.
 *   The target is the exercise's TOTAL for the session (the API's contract),
 *   so it reads as given, with the set count AFTER it when there is more
 *   than one: `0.4 km · 4 sets`, `5 km · 30 min · 2 sets`, never `4 × 0.4 km`
 *   (which would read as per-interval). The same rule as the API's
 *   `prescriptionLabel`. Distance reads in km or miles from the Health
 *   Profile unit system (`distanceUnitFor`); the API speaks metres and
 *   seconds only.
 *
 * `ascii` keeps the plan history's older `3 x 8-12` spelling.
 */
import { distanceInputText, formatClock, type DistanceUnit } from './workoutFormat';

export interface PrescriptionFields {
  /** `targetSets` on a plan row, `sets` on Today's session. */
  sets: number | null | undefined;
  repMin: number | null | undefined;
  repMax: number | null | undefined;
  targetRpe?: number | null;
  targetDurationSeconds?: number | null;
  targetDistanceMeters?: number | null;
}

export interface PrescriptionOptions {
  /** Default `km`. */
  distanceUnit?: DistanceUnit;
  /** `3 x 8-12` instead of `3 × 8–12`. */
  ascii?: boolean;
}

const present = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

/** `30 min`, `90 min`; a duration that is not whole minutes reads as a clock (`1:30 min`). */
export function formatTargetDuration(seconds: number): string {
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${formatClock(seconds)} min`;
}

/**
 * `5 km`, `3.11 mi`, `400 m`: in the km unit a distance under a kilometre
 * reads in whole metres, as the API's `formatDistance` does. Miles are
 * unchanged (`0.25 mi`). Display only; inputs stay in km/mi.
 */
export function formatTargetDistance(meters: number, unit: DistanceUnit = 'km'): string {
  if (unit === 'km' && meters < 1000) return `${Math.round(meters)} m`;
  return `${distanceInputText(meters, unit)} ${unit}`;
}

/** The cardio target alone, `5 km · 30 min`; null when the row has neither. */
export function formatCardioTarget(
  target: { targetDurationSeconds?: number | null; targetDistanceMeters?: number | null },
  unit: DistanceUnit = 'km',
): string | null {
  const parts: string[] = [];
  if (present(target.targetDistanceMeters)) parts.push(formatTargetDistance(target.targetDistanceMeters, unit));
  if (present(target.targetDurationSeconds)) parts.push(formatTargetDuration(target.targetDurationSeconds));
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** True when the row is a duration and/or distance prescription. */
export function isCardioPrescription(e: Pick<PrescriptionFields, 'targetDurationSeconds' | 'targetDistanceMeters'>): boolean {
  return present(e.targetDurationSeconds) || present(e.targetDistanceMeters);
}

/** The prescription as one line; see the module comment for the shapes. */
export function formatPrescription(e: PrescriptionFields, options: PrescriptionOptions = {}): string {
  const times = options.ascii ? 'x' : '×';
  const dash = options.ascii ? '-' : '–';
  const rpe = present(e.targetRpe) ? ` @ RPE ${e.targetRpe}` : '';
  const cardio = formatCardioTarget(e, options.distanceUnit);
  if (cardio !== null) {
    const sets = present(e.sets) && e.sets > 1 ? ` · ${e.sets} sets` : '';
    return `${cardio}${sets}${rpe}`;
  }
  const reps = e.repMin === e.repMax ? `${e.repMin}` : `${e.repMin}${dash}${e.repMax}`;
  return `${e.sets} ${times} ${reps}${rpe}`;
}
