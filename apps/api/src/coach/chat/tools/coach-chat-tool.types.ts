import type { GoalProgressService } from '../../../activity/goal-progress.service';
import type { HealthProfile } from '../../../health-profile/dto/health-profile.dto';
import type { HealthSummaryReader } from '../../../health-summary/health-summary.reader';
import type { CoachLabsDeps } from './biomarker.tools';
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
// data (no ids, no storage keys, no photo content; free text only where
// the user wrote it for their profile or plan, clipped); the write tools
// (`pause_coach`, `save_commitment`, `set_display_name`) are narrow and
// bounded.
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
  /**
   * `get_profile`'s and `set_display_name`'s sources (#327); absent -> both
   * answer `unavailable`. The name is read from `prisma.user` (names only).
   */
  profile?: CoachProfileToolDeps;
  /** `get_health_summary`'s source (#327): the consent-gated door; absent -> `unavailable`. */
  healthSummary?: Pick<HealthSummaryReader, 'consentOn' | 'forTraining'>;
  /**
   * `list_biomarkers`' source (#327): `BiomarkersService.summary`. Both
   * biomarker tools are also gated on `healthSummary.consentOn`; absent ->
   * `unavailable`.
   */
  labs?: CoachLabsDeps;
}

/**
 * The profile reads and the one profile write (#327). `displayName` is
 * written through `UserSettingsService.patchSettings`, the path
 * `PATCH /api/user-settings` takes (it syncs `users.display_name`).
 */
export interface CoachProfileToolDeps {
  healthProfile: {
    get(userId: string): Promise<Pick<HealthProfile, 'dateOfBirth' | 'sexAtBirth' | 'heightMm' | 'unitSystem' | 'bio'> & { labUnits?: string }>;
  };
  userSettings: {
    getSettings(userId: string): Promise<{ onboarding?: { goal?: string | null } | null }>;
    patchSettings(userId: string, dto: { profile: { displayName: string } }): Promise<unknown>;
  };
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
  /** Set when `set_display_name` saved the profile name this turn (#327). Never the value. */
  displayNameUpdated?: boolean;
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
