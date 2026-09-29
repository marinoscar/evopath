// =============================================================================
// The one "active row" predicate for `measurements` (E2.2, #50)
// =============================================================================
//
// An edit inserts superseding rows and stamps `supersededAt` on the old ones; a
// delete stamps `deletedAt`. A row is ACTIVE when neither is set. Every read of
// user-visible measurements spreads this next to the owner filter:
//
//   where: { userId, ...ACTIVE, ... }
//
// Review checklist: no read of `measurements` without it. It is a query
// predicate on purpose, NOT a raw-SQL partial index — the repository already
// carries two intentional raw-SQL index drifts and does not want a third.
// =============================================================================

export const ACTIVE = { supersededAt: null, deletedAt: null } as const;
