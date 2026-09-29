import { sourcePhotoIdsFor } from '../../intake/intake-analyzer';
import type { DraftItemConfidence } from '../../intake/intake-kind.interface';
import { SET_BOUNDS } from '../workouts.constants';
import {
  WORKOUT_PREFILL_ITEM_KIND,
  type WorkoutPrefillSet,
  type WorkoutPrefillValue,
} from '../intake/workout-prefill.value';
import { resolveLibraryExercise, type ExerciseVocabulary } from './exercise-vocabulary';
import {
  OTHER_EXERCISE_SLUG,
  WORKOUT_PREFILL_NAME_MAX,
  type WorkoutPrefillOutputItem,
  type WorkoutPrefillOutputSet,
} from './workout-prefill.prompt';

// =============================================================================
// Model output -> draft items (E4.5)
// =============================================================================
//
// One model item becomes one draft, always: low confidence, `other` and
// uncertain items are kept (the user decides, never a filter).
//
// UNITS. The API is kilograms. A weight with a written unit converts from it
// (a written unit always wins); a weight without one converts from the user's
// Health Profile unit (imperial -> lb, otherwise kg), and the item is then
// flagged: `uncertain`, "Unit not written; assumed <unit>." appended to the
// note, and a `high` confidence lowered to `medium`. Kilograms are rounded to
// 3 decimals, metres to 2. A weight that converts past the 1000 kg bound is
// left empty and flagged rather than dropping the item.
//
// `sourcePhotoIndexes` are 0-based within the request's chunk; they become the
// chunk's storage object ids (out-of-range indexes are dropped; an item with
// none left points at every photo of the chunk).
// =============================================================================

export type WeightUnit = 'kg' | 'lb';

/** Kilograms per pound (exact, by definition). */
export const KG_PER_LB = 0.45359237;

/** A draft as `IntakeService.replaceAiDrafts` takes it, with a typed value. */
export interface WorkoutPrefillDraft {
  kind: typeof WORKOUT_PREFILL_ITEM_KIND;
  confidence: DraftItemConfidence;
  uncertain: boolean;
  uncertaintyNote: string | null;
  sourcePhotoIds: string[];
  value: WorkoutPrefillValue;
}

/** The weight unit a Health Profile `unitSystem` implies; `metric` when there is no profile. */
export function weightUnitFor(unitSystem: string | null | undefined): WeightUnit {
  return unitSystem === 'imperial' ? 'lb' : 'kg';
}

export function unitAssumedNote(unit: WeightUnit): string {
  return `Unit not written; assumed ${unit}.`;
}

export const WEIGHT_OVER_BOUND_NOTE = `A weight above ${SET_BOUNDS.weightKg.max} kg was left empty.`;

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function toKilograms(weight: number, unit: WeightUnit): number {
  return roundTo(unit === 'lb' ? weight * KG_PER_LB : weight, SET_BOUNDS.weightKg.decimals);
}

function text(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

interface MappedSets {
  sets: WorkoutPrefillSet[];
  unitAssumed: boolean;
  overBound: boolean;
}

function mapSets(sets: readonly WorkoutPrefillOutputSet[], profileUnit: WeightUnit): MappedSets {
  let unitAssumed = false;
  let overBound = false;

  const mapped = sets.map((set): WorkoutPrefillSet => {
    let weightKg: number | null = null;

    if (set.weight !== null) {
      if (set.weightUnit === null) unitAssumed = true;
      const kg = toKilograms(set.weight, set.weightUnit ?? profileUnit);
      if (kg > SET_BOUNDS.weightKg.max) {
        overBound = true;
      } else {
        weightKg = kg;
      }
    }

    return {
      reps: set.reps,
      weightKg,
      durationSeconds: set.durationSeconds,
      distanceMeters: set.distanceMeters === null ? null : roundTo(set.distanceMeters, SET_BOUNDS.distanceMeters.decimals),
    };
  });

  return { sets: mapped, unitAssumed, overBound };
}

export function mapPrefillItem(
  item: WorkoutPrefillOutputItem,
  chunkPhotoIds: readonly string[],
  vocab: ExerciseVocabulary,
  profileUnit: WeightUnit,
): WorkoutPrefillDraft {
  const library = item.exerciseSlug === OTHER_EXERCISE_SLUG ? null : resolveLibraryExercise(vocab, item.exerciseSlug);
  const rawText = text(item.rawText);
  const name = library
    ? library.name
    : (text(item.otherName) ?? rawText ?? 'Unidentified exercise').slice(0, WORKOUT_PREFILL_NAME_MAX);

  const { sets, unitAssumed, overBound } = mapSets(item.sets, profileUnit);
  const notes = [text(item.note)];
  if (unitAssumed) notes.push(unitAssumedNote(profileUnit));
  if (overBound) notes.push(WEIGHT_OVER_BOUND_NOTE);
  const note = notes.filter((part): part is string => part !== null).join(' ');

  return {
    kind: WORKOUT_PREFILL_ITEM_KIND,
    confidence: unitAssumed && item.confidence === 'high' ? 'medium' : item.confidence,
    uncertain: item.uncertain || unitAssumed || overBound,
    uncertaintyNote: note === '' ? null : note,
    sourcePhotoIds: sourcePhotoIdsFor(item.sourcePhotoIndexes, chunkPhotoIds),
    value: {
      exerciseSlug: library ? library.slug : null,
      name,
      rawText,
      sets,
    },
  };
}

export function mapPrefillItems(
  items: readonly WorkoutPrefillOutputItem[],
  chunkPhotoIds: readonly string[],
  vocab: ExerciseVocabulary,
  profileUnit: WeightUnit,
): WorkoutPrefillDraft[] {
  return items.map((item) => mapPrefillItem(item, chunkPhotoIds, vocab, profileUnit));
}

const CONFIDENCE_RANK: Record<DraftItemConfidence, number> = { low: 0, medium: 1, high: 2 };

/**
 * The drafts of every chunk in order. Across chunks (never within one), a
 * library exercise with no sets that an earlier chunk already drafted with no
 * sets is the same placard photographed twice: it is merged into the earlier
 * draft (photos united, the higher confidence kept, uncertain only when both
 * were). Everything else stays a separate draft.
 */
export function mergePrefillChunks(chunks: readonly (readonly WorkoutPrefillDraft[])[]): WorkoutPrefillDraft[] {
  const merged: Array<{ chunk: number; draft: WorkoutPrefillDraft }> = [];

  chunks.forEach((drafts, chunk) => {
    for (const draft of drafts) {
      const slug = draft.value.exerciseSlug;
      const target =
        slug !== null && draft.value.sets.length === 0
          ? merged.find(
              (entry) =>
                entry.chunk < chunk && entry.draft.value.exerciseSlug === slug && entry.draft.value.sets.length === 0,
            )
          : undefined;

      if (!target) {
        merged.push({ chunk, draft: { ...draft, sourcePhotoIds: [...draft.sourcePhotoIds] } });
        continue;
      }

      const kept = target.draft;
      for (const id of draft.sourcePhotoIds) {
        if (!kept.sourcePhotoIds.includes(id)) kept.sourcePhotoIds.push(id);
      }
      if (CONFIDENCE_RANK[draft.confidence] > CONFIDENCE_RANK[kept.confidence]) {
        kept.confidence = draft.confidence;
        kept.uncertaintyNote = draft.uncertaintyNote;
      }
      kept.uncertain = kept.uncertain && draft.uncertain;
    }
  });

  return merged.map((entry) => entry.draft);
}
