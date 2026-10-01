// =============================================================================
// Prescription shapes: reps or cardio, and which one a tracking mode takes
// =============================================================================
//
// A prescribed exercise has exactly one SHAPE (the DB CHECK
// `program_exercises_shape_chk` is the backstop):
//
//   reps    targetSets + repMin + repMax; no duration or distance target
//   cardio  a targetDurationSeconds and/or a targetDistanceMeters (both are
//           the exercise's TOTAL for the session); repMin/repMax null;
//           targetSets optional
//
// The exercise's tracking mode decides which shape it may take:
//
//   weight_reps, bodyweight_reps  reps
//   time                          cardio, duration only
//   distance_time                 cardio, duration and/or distance
//
// Pure and dependency-free: the API, the guardrails, the planner compiler,
// Today and the signals all share it. Distances are meters and durations are
// seconds, always; the labels below are the server's own plain-language
// renderings (change log lines), never a unit preference.
// =============================================================================

export type PrescriptionShape = 'reps' | 'cardio';

/** The fields that decide a prescription's shape. */
export interface PrescriptionFields {
  targetSets: number | null;
  repMin: number | null;
  repMax: number | null;
  targetDurationSeconds: number | null;
  targetDistanceMeters: number | null;
}

/** `cardio` when a duration or distance target is set, else `reps`. */
export function prescriptionShapeOf(fields: Pick<PrescriptionFields, 'targetDurationSeconds' | 'targetDistanceMeters'>): PrescriptionShape {
  return (fields.targetDurationSeconds ?? null) !== null || (fields.targetDistanceMeters ?? null) !== null ? 'cardio' : 'reps';
}

export function isCardioPrescription(fields: Pick<PrescriptionFields, 'targetDurationSeconds' | 'targetDistanceMeters'>): boolean {
  return prescriptionShapeOf(fields) === 'cardio';
}

/** A tracking mode measured in time and/or distance rather than reps. */
export function isCardioTrackingMode(trackingMode: string): boolean {
  return trackingMode === 'time' || trackingMode === 'distance_time';
}

/**
 * Why a prescription does not fit the exercise's tracking mode, or null when
 * it fits. An unknown tracking mode accepts the reps shape only (the safe
 * historical default).
 */
export function prescriptionMismatch(trackingMode: string, fields: PrescriptionFields): string | null {
  const shape = prescriptionShapeOf(fields);
  if (!isCardioTrackingMode(trackingMode)) {
    return shape === 'reps' ? null : 'This exercise is tracked in reps: prescribe sets and reps, not a duration or distance';
  }
  if (shape === 'reps') {
    return trackingMode === 'time'
      ? 'This exercise is tracked in time: prescribe a duration (targetDurationSeconds), not reps'
      : 'This exercise is tracked in time and distance: prescribe a duration and/or a distance, not reps';
  }
  if (trackingMode === 'time') {
    if (fields.targetDistanceMeters !== null) return 'This exercise is tracked in time only: a distance target is not allowed';
    if (fields.targetDurationSeconds === null) return 'This exercise is tracked in time: a duration (targetDurationSeconds) is required';
  }
  return null;
}

// -----------------------------------------------------------------------------
// Labels
// -----------------------------------------------------------------------------

/** `45 s`, `20 min`, `1 h 30 min`. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** `800 m` under a kilometer, else `5 km` / `2.5 km` / `5.25 km`. */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${Number((meters / 1000).toFixed(2))} km`;
}

/**
 * `3 x 8-12`, `3 x 10`, `30 min`, `5 km`, `5 km · 30 min`, `400 m · 4 sets`.
 *
 * A cardio target is the exercise's TOTAL for the session, so it reads as
 * given (distance first, then time), with the set count after it when there
 * is more than one: never `4 x 400 m`, which would read as per-interval.
 * Mirrors the web's `formatPrescription` (`apps/web/src/utils/prescription.ts`).
 */
export function prescriptionLabel(fields: PrescriptionFields): string {
  if (isCardioPrescription(fields)) {
    const parts: string[] = [];
    if (fields.targetDistanceMeters !== null) parts.push(formatDistance(fields.targetDistanceMeters));
    if (fields.targetDurationSeconds !== null) parts.push(formatDuration(fields.targetDurationSeconds));
    if (fields.targetSets !== null && fields.targetSets > 1) parts.push(`${fields.targetSets} sets`);
    return parts.join(' · ');
  }
  const reps = fields.repMin === fields.repMax ? `${fields.repMin}` : `${fields.repMin}-${fields.repMax}`;
  return `${fields.targetSets} x ${reps}`;
}

/**
 * What changed between two prescriptions of one exercise, as one short
 * phrase, or null when nothing a person reads changed:
 *
 *   `20 → 30 min`, `5 → 7.5 km`, `3 x 8-12 → 4 x 8-12`, `30 min → 5 km`,
 *   `30 min → 30 min · 3 sets`
 *
 * A same-unit change shows the unit once; anything else shows both labels.
 */
export function describePrescriptionChange(before: PrescriptionFields, after: PrescriptionFields): string | null {
  const from = prescriptionLabel(before);
  const to = prescriptionLabel(after);
  if (from === to) return null;
  const single = (fields: PrescriptionFields): { value: string; unit: string } | null => {
    if (!isCardioPrescription(fields) || (fields.targetSets !== null && fields.targetSets > 1)) return null;
    if (fields.targetDurationSeconds !== null && fields.targetDistanceMeters !== null) return null;
    const label = fields.targetDurationSeconds !== null ? formatDuration(fields.targetDurationSeconds) : formatDistance(fields.targetDistanceMeters!);
    const at = label.lastIndexOf(' ');
    const value = label.slice(0, at);
    // `1 h 30 min` is not a single value.
    return value.includes(' ') ? null : { value, unit: label.slice(at + 1) };
  };
  const a = single(before);
  const b = single(after);
  if (a && b && a.unit === b.unit) return `${a.value} → ${b.value} ${b.unit}`;
  return `${from} → ${to}`;
}
