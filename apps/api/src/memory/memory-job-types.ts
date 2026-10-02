// =============================================================================
// User memory job types (#325). PERMANENT strings: rows outlive handlers.
// =============================================================================

/** Learns durable facts from one user's recent coach chat messages. Server-only (an `ai.*` type). */
export const AI_MEMORY_EXTRACT_JOB_TYPE = 'ai.memory.extract';

/** Daily: hard-deletes deleted and superseded memories past `memory.purgeAfterDays`. Server-only. */
export const MEMORY_PURGE_JOB_TYPE = 'memory.purge';

/** The extraction job's subject: one per user, so pending runs collapse (debounce). */
export const MEMORY_USER_SUBJECT_TYPE = 'user';

/** How long after a chat turn the extraction runs; later turns inside it collapse onto the pending job. */
export const MEMORY_EXTRACT_DELAY_MS = 5 * 60 * 1000;
