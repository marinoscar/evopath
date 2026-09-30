import { TRAINING_REASONS } from './training-runs.constants';

/**
 * Thrown by a node that must stop the run for safety (an urgent symptom
 * found mid-run). The handler records the run `blocked_safety` with `code`;
 * the job returns normally. Carries no user text.
 */
export class TrainingSafetyStopError extends Error {
  constructor(readonly code: string = TRAINING_REASONS.SAFETY_STOP) {
    super('The training run was stopped for safety.');
    this.name = 'TrainingSafetyStopError';
  }
}

/** Why the handler aborted a run's signal. */
export type TrainingRunAbortReason = 'cancel' | 'deadline' | 'shutdown';

/** The reason a run's `AbortController` is aborted with. */
export class TrainingRunAbort extends Error {
  constructor(readonly why: TrainingRunAbortReason) {
    super(
      why === 'cancel'
        ? 'Training run cancelled'
        : why === 'deadline'
          ? 'Training run reached its deadline'
          : 'Training run stopped by a shutdown',
    );
    this.name = 'TrainingRunAbort';
  }
}
