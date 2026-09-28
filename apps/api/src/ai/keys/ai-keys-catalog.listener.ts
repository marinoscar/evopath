// =============================================================================
// Catalog sync -> key recheck (issue #431, epic #419)
// =============================================================================
//
// A user's `reachableModelIds` holds only ids that were in `ai_models` when the
// key was checked, so a model the catalog discovers LATER is invisible to every
// existing key until that key is re-checked. This listener subscribes to the
// catalog's exported hook (`AI_CATALOG_SYNCED_EVENT`) and, when a sync ADDED
// models, queues `ai.keys.recheck` for the provider; the handler's
// `staleCutoff` then treats every key checked before the newest discovery as
// stale.
//
// ENQUEUE ONLY, DETACHED, NEVER THROWS. `EventEmitter2` dispatches inside the
// catalog job's `process()`, so this returns at once; the provider round trips
// happen on the queue (CLAUDE.md, "Every Long-Running Activity Is a Queue
// Job", rule 1). A recheck already pending for the provider is reused by the
// queue's type + subject dedup.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { JobsService } from '../../jobs/jobs.service';
import { AI_CATALOG_SYNCED_EVENT, type AiCatalogSyncedEvent } from '../catalog/ai-catalog.events';
import { AI_CATALOG_SUBJECT_TYPE } from '../catalog/ai-catalog.service';
import { AI_KEYS_RECHECK_PRIORITY } from './ai-keys-recheck.task';
import { AI_KEYS_RECHECK_TYPE } from './ai-user-key.constants';

@Injectable()
export class AiKeysCatalogListener {
  private readonly logger = new Logger(AiKeysCatalogListener.name);

  constructor(private readonly jobs: JobsService) {}

  @OnEvent(AI_CATALOG_SYNCED_EVENT)
  handleCatalogSynced(event: AiCatalogSyncedEvent): void {
    try {
      if (event.added <= 0) return;

      const provider = event.providerId;

      void this.jobs
        .enqueue({
          type: AI_KEYS_RECHECK_TYPE,
          reason: 'backfill',
          subjectType: AI_CATALOG_SUBJECT_TYPE,
          subjectId: provider,
          payload: { provider },
          priority: AI_KEYS_RECHECK_PRIORITY,
        })
        .then((job) => {
          this.logger.log(
            `Catalog sync added ${event.added} model(s) for "${provider}"; queued key recheck ${job.id}`,
          );
        })
        .catch((error: unknown) => {
          this.logger.error(
            `Could not queue the AI key recheck for "${provider}" after a catalog sync: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        });
    } catch (error) {
      this.logger.error(
        `AI catalog listener failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
