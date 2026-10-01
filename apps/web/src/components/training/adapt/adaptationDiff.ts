/**
 * The adjusted workout against the planned one: kept, swapped (from, to),
 * added, dropped (with the reason). Pure. The proposal carries the source of
 * every exercise and what it replaces (by library slug); the planned
 * session, when the page could load it, adds the "before" prescription and
 * the replaced exercise's name.
 */
import { humanize } from '../../../services/exercises';
import type { AdaptationDropReason, AdaptedWorkout } from '../../../services/trainingAdaptation';
import { prescription } from './adaptationCopy';

export interface PlannedExercise {
  slug: string;
  name: string;
  sets: number | null;
  repMin: number | null;
  repMax: number | null;
  /** Cardio prescriptions (#262). */
  targetDurationSeconds?: number | null;
  targetDistanceMeters?: number | null;
  targetRpe: number | null;
}

export type DiffRow =
  | { kind: 'kept'; key: string; name: string; after: string; before: string | null; note: string | null }
  | { kind: 'swapped'; key: string; name: string; fromName: string; after: string; before: string | null; note: string | null }
  | { kind: 'added'; key: string; name: string; after: string; note: string | null }
  | { kind: 'dropped'; key: string; name: string; reason: AdaptationDropReason };

/** `barbell-bench-press` -> `Barbell bench press`, for a slug the page has no name for. */
export function nameFromSlug(slug: string): string {
  return humanize(slug.replace(/-/g, '_'));
}

export function buildAdaptationDiff(proposal: AdaptedWorkout, planned: PlannedExercise[] | null): DiffRow[] {
  const bySlug = new Map((planned ?? []).map((p) => [p.slug, p]));
  const before = (slug: string | null) => {
    const p = slug ? bySlug.get(slug) : undefined;
    return p ? prescription(p) : null;
  };
  const rows: DiffRow[] = [...proposal.exercises]
    .sort((a, b) => a.position - b.position)
    .map((e): DiffRow => {
      const after = prescription(e);
      const key = `${e.position}-${e.exerciseKey}`;
      if (e.source === 'swapped') {
        const from = e.replacesExerciseKey;
        return {
          kind: 'swapped',
          key,
          name: e.name,
          fromName: from ? (bySlug.get(from)?.name ?? nameFromSlug(from)) : 'a planned exercise',
          after,
          before: before(from),
          note: e.note,
        };
      }
      if (e.source === 'added') return { kind: 'added', key, name: e.name, after, note: e.note };
      return { kind: 'kept', key, name: e.name, after, before: before(e.exerciseKey), note: e.note };
    });
  for (const d of proposal.dropped) {
    rows.push({ kind: 'dropped', key: `dropped-${d.exerciseKey}`, name: d.name, reason: d.reason });
  }
  return rows;
}
