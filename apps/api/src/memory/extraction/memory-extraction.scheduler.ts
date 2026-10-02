import { Injectable, Logger } from '@nestjs/common';

import { JobsService } from '../../jobs/jobs.service';
import {
  AI_MEMORY_EXTRACT_JOB_TYPE,
  MEMORY_EXTRACT_DELAY_MS,
  MEMORY_USER_SUBJECT_TYPE,
} from '../memory-job-types';
import { MemoryService } from '../memory.service';

// =============================================================================
// MemoryExtractionScheduler: queues `ai.memory.extract` after a chat turn
// =============================================================================
//
// Called by the coach chat once a model turn's reply is stored. Enqueues one
// `ai.memory.extract` job for the user, `MEMORY_EXTRACT_DELAY_MS` (5 min)
// out, deduplicated on (`user`, userId): while one is pending, every later
// turn collapses onto it (the active-dedup index), so one run reads the whole
// burst of a conversation. Skipped when the user's extraction is off.
//
// NEVER THROWS: a chat turn must not fail because its follow-up could not be
// queued. A missed enqueue costs nothing durable: the next turn's job reads
// every message since the watermark.
// =============================================================================

@Injectable()
export class MemoryExtractionScheduler {
  private readonly logger = new Logger(MemoryExtractionScheduler.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly memories: MemoryService,
  ) {}

  async afterChatTurn(userId: string, now: Date = new Date()): Promise<boolean> {
    try {
      const gate = await this.memories.gate(userId);
      if (!gate.autoExtract) return false;
      await this.jobs.enqueue({
        type: AI_MEMORY_EXTRACT_JOB_TYPE,
        reason: 'backfill',
        subjectType: MEMORY_USER_SUBJECT_TYPE,
        subjectId: userId,
        payload: { userId },
        scheduledFor: new Date(now.getTime() + MEMORY_EXTRACT_DELAY_MS),
      });
      return true;
    } catch {
      this.logger.warn(`Could not queue memory extraction for user ${userId}`);
      return false;
    }
  }
}
