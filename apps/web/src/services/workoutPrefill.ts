/**
 * "Prefill from photo" (E4.5): the `workout_prefill` photo-intake kind, as
 * the web app sees it.
 *
 * The prefill is an ordinary photo intake (`services/intake.ts`): the photos
 * go to `/api/intakes`, a server-only `ai.workout.prefill` job drafts one
 * item per exercise line it reads (with the written sets, in kilograms), the
 * user reviews the draft, and `POST /intakes/:id/apply` appends the accepted
 * exercises to the workout with every set UNCOMPLETED. Nothing here decides
 * anything: the API validates each value against the kind's schema, resolves
 * or creates the exercise, enforces ownership of the workout and the
 * 30-exercise cap.
 *
 * The value type mirrors the kind's `valueSchema`
 * (`apps/api/src/workouts/intake/workout-prefill.value.ts`).
 */
import { createIntake, listIntakes, type PhotoIntakeView } from './intake';
import type { WeightUnit } from '../utils/units';
import { distanceInputText, distanceUnitFor, formatClock, weightInputText } from '../utils/workoutFormat';

/** The registered intake kind (permanent once rows exist). */
export const WORKOUT_PREFILL_INTAKE_KIND = 'workout_prefill';
/** The draft-item kind inside it. */
export const EXERCISE_DRAFT_ITEM_KIND = 'exercise';
/** `PhotoIntake.subjectType` for a prefill of one workout. */
export const WORKOUT_PREFILL_SUBJECT_TYPE = 'workout';
/** Photos one prefill may hold (the kind's `maxPhotos`). */
export const WORKOUT_PREFILL_MAX_PHOTOS = 32;
/** Sets one draft item may hold. */
export const EXERCISE_DRAFT_SETS_MAX = 12;
export const EXERCISE_DRAFT_NAME_MAX = 80;

/** What the photo shows, as the user says it (a hint to the model, never a fact). */
export const WORKOUT_PREFILL_SOURCE_HINTS = ['machine_placard', 'notebook', 'whiteboard'] as const;
export type WorkoutPrefillSourceHint = (typeof WORKOUT_PREFILL_SOURCE_HINTS)[number];
/** The selector's value; `unsure` omits `sourceHint`. */
export type WorkoutPrefillSource = WorkoutPrefillSourceHint | 'unsure';

export const SOURCE_LABEL: Record<WorkoutPrefillSource, string> = {
  machine_placard: 'Machine placard',
  notebook: 'Notebook',
  whiteboard: 'Whiteboard',
  unsure: 'Not sure',
};
export const SOURCE_OPTIONS: WorkoutPrefillSource[] = ['machine_placard', 'notebook', 'whiteboard', 'unsure'];

/** One written set, in the API's canonical units. */
export interface ExerciseDraftSet {
  reps: number | null;
  weightKg: number | null;
  durationSeconds: number | null;
  distanceMeters: number | null;
}

/** One draft item's value (the kind's `valueSchema`). */
export interface ExerciseDraftValue {
  /** A library slug, one of the caller's custom exercise slugs, or `null` for a new custom exercise. */
  exerciseSlug: string | null;
  /** 1..80; a slug's value takes the exercise's name on the server. */
  name: string;
  /** The line as the model transcribed it. */
  rawText: string | null;
  /** 0..12 sets. */
  sets: ExerciseDraftSet[];
}

export const EMPTY_SET: ExerciseDraftSet = Object.freeze({
  reps: null,
  weightKg: null,
  durationSeconds: null,
  distanceMeters: null,
}) as ExerciseDraftSet;

/** The starting value for "Add missing item". */
export const EMPTY_EXERCISE_DRAFT_VALUE: ExerciseDraftValue = Object.freeze({
  exerciseSlug: null,
  name: '',
  rawText: null,
  sets: [],
}) as ExerciseDraftValue;

/** The prefill's `PhotoIntake.context`. */
export interface WorkoutPrefillContext {
  workoutId: string;
  sourceHint?: WorkoutPrefillSourceHint;
}

export interface WorkoutPrefillFailedChunk {
  index: number;
  code: string;
  firstPhotoIndex?: number;
  lastPhotoIndex?: number;
}

/** What the prefill job records in `resultMeta`. Every field is optional on read. */
export interface WorkoutPrefillResultMeta {
  photoCount?: number;
  sourceKind?: string | null;
  /** A title the model read, such as "Push day"; offered as the workout name on click only. */
  suggestedName: string | null;
  ignoredNotes: string[];
  assumedWeightUnit?: WeightUnit;
  failedChunks: WorkoutPrefillFailedChunk[];
}

/** `POST /intakes/:id/apply` for this kind. */
export interface WorkoutPrefillApplyResult {
  workoutId: string;
  exercisesAdded: number;
  setsAdded: number;
  /** Accepted items not added because the workout reached its 30-exercise cap. */
  skipped: number;
  photosAttached: number;
}

/** Navigation state the prefill page hands to the workout page. */
export interface WorkoutLocationState {
  /** A one-off message shown as a snackbar (the apply summary). */
  snack?: string;
  /** Open the exercise picker ("Continue manually"). */
  openPicker?: boolean;
}

export type WorkoutPrefillIntake = PhotoIntakeView<ExerciseDraftValue, WorkoutPrefillContext>;

/** The source selector's value for a stored context. */
export function sourceOf(context: WorkoutPrefillContext | null | undefined): WorkoutPrefillSource {
  const hint = context?.sourceHint;
  return hint && (WORKOUT_PREFILL_SOURCE_HINTS as readonly string[]).includes(hint) ? hint : 'unsure';
}

/** The context for a selector value (the whole object: a PATCH replaces it). */
export function contextFor(workoutId: string, source: WorkoutPrefillSource): WorkoutPrefillContext {
  return source === 'unsure' ? { workoutId } : { workoutId, sourceHint: source };
}

/** Read `resultMeta` defensively: it is JSON the job wrote, not a typed column. */
export function prefillResultMeta(intake: Pick<PhotoIntakeView, 'resultMeta'> | null): WorkoutPrefillResultMeta {
  const meta = intake?.resultMeta;
  if (!meta || typeof meta !== 'object') return { suggestedName: null, ignoredNotes: [], failedChunks: [] };
  const raw = meta as Record<string, unknown>;
  const suggested = typeof raw.suggestedName === 'string' && raw.suggestedName.trim() !== '' ? raw.suggestedName.trim() : null;
  return {
    photoCount: typeof raw.photoCount === 'number' ? raw.photoCount : undefined,
    sourceKind: typeof raw.sourceKind === 'string' ? raw.sourceKind : null,
    suggestedName: suggested,
    ignoredNotes: Array.isArray(raw.ignoredNotes)
      ? raw.ignoredNotes.filter((entry): entry is string => typeof entry === 'string')
      : [],
    assumedWeightUnit: raw.assumedWeightUnit === 'lb' || raw.assumedWeightUnit === 'kg' ? raw.assumedWeightUnit : undefined,
    failedChunks: Array.isArray(raw.failedChunks)
      ? raw.failedChunks.filter(
          (entry): entry is WorkoutPrefillFailedChunk =>
            typeof entry === 'object' && entry !== null && typeof (entry as { index?: unknown }).index === 'number',
        )
      : [],
  };
}

/**
 * The newest unfinished prefill of this workout (`draft`, `scanning` or
 * `ready`), or a new one. Resuming keeps a reload or a slow job from losing
 * the review.
 */
export async function startOrResumeWorkoutPrefill(workoutId: string): Promise<string> {
  const open = await listIntakes({
    kind: WORKOUT_PREFILL_INTAKE_KIND,
    subjectId: workoutId,
    status: ['draft', 'scanning', 'ready'],
    limit: 1,
  });
  if (open.length > 0) return open[0].id;
  const created = await createIntake<WorkoutPrefillContext>({
    kind: WORKOUT_PREFILL_INTAKE_KIND,
    context: { workoutId },
  });
  return created.id;
}

/** "3 exercises added. Sets are not marked done; check them off as you train." */
export function prefillApplySummary(result: Pick<WorkoutPrefillApplyResult, 'exercisesAdded' | 'skipped'>): string {
  const n = result.exercisesAdded;
  let text =
    n === 0
      ? 'No exercises added.'
      : `${n} ${n === 1 ? 'exercise' : 'exercises'} added. Sets are not marked done; check them off as you train.`;
  if (result.skipped > 0) {
    text += ` ${result.skipped} not added: a workout holds at most 30 exercises.`;
  }
  return text;
}

/** One set's non-weight part: "10", "1:00", "0.4 km". */
function setTail(set: ExerciseDraftSet, unit: WeightUnit): string | null {
  const parts: string[] = [];
  if (set.distanceMeters !== null) parts.push(`${distanceInputText(set.distanceMeters, distanceUnitFor(unit))} ${distanceUnitFor(unit)}`);
  if (set.durationSeconds !== null) parts.push(formatClock(set.durationSeconds));
  return parts.length > 0 ? parts.join(' in ') : null;
}

/**
 * The sets as one line in the user's display unit: consecutive sets of the
 * same weight share it, `135 lb × 10, 10, 8`; a time set reads `1:00`, a
 * distance `0.4 km`. No sets reads as an empty string.
 */
export function formatDraftSets(sets: readonly ExerciseDraftSet[], unit: WeightUnit): string {
  const segments: string[] = [];
  let i = 0;
  while (i < sets.length) {
    const set = sets[i];
    const tail = setTail(set, unit);
    if (tail !== null) {
      const weightPart = set.weightKg !== null ? `${weightInputText(set.weightKg, unit)} ${unit}, ` : '';
      const repsPart = set.reps !== null ? ` × ${set.reps}` : '';
      segments.push(`${weightPart}${tail}${repsPart}`);
      i += 1;
      continue;
    }
    // Group a run of weight/reps sets that share the same weight.
    const weight = set.weightKg;
    const reps: string[] = [];
    while (i < sets.length && sets[i].weightKg === weight && setTail(sets[i], unit) === null) {
      reps.push(sets[i].reps !== null ? String(sets[i].reps) : '?');
      i += 1;
    }
    if (weight === null) {
      segments.push(`${reps.join(', ')} ${reps.length === 1 && reps[0] === '1' ? 'rep' : 'reps'}`);
    } else {
      segments.push(`${weightInputText(weight, unit)} ${unit} × ${reps.join(', ')}`);
    }
  }
  return segments.join('; ');
}
