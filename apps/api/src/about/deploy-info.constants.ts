/**
 * The three deploy-document statuses, as a tuple `z.enum` can consume.
 *
 * Lives beside `deploy-info.ts` rather than inside it so the response DTO can
 * import it without pulling `fs/promises` into a module that only describes a
 * shape.
 */
export const DEPLOY_INFO_STATUSES = ['ok', 'absent', 'invalid'] as const;
