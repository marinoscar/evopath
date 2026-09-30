// =============================================================================
// User data reset ("factory reset") — shared constants (issue #202)
// =============================================================================

/** The job type. PERMANENT once rows of it exist. */
export const USER_DATA_RESET_TYPE = 'user.data_reset';

/** `Job.subjectType` of a reset: the user whose data it deletes. */
export const USER_DATA_RESET_SUBJECT_TYPE = 'user';

/** The exact phrase `POST /api/user-data/reset` requires in `confirmation`. */
export const USER_DATA_RESET_CONFIRMATION = 'DELETE MY DATA';

/** Audit actions. The request is recorded by the API, completion by the job. */
export const USER_DATA_RESET_REQUESTED_ACTION = 'user.data_reset.requested';
export const USER_DATA_RESET_COMPLETED_ACTION = 'user.data_reset.completed';
