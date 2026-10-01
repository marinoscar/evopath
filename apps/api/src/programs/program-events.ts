// =============================================================================
// Program domain events (EventEmitter2)
// =============================================================================
//
// `program.activated` is emitted by `ProgramsService.activate` AFTER its
// transaction committed, once per successful activation (a re-activation of a
// paused program emits again; listeners dedupe on the program id). The payload
// is ids only. EventEmitter2 dispatches synchronously: a listener must return
// quickly and never throw (the coach's kickoff listener only enqueues).
// Treat the key as permanent: listeners subscribe by string.
// =============================================================================

export const PROGRAM_ACTIVATED_EVENT = 'program.activated';

export interface ProgramActivatedEvent {
  userId: string;
  programId: string;
}
