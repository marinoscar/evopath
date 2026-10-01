import { Injectable } from '@nestjs/common';
import type { ActivityGoal } from '@prisma/client';

import { CheckInsService } from '../check-ins/check-ins.service';
import { addDays, fromDbDate, toDbDate } from '../check-ins/local-date';
import { PrismaService } from '../prisma/prisma.service';
import { ACTIVITY_REASONS, GOAL_LOOKBACK_DAYS, PROGRESS_DATE_FUTURE_DAYS } from './activity.constants';
import { activityRefusal, goalNotFound, toGoalView, toProgressEntryView, toProgressGoal, type ProgressEntryView } from './activity-mapper';
import type { GoalHistoryPeriodData, GoalProgressViewData, GoalViewData } from './dto/goal.dto';
import { evaluateGoal, goalHistory, periodOf, type GoalEvaluation } from './goal-progress';
import { WorkoutActivitySyncService } from './workout-activity-sync.service';

// =============================================================================
// GoalProgressService — loads rows and applies the pure rules (#268)
// =============================================================================
//
// The rules (matching, precedence integration > workout > manual, counting,
// on-track, streak) live in `goal-progress.ts`. This service resolves the
// user's local day, reconciles recent workout-derived entries
// (`WorkoutActivitySyncService.reconcileRecent`), reads the goals and ONE
// range of entries, and evaluates.
//
// PROGRAMMATIC API (the AI Coach calls these; no HTTP):
//   progressForUser(userId, date?)        every ACTIVE goal's progress
//   evaluateGoal(userId, goalId, date?)   one goal (any status)
//   historyForGoal(userId, goalId, limit, date?)
// `date` is a local `YYYY-MM-DD`, default today in the Health Profile time
// zone. Each result carries `elapsedFraction` on top of the HTTP shape.
// =============================================================================

export type GoalProgressData = GoalProgressViewData & { elapsedFraction: number };

@Injectable()
export class GoalProgressService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly checkIns: CheckInsService,
    private readonly sync: WorkoutActivitySyncService,
  ) {}

  /** Progress of every active goal of `userId` in the period holding `date` (default today, local). */
  async progressForUser(userId: string, date?: string, now: Date = new Date()): Promise<GoalProgressData[]> {
    const day = await this.resolveDate(userId, date, now);
    const goals = await this.prisma.activityGoal.findMany({
      where: { userId, status: 'active' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (goals.length === 0) return [];
    return this.evaluate(userId, goals, day);
  }

  /** Progress of one goal (any status) in the period holding `date`. */
  async evaluateGoal(userId: string, goalId: string, date?: string, now: Date = new Date()): Promise<GoalProgressData> {
    const day = await this.resolveDate(userId, date, now);
    const goal = await this.findOwned(userId, goalId);
    const [result] = await this.evaluate(userId, [goal], day);
    return result;
  }

  /** Up to `limit` periods of one goal, newest first, the current one included. */
  async historyForGoal(
    userId: string,
    goalId: string,
    limit: number,
    date?: string,
    now: Date = new Date(),
  ): Promise<GoalHistoryPeriodData[]> {
    const day = await this.resolveDate(userId, date, now);
    const goal = await this.findOwned(userId, goalId);
    const { entries, dataFrom } = await this.loadEntries(userId, [goal], day);
    return goalHistory(toProgressGoal(goal), entries, day, limit, { dataFrom }).map((period) => ({
      periodStart: period.start,
      periodEnd: period.end,
      done: period.done,
      target: period.target,
      hit: period.hit,
    }));
  }

  private async evaluate(userId: string, goals: ActivityGoal[], day: string): Promise<GoalProgressData[]> {
    const { entries, dataFrom } = await this.loadEntries(userId, goals, day);
    return goals.map((goal) => toProgressData(toGoalView(goal), evaluateGoal(toProgressGoal(goal), entries, day, { dataFrom })));
  }

  /** Reconciles recent derived rows, then reads every entry the goals' current and past periods can need. */
  private async loadEntries(
    userId: string,
    goals: ActivityGoal[],
    day: string,
  ): Promise<{ entries: ProgressEntryView[]; dataFrom: string }> {
    await this.sync.reconcileRecent(userId, await this.checkIns.today(userId));

    const earliestStart = goals.map((goal) => fromDbDate(goal.startsOn)).sort()[0];
    const lookback = addDays(day, -GOAL_LOOKBACK_DAYS);
    const dataFrom = earliestStart > lookback ? earliestStart : lookback;
    const to = goals.map((goal) => periodOf(goal.period, day).end).sort().reverse()[0];

    const rows = await this.prisma.activityEntry.findMany({
      where: { userId, occurredOn: { gte: toDbDate(dataFrom), lte: toDbDate(to) } },
      orderBy: [{ occurredOn: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    return { entries: rows.map(toProgressEntryView), dataFrom: lookback };
  }

  private async findOwned(userId: string, goalId: string): Promise<ActivityGoal> {
    const goal = await this.prisma.activityGoal.findFirst({ where: { id: goalId, userId } });
    if (!goal) throw goalNotFound();
    return goal;
  }

  private async resolveDate(userId: string, date: string | undefined, now: Date): Promise<string> {
    const today = await this.checkIns.today(userId, now);
    if (date === undefined) return today;
    if (date > addDays(today, PROGRESS_DATE_FUTURE_DAYS) || date < addDays(today, -GOAL_LOOKBACK_DAYS)) {
      throw activityRefusal(400, ACTIVITY_REASONS.DATE_OUT_OF_RANGE, `date must be within ${GOAL_LOOKBACK_DAYS} days before today (${today})`, {
        path: 'date',
        today,
      });
    }
    return date;
  }
}

function toProgressData(goal: GoalViewData, evaluation: GoalEvaluation<ProgressEntryView>): GoalProgressData {
  return {
    goalId: evaluation.goalId,
    goal,
    periodStart: evaluation.periodStart,
    periodEnd: evaluation.periodEnd,
    done: evaluation.done,
    target: evaluation.target,
    remaining: evaluation.remaining,
    daysLeft: evaluation.daysLeft,
    onTrack: evaluation.onTrack,
    hit: evaluation.hit,
    streakPeriods: evaluation.streakPeriods,
    elapsedFraction: evaluation.elapsedFraction,
    entries: evaluation.entries,
  };
}

/** The HTTP shape: the programmatic result without `elapsedFraction`. */
export function toProgressView({ elapsedFraction: _elapsed, ...view }: GoalProgressData): GoalProgressViewData {
  return view;
}
