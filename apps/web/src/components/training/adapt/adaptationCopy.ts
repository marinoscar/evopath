/**
 * Words for the adaptation's failure codes and apply refusals. Pure: the page,
 * the review and the tests share them.
 */
import { runErrorCopy, type RunErrorContext, type RunErrorCopy } from '../runErrors';
import {
  ADAPTATION_REFUSALS,
  adaptationRefusalOf,
  type AdaptedExercise,
} from '../../../services/trainingAdaptation';
import { formatPrescription, type PrescriptionFields } from '../../../utils/prescription';

const FAILURE_COPY: Record<string, RunErrorCopy> = {
  ADAPTATION_CANNOT_FIT: {
    title: "Can't fit it in",
    body: "These lifts don't fit in the time you have. Try a few more minutes.",
  },
  ADAPTATION_INVALID: {
    title: 'The adjustment did not pass the checks',
    body: 'The workout could not be adjusted inside the safety and equipment rules. Try again, or change what you asked for.',
  },
  ADAPTATION_GYM_NOT_FOUND: { title: 'The gym is gone', body: 'The gym chosen for this workout no longer exists. Choose another gym.' },
  ADAPTATION_STALE: { title: 'Something changed meanwhile', body: 'Your plan or gym changed while the workout was being adjusted. Try again.' },
  ADAPTATION_TIMEOUT: { title: 'It took too long', body: 'The adjustment did not finish in time. Try again.' },
  ADAPTATION_RUN_LOST: { title: 'The adjustment was lost', body: 'The worker running it stopped. Try again.' },
  TRAINING_OUTPUT_TRUNCATED: { title: 'The answer was cut short', body: 'The model stopped before finishing its answer. Try again.' },
};

/** A failed adaptation's code in words. `ADAPTATION_CANNOT_FIT` keeps the server's "try N+10" sentence. */
export function adaptationFailureCopy(
  code: string | null,
  serverMessage: string | null,
  context: RunErrorContext = {},
): RunErrorCopy {
  if (code === 'ADAPTATION_CANNOT_FIT' && serverMessage) {
    return { title: FAILURE_COPY.ADAPTATION_CANNOT_FIT.title, body: serverMessage };
  }
  if (code && FAILURE_COPY[code]) return FAILURE_COPY[code];
  return runErrorCopy(code, context);
}

export type ApplyProblemKind =
  | 'workout_in_progress'
  | 'stale'
  | 'in_progress'
  | 'ai_disabled'
  | 'already_applied'
  | 'no_base'
  | 'not_ready'
  | 'other';

export interface ApplyProblem {
  kind: ApplyProblemKind;
  message: string;
  /** `workout_in_progress`: the workout to resume. `in_progress`: the adaptation to open. */
  id?: string;
}

/** An apply (or discard) refusal, as the review explains it. */
export function applyProblemOf(err: unknown): ApplyProblem {
  const refusal = adaptationRefusalOf(err);
  const idOf = (key: string) => (typeof refusal?.details[key] === 'string' ? (refusal.details[key] as string) : undefined);
  switch (refusal?.reason) {
    case ADAPTATION_REFUSALS.WORKOUT_IN_PROGRESS:
      return {
        kind: 'workout_in_progress',
        message: 'Another workout is in progress. Resume it, or finish it first.',
        id: idOf('workoutId'),
      };
    case ADAPTATION_REFUSALS.STALE:
      return {
        kind: 'stale',
        message: 'Your plan or gym changed since this was made, so it no longer fits. Adjust again to get a fresh version.',
      };
    case ADAPTATION_REFUSALS.IN_PROGRESS:
      return { kind: 'in_progress', message: 'Another adjustment is still running.', id: idOf('adaptationId') };
    case ADAPTATION_REFUSALS.AI_DISABLED:
      return { kind: 'ai_disabled', message: "AI was turned off; the adapted workout can't be started from here." };
    case ADAPTATION_REFUSALS.ALREADY_APPLIED:
      return { kind: 'already_applied', message: 'This adjusted workout was already used.' };
    case ADAPTATION_REFUSALS.NO_BASE:
      return { kind: 'no_base', message: 'There was no planned workout today, so there is no plan to update.' };
    case ADAPTATION_REFUSALS.NOT_READY:
    case ADAPTATION_REFUSALS.NOT_CANCELLABLE:
      return { kind: 'not_ready', message: 'This adjusted workout is no longer available.' };
    default:
      return { kind: 'other', message: refusal?.message || 'Something went wrong. Try again.' };
  }
}

/** "3 × 8–10 @ RPE 7"; a planned cardio row reads "30 min" (#263). */
export function prescription(
  e: Pick<PrescriptionFields, 'sets' | 'repMin' | 'repMax' | 'targetDurationSeconds' | 'targetDistanceMeters'> &
    Pick<AdaptedExercise, 'targetRpe'>,
): string {
  return formatPrescription(e);
}

/** The exercise list as plain text, for "Copy exercises". */
export function exercisesAsText(title: string, exercises: AdaptedExercise[]): string {
  return [title, ...exercises.map((e) => `${e.name}: ${prescription(e)}`)].join('\n');
}
