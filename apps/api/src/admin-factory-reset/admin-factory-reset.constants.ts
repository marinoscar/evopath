// =============================================================================
// Admin factory reset — shared constants (issue #211)
// =============================================================================

/** The job type. PERMANENT once rows of it exist. */
export const ADMIN_FACTORY_RESET_TYPE = 'admin.factory_reset';

/** The exact phrase `POST /api/admin/factory-reset` requires in `confirmation`. */
export const ADMIN_FACTORY_RESET_CONFIRMATION = 'FACTORY RESET';

/** Audit actions. The request is recorded by the API, completion by the job. */
export const ADMIN_FACTORY_RESET_REQUESTED_ACTION = 'admin.factory_reset.requested';
export const ADMIN_FACTORY_RESET_COMPLETED_ACTION = 'admin.factory_reset.completed';
