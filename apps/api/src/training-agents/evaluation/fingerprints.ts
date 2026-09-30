import type { PlanChangeOperation } from '../../programs/contracts/plan-change.contract';

// =============================================================================
// Operation fingerprints: the person's "no" remembered (envelope E9)
// =============================================================================
//
// A fingerprint is `operation | target | value bucket`, independent of plan
// versions (refs shift as a plan changes; exercise keys and workout slots do
// not). Every accepted operation is stored with its fingerprint; when the
// person undoes (reverts) or declines (rejects) a change, its fingerprints
// suppress the same change for 14 days. Forced safety operations are never
// suppressed.
//
//   set_prescription  exercise key, slot, and the bucketed values it sets
//                     (loads to 2.5 kg, RPE to 0.5, rest to 15 s)
//   swap_exercise     from key -> to key
//   remove_exercise   exercise key
//   add_exercise      slot and exercise key
//   set_weekday       slot and weekday
//   drop_workout      slot
//   mark_deload       week number
//   regenerate_remaining (one bucket)
// =============================================================================

export const FEEDBACK_WINDOW_DAYS = 14;

/** Statuses whose operations become suppression fingerprints. */
export const SUPPRESSING_STATUSES: readonly string[] = ['reverted', 'rejected'];

function bucket(value: number, step: number): string {
  return String(Math.round(value / step) * step);
}

/** `W3-2-4` / `W3-2` -> the workout's position in its week (`2`). */
function slotOf(ref: string): string {
  return ref.split('-')[1] ?? '?';
}

export function fingerprintOf(op: PlanChangeOperation, keyOfRef: (ref: string) => string | undefined): string {
  const key = (ref: string) => keyOfRef(ref) ?? 'unknown';

  switch (op.op) {
    case 'set_prescription': {
      const values = [
        op.sets !== null ? `s${op.sets}` : null,
        op.repMin !== null || op.repMax !== null ? `r${op.repMin ?? ''}-${op.repMax ?? ''}` : null,
        op.targetLoadKg !== null ? `l${bucket(op.targetLoadKg, 2.5)}` : null,
        op.targetRpe !== null ? `e${bucket(op.targetRpe, 0.5)}` : null,
        op.restSeconds !== null ? `t${bucket(op.restSeconds, 15)}` : null,
      ].filter((part): part is string => part !== null);
      return `set_prescription|${key(op.target.exerciseRef)}|${slotOf(op.target.exerciseRef)}|${values.join(',')}`;
    }
    case 'swap_exercise':
      return `swap_exercise|${key(op.target.exerciseRef)}|${op.withExerciseKey}`;
    case 'remove_exercise':
      return `remove_exercise|${key(op.target.exerciseRef)}`;
    case 'add_exercise':
      return `add_exercise|${slotOf(op.workoutRef)}|${op.exerciseKey}`;
    case 'set_weekday':
      return `set_weekday|${slotOf(op.workoutRef)}|${op.weekday}`;
    case 'drop_workout':
      return `drop_workout|${slotOf(op.workoutRef)}`;
    case 'mark_deload':
      return `mark_deload|${op.weekNumber}`;
    case 'regenerate_remaining':
      return 'regenerate_remaining';
  }
}

/**
 * The fingerprints to suppress as of `now`: every non-forced stored operation
 * of an entry the person reverted or rejected within the window (decided,
 * else created, at or after `now - 14 days`).
 */
export function suppressedFingerprints(
  entries: ReadonlyArray<{ status: string; createdAt: Date; decidedAt?: Date | null; operations: unknown }>,
  now: Date,
): string[] {
  const since = now.getTime() - FEEDBACK_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const out = new Set<string>();
  for (const entry of entries) {
    if (!SUPPRESSING_STATUSES.includes(entry.status)) continue;
    if ((entry.decidedAt ?? entry.createdAt).getTime() < since) continue;
    if (!Array.isArray(entry.operations)) continue;
    for (const op of entry.operations) {
      const stored = op as { fingerprint?: unknown; forced?: unknown } | null;
      if (stored && typeof stored.fingerprint === 'string' && stored.forced !== true) out.add(stored.fingerprint.slice(0, 300));
    }
  }
  return [...out].sort();
}
