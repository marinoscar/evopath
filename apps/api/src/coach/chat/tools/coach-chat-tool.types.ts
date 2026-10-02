import type { GoalProgressService } from '../../../activity/goal-progress.service';
import type { MemoryRefs } from '../../../memory/memory-context.service';
import type { MemoryService } from '../../../memory/memory.service';
import type { CheckInsService } from '../../../check-ins/check-ins.service';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { TrainingSignalsService } from '../../../programs/signals/signals.service';
import type { TrainingTodayService } from '../../../programs/today/training-today.service';
import type { ProgressPhotoSummaryService } from '../../../progress-photos/progress-photo-summary.service';

// =============================================================================
// What the coach chat tools are built from (E7.7, #247; spec §2.9, §4.4)
// =============================================================================
//
// Every tool is bound to the AUTHENTICATED user through the tool loop's
// `ctx.userId`: no tool takes a user id argument. Read tools return minimised
// data (no ids, no free text, no storage keys, no photo content); the one
// write tools (`pause_coach`, `save_commitment`) are narrow and bounded.
// =============================================================================

/**
 * Where `save_commitment` writes (E7.12): `CoachSettingsService.update`, the
 * same validated path `PUT /api/coach/settings` takes. Only `why` and
 * `preferredTime`; a field left out is unchanged.
 */
export interface CoachCommitmentWriter {
  update(userId: string, patch: { why?: string; preferredTime?: string }): Promise<unknown>;
}

export interface CoachChatToolDeps {
  prisma: PrismaService;
  signals: TrainingSignalsService;
  today: TrainingTodayService;
  checkIns: CheckInsService;
  /** The ONLY progress-photo surface the coach may read (test/coach/coach-photo-privacy.spec.ts). */
  photos: ProgressPhotoSummaryService;
  /** Now, for the pause (tests pin it). */
  now: () => Date;
  /** `save_commitment`'s writer; absent -> the tool answers `unavailable`. */
  commitments?: CoachCommitmentWriter;
  /** `get_goals`' source (F9); absent -> the tool answers `unavailable`. */
  goals?: Pick<GoalProgressService, 'progressForUser'>;
  /**
   * The memory tools' writer and this turn's ref table (#325). Present only
   * while memory is on for the user: the memory tools are registered then.
   */
  memory?: CoachMemoryToolDeps;
}

export interface CoachMemoryToolDeps {
  service: Pick<MemoryService, 'write' | 'update' | 'softDelete' | 'findBestMatch'>;
  refs: MemoryRefs;
}

/** One memory change a tool made this turn: becomes a `memory` SSE frame (spec §2.9). */
export interface CoachChatMemoryEvent {
  op: 'added' | 'updated' | 'deleted';
  /** The memory's id (for the client's Undo); never sent to the model. */
  memoryId: string;
  content: string;
}

/** What one turn's write tool did, for the `done` frame and the reply's `data`. */
export interface CoachChatTurnActions {
  /** Set when `pause_coach` succeeded this turn. */
  pausedUntil: Date | null;
  /** Set when `save_commitment` saved something this turn (field names only, never values). */
  commitmentSaved?: Array<'why' | 'preferredTime'>;
  /** Memory changes made this turn, drained into `memory` frames as they happen (#325). */
  memoryEvents?: CoachChatMemoryEvent[];
}

/** The answer a tool gives instead of throwing: no raw exception text ever reaches the model or the user. */
export interface CoachToolUnavailable {
  error: 'unavailable';
  message: string;
}

export const TOOL_UNAVAILABLE: CoachToolUnavailable = {
  error: 'unavailable',
  message: 'This data could not be loaded right now. Tell the user you could not check it, without guessing.',
};
