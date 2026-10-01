import { BadRequestException, ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import type { ActivityEntry, ActivityGoal } from '@prisma/client';

import { fromDbDate } from '../check-ins/local-date';
import { ACTIVITY_REASONS } from './activity.constants';
import type { ActivityEntryViewData, GoalViewData } from './dto/goal.dto';
import type { ProgressEntry, ProgressGoal } from './goal-progress';

export function toGoalView(goal: ActivityGoal): GoalViewData {
  return {
    id: goal.id,
    title: goal.title,
    activityKind: goal.activityKind as GoalViewData['activityKind'],
    customLabel: goal.customLabel,
    metric: goal.metric,
    target: goal.target,
    period: goal.period,
    status: goal.status,
    startsOn: fromDbDate(goal.startsOn),
    version: goal.version,
    createdAt: goal.createdAt.toISOString(),
    updatedAt: goal.updatedAt.toISOString(),
  };
}

export function toProgressGoal(goal: ActivityGoal): ProgressGoal {
  return {
    id: goal.id,
    activityKind: goal.activityKind as ProgressGoal['activityKind'],
    metric: goal.metric,
    target: goal.target,
    period: goal.period,
    startsOn: fromDbDate(goal.startsOn),
  };
}

export function toEntryView(entry: ActivityEntry): ActivityEntryViewData {
  return {
    id: entry.id,
    occurredOn: fromDbDate(entry.occurredOn),
    occurredAt: entry.occurredAt?.toISOString() ?? null,
    activityKind: entry.activityKind,
    completed: entry.completed,
    durationSeconds: entry.durationSeconds,
    steps: entry.steps,
    distanceMeters: entry.distanceMeters === null ? null : Number(entry.distanceMeters),
    source: entry.source,
    workoutId: entry.workoutId,
    provider: entry.provider,
    note: entry.note,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

/** The entry view also serves as the progress rule's input (it carries every field the rules read). */
export type ProgressEntryView = ActivityEntryViewData & ProgressEntry;

export function toProgressEntryView(entry: ActivityEntry): ProgressEntryView {
  return toEntryView(entry);
}

export function goalNotFound(): NotFoundException {
  return new NotFoundException('Goal not found');
}

export function entryNotFound(): NotFoundException {
  return new NotFoundException('Activity entry not found');
}

/** A refusal with `details.reason` (and any extra details). */
export function activityRefusal(
  status: 400 | 409 | 412 | 428,
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
): HttpException {
  const body = { message, details: { reason, ...extra } };
  if (status === 400) return new BadRequestException(body);
  if (status === 409) return new ConflictException(body);
  return new HttpException(body, status);
}

export const goalLimitReached = (max: number) =>
  activityRefusal(409, ACTIVITY_REASONS.GOAL_LIMIT_REACHED, `You can have at most ${max} active goals`, { max });
