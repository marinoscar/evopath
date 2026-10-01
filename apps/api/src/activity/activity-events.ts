// =============================================================================
// Activity domain events (EventEmitter2; #269)
// =============================================================================
//
// `activity.entry.recorded` is emitted by `ActivityEntriesService` AFTER a
// manual check-in was written: `create` once its row exists, `batch` once its
// transaction committed and wrote at least one row. An edit or a delete emits
// nothing. The payload is ids and an instant only; the AI Coach listens to
// plan `goal_hit` (`coach/planning/coach-events.listener.ts`).
// EventEmitter2 dispatches synchronously: a listener must return quickly and
// never throw. Treat the key as permanent: listeners subscribe by string.
// =============================================================================

export const ACTIVITY_ENTRY_RECORDED_EVENT = 'activity.entry.recorded';

export interface ActivityEntryRecordedEvent {
  userId: string;
  /**
   * ISO instant read just BEFORE the write: every manual entry created or
   * updated at or after it (allowing for clock skew) came from this check-in.
   */
  recordedSince: string;
}
