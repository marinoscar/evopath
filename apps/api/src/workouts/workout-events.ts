// =============================================================================
// Workout domain events (EventEmitter2)
// =============================================================================
//
// `workout.finished` is emitted by `WorkoutsService.finish` AFTER its
// transaction committed, and only when the call moved the workout to
// `completed` (a repeated finish emits nothing). The payload is ids only.
// EventEmitter2 dispatches synchronously: a listener must return quickly and
// never throw (the plan evaluator's listener only asks its scheduler).
// Treat the key as permanent: listeners subscribe by string.
// =============================================================================

export const WORKOUT_FINISHED_EVENT = 'workout.finished';

export interface WorkoutFinishedEvent {
  userId: string;
  workoutId: string;
}
