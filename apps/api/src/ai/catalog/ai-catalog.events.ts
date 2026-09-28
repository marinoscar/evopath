// =============================================================================
// AI catalog events — the exported hook other AI stories extend the catalog
// refresh through (issue #431, epic #419)
// =============================================================================
//
// `AiCatalogRefreshHandler` emits AI_CATALOG_SYNCED_EVENT after every sync
// that actually ran (never for a skipped one). The catalog knows nothing about
// who listens: #431's key-reachability recheck subscribes to it, so the
// catalog module never imports the keys module and the handler grows no
// per-consumer logic.
//
// ⚠ `EventEmitter2` DISPATCHES SYNCHRONOUSLY, inside the job's `process()`.
// A listener must return at once and never throw; anything that takes time —
// a provider round trip, a sweep — belongs on the queue, enqueued from the
// listener (CLAUDE.md, "Every Long-Running Activity Is a Queue Job", rule 1).
// =============================================================================

export const AI_CATALOG_SYNCED_EVENT = 'ai.catalog.synced';

export interface AiCatalogSyncedEvent {
  providerId: string;
  /** Models seen for the first time by this sync. */
  added: number;
  updated: number;
  deprecated: number;
  /** The `ai.catalog.refresh` job that ran the sync. */
  jobId: string;
}
