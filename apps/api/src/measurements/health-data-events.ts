// =============================================================================
// Health data domain events (EventEmitter2), H8 (#192)
// =============================================================================
//
// `health.data.changed` is emitted AFTER a write to a user's health data has
// committed: a measurement entry created, edited or deleted
// (`MeasurementsService`), a check-in saved or removed (`CheckInsService`),
// the health profile saved (`HealthProfileService`), or a health intake (a
// lab report, a body-metric reading) applied (`IntakeService.apply`). The
// payload is the user id and the source, nothing else: no value, no metric.
// EventEmitter2 dispatches synchronously: a listener must return quickly and
// never throw (the health summary's listener only enqueues one debounced
// job). Treat the key as permanent: listeners subscribe by string.
// =============================================================================

export const HEALTH_DATA_CHANGED_EVENT = 'health.data.changed';

export const HEALTH_DATA_CHANGE_SOURCES = ['measurements', 'check_in', 'health_profile', 'intake'] as const;
export type HealthDataChangeSource = (typeof HEALTH_DATA_CHANGE_SOURCES)[number];

export interface HealthDataChangedEvent {
  userId: string;
  source: HealthDataChangeSource;
}

/** The subset of EventEmitter2 an emitter needs (so this file imports no Nest module). */
export interface HealthDataEventSink {
  emit(event: string, payload: HealthDataChangedEvent): boolean;
}

/**
 * Emits `health.data.changed` after a committed write. Never throws: the
 * write already succeeded, and a listener failure must not turn it into an
 * error (EventEmitter2 runs listeners synchronously inside `emit`).
 */
export function emitHealthDataChanged(
  events: HealthDataEventSink | undefined,
  logger: { warn(message: string): void },
  event: HealthDataChangedEvent,
): void {
  try {
    events?.emit(HEALTH_DATA_CHANGED_EVENT, event);
  } catch (error) {
    logger.warn(
      `A ${HEALTH_DATA_CHANGED_EVENT} listener threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
