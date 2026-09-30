/** Words for the plan vocabulary the API speaks in codes. Presentation only. */
import type { ChipProps } from '@mui/material';
import type { ChangeKind, ChangeStatus, ProgramGoal, ProgramStatus, VersionOrigin } from '../../services/programs';
import type { TrainingExperience, TrainingLimitationArea } from '../../services/trainingAgents';

export const GOAL_LABEL: Record<ProgramGoal, string> = {
  strength: 'Strength',
  hypertrophy: 'Build muscle',
  fat_loss: 'Fat loss',
  general: 'General fitness',
  endurance: 'Endurance',
  custom: 'Custom',
};

export const STATUS_LABEL: Record<ProgramStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  paused: 'Paused',
  archived: 'Archived',
  completed: 'Completed',
};

export const STATUS_COLOR: Record<ProgramStatus, ChipProps['color']> = {
  draft: 'default',
  active: 'success',
  paused: 'warning',
  archived: 'default',
  completed: 'info',
};

export const EXPERIENCE_LABEL: Record<TrainingExperience, { label: string; description: string }> = {
  beginner: { label: 'Beginner', description: 'Less than a year of regular training, or returning after a long break.' },
  intermediate: { label: 'Intermediate', description: 'One to three years of consistent training; you know the main lifts.' },
  advanced: { label: 'Advanced', description: 'Several years of structured training; progress now takes planning.' },
};

export const LIMITATION_LABEL: Record<TrainingLimitationArea, string> = {
  shoulder: 'Shoulder',
  elbow: 'Elbow',
  wrist: 'Wrist',
  back: 'Back',
  hip: 'Hip',
  knee: 'Knee',
  ankle: 'Ankle',
  neck: 'Neck',
  other: 'Other',
};

export const ORIGIN_LABEL: Record<VersionOrigin, string> = {
  initial: 'Created',
  ai_create: 'Created by the planner',
  ai_adapt: 'Adjusted by the coach',
  manual_edit: 'Edited by you',
  revert: 'Restored',
  duplicate: 'Duplicated',
};

export const CHANGE_KIND_LABEL: Record<ChangeKind, string> = {
  created: 'Created',
  adapted: 'Adjusted',
  edited: 'Edited',
  reverted: 'Restored',
};

export const CHANGE_STATUS_LABEL: Record<ChangeStatus, string> = {
  applied: 'Applied',
  proposed: 'Proposed',
  rejected: 'Rejected',
  reverted: 'Undone',
  superseded: 'Superseded',
  expired: 'Expired',
};

export const WEEKDAYS: Array<{ day: number; short: string; long: string }> = [
  { day: 1, short: 'Mon', long: 'Monday' },
  { day: 2, short: 'Tue', long: 'Tuesday' },
  { day: 3, short: 'Wed', long: 'Wednesday' },
  { day: 4, short: 'Thu', long: 'Thursday' },
  { day: 5, short: 'Fri', long: 'Friday' },
  { day: 6, short: 'Sat', long: 'Saturday' },
  { day: 7, short: 'Sun', long: 'Sunday' },
];

/** Machine warning codes from `plan.finalized` and the version meta, in words. */
export const RUN_WARNING_LABEL: Record<string, string> = {
  critic_open_notes: 'The critic still had notes when its rounds ran out.',
  critic_skipped_budget: 'The token budget ran out before the critic could review the final draft.',
  critic_unavailable: 'The critic could not review this plan; it passed the safety checks.',
};

export function warningText(code: string): string {
  return RUN_WARNING_LABEL[code] ?? code.replace(/_/g, ' ');
}
