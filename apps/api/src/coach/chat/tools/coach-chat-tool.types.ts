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
// write tool (`pause_coach`) is narrow and bounded.
// =============================================================================

export interface CoachChatToolDeps {
  prisma: PrismaService;
  signals: TrainingSignalsService;
  today: TrainingTodayService;
  checkIns: CheckInsService;
  /** The ONLY progress-photo surface the coach may read (test/coach/coach-photo-privacy.spec.ts). */
  photos: ProgressPhotoSummaryService;
  /** Now, for the pause (tests pin it). */
  now: () => Date;
}

/** What one turn's write tool did, for the `done` frame and the reply's `data`. */
export interface CoachChatTurnActions {
  /** Set when `pause_coach` succeeded this turn. */
  pausedUntil: Date | null;
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
