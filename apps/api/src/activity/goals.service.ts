import { Injectable } from '@nestjs/common';
import type { ActivityGoal, Prisma } from '@prisma/client';

import { CheckInsService } from '../check-ins/check-ins.service';
import { addDays, fromDbDate, toDbDate } from '../check-ins/local-date';
import { PrismaService } from '../prisma/prisma.service';
import {
  ACTIVITY_REASONS,
  GOAL_STARTS_ON_WINDOW_DAYS,
  GOAL_TEMPLATES,
  GOAL_TRANSITIONS,
  MAX_ACTIVE_GOALS,
  type GoalStatusValue,
  type GoalTemplateData,
  type GoalTransition,
} from './activity.constants';
import { activityRefusal, goalLimitReached, goalNotFound, toGoalView } from './activity-mapper';
import type { CreateGoalInput, GoalViewData, UpdateGoalInput } from './dto/goal.dto';

// =============================================================================
// GoalsService — activity goals CRUD and status transitions (#266)
// =============================================================================
//
// Owner-scoped: another user's goal is a 404, never a 403.
//
// ACTIVE CAP. At most MAX_ACTIVE_GOALS active goals per user, checked on
// create and resume inside a transaction that first locks the user's row
// (`SELECT ... FOR UPDATE`), so two concurrent creates cannot both pass the
// count. Paused and archived goals do not count.
//
// CONCURRENCY. PATCH requires `If-Match: <version>`: missing -> 428
// IF_MATCH_REQUIRED, stale -> 412 GOAL_VERSION_MISMATCH (with
// `currentVersion`). The write itself is conditional on the version, so a
// concurrent edit between the read and the write is a 412 too. Every write
// (edit or transition) bumps `version`.
// =============================================================================

/** A goal's cross-field rules, applied to the MERGED goal. */
function assertGoalShape(goal: {
  activityKind: string;
  customLabel: string | null;
  metric: string;
  period: string;
}): void {
  if (goal.metric === 'sessions' && goal.period !== 'week') {
    throw activityRefusal(400, ACTIVITY_REASONS.INVALID_GOAL, 'A sessions goal counts per week: use period `week`', {
      path: 'period',
    });
  }
  if (goal.activityKind === 'custom' && !goal.customLabel) {
    throw activityRefusal(400, ACTIVITY_REASONS.INVALID_GOAL, 'A custom goal needs a customLabel', {
      path: 'customLabel',
    });
  }
}

/** The version an `If-Match` header names (bare `4`, `"4"` or `W/"4"`), else 428. */
export function requireGoalIfMatch(header: string | undefined): number {
  const value = header?.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1').trim();
  if (value && /^\d{1,9}$/.test(value)) {
    const version = Number(value);
    if (version >= 1) return version;
  }
  throw activityRefusal(428, ACTIVITY_REASONS.IF_MATCH_REQUIRED, 'Send If-Match with the goal version you loaded');
}

export function goalEtag(version: number): string {
  return `"${version}"`;
}

const staleGoal = (currentVersion: number) =>
  activityRefusal(412, ACTIVITY_REASONS.GOAL_VERSION_MISMATCH, 'The goal changed since you loaded it; reload and retry', {
    currentVersion,
  });

@Injectable()
export class GoalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly checkIns: CheckInsService,
  ) {}

  templates(): readonly GoalTemplateData[] {
    return GOAL_TEMPLATES;
  }

  async list(userId: string, status: GoalStatusValue = 'active'): Promise<GoalViewData[]> {
    const goals = await this.prisma.activityGoal.findMany({
      where: { userId, status },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return goals.map(toGoalView);
  }

  async get(userId: string, goalId: string): Promise<GoalViewData> {
    return toGoalView(await this.findOwned(userId, goalId));
  }

  async create(userId: string, input: CreateGoalInput, now: Date = new Date()): Promise<GoalViewData> {
    const customLabel = input.activityKind === 'custom' ? (input.customLabel ?? null) : null;
    assertGoalShape({ ...input, customLabel });
    const startsOn = await this.resolveStartsOn(userId, input.startsOn, now);

    const goal = await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      await assertBelowCap(tx, userId);
      return tx.activityGoal.create({
        data: {
          userId,
          title: input.title,
          activityKind: input.activityKind,
          customLabel,
          metric: input.metric,
          target: input.target,
          period: input.period,
          startsOn: toDbDate(startsOn),
        },
      });
    });

    return toGoalView(goal);
  }

  async update(
    userId: string,
    goalId: string,
    expectedVersion: number,
    input: UpdateGoalInput,
    now: Date = new Date(),
  ): Promise<GoalViewData> {
    const goal = await this.findOwned(userId, goalId);

    if (goal.status === 'archived') {
      throw activityRefusal(409, ACTIVITY_REASONS.GOAL_ARCHIVED, 'An archived goal cannot be edited');
    }
    if (goal.version !== expectedVersion) throw staleGoal(goal.version);

    const activityKind = input.activityKind ?? goal.activityKind;
    const merged = {
      activityKind,
      customLabel: activityKind === 'custom' ? (input.customLabel !== undefined ? input.customLabel : goal.customLabel) : null,
      metric: input.metric ?? goal.metric,
      period: input.period ?? goal.period,
    };
    assertGoalShape(merged);

    const data: Prisma.ActivityGoalUpdateManyMutationInput = {
      customLabel: merged.customLabel,
      version: { increment: 1 },
    };
    if (input.title !== undefined) data.title = input.title;
    if (input.activityKind !== undefined) data.activityKind = input.activityKind;
    if (input.metric !== undefined) data.metric = input.metric;
    if (input.target !== undefined) data.target = input.target;
    if (input.period !== undefined) data.period = input.period;
    if (input.startsOn !== undefined && input.startsOn !== fromDbDate(goal.startsOn)) {
      data.startsOn = toDbDate(await this.resolveStartsOn(userId, input.startsOn, now));
    }

    const { count } = await this.prisma.activityGoal.updateMany({
      where: { id: goalId, userId, version: expectedVersion },
      data,
    });
    if (count === 0) {
      const current = await this.prisma.activityGoal.findFirst({ where: { id: goalId, userId }, select: { version: true } });
      if (!current) throw goalNotFound();
      throw staleGoal(current.version);
    }

    return this.get(userId, goalId);
  }

  /** pause | resume | archive. Asking for the state the goal is already in is a no-op. */
  async transition(userId: string, goalId: string, action: GoalTransition): Promise<GoalViewData> {
    const rule = GOAL_TRANSITIONS[action];

    const goal = await this.prisma.$transaction(async (tx) => {
      if (rule.to === 'active') await lockUser(tx, userId);
      const current = await tx.activityGoal.findFirst({ where: { id: goalId, userId } });
      if (!current) throw goalNotFound();
      if (current.status === rule.to) return current;
      if (!rule.from.includes(current.status)) {
        throw activityRefusal(409, ACTIVITY_REASONS.ILLEGAL_TRANSITION, `A ${current.status} goal cannot be ${action}d`, {
          status: current.status,
        });
      }
      if (rule.to === 'active') await assertBelowCap(tx, userId);
      return tx.activityGoal.update({ where: { id: goalId }, data: { status: rule.to, version: { increment: 1 } } });
    });

    return toGoalView(goal);
  }

  private async findOwned(userId: string, goalId: string): Promise<ActivityGoal> {
    const goal = await this.prisma.activityGoal.findFirst({ where: { id: goalId, userId } });
    if (!goal) throw goalNotFound();
    return goal;
  }

  private async resolveStartsOn(userId: string, startsOn: string | undefined, now: Date): Promise<string> {
    const today = await this.checkIns.today(userId, now);
    if (startsOn === undefined) return today;
    if (startsOn < addDays(today, -GOAL_STARTS_ON_WINDOW_DAYS) || startsOn > addDays(today, GOAL_STARTS_ON_WINDOW_DAYS)) {
      throw activityRefusal(
        400,
        ACTIVITY_REASONS.START_DATE_OUT_OF_RANGE,
        `startsOn must be within ${GOAL_STARTS_ON_WINDOW_DAYS} days of today (${today})`,
        { path: 'startsOn', today },
      );
    }
    return startsOn;
  }
}

/** Serialises a user's cap-checked writes. */
async function lockUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE`;
}

async function assertBelowCap(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  const active = await tx.activityGoal.count({ where: { userId, status: 'active' } });
  if (active >= MAX_ACTIVE_GOALS) throw goalLimitReached(MAX_ACTIVE_GOALS);
}
